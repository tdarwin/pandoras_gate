import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join, normalize, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { LLMProvider } from '../../shared/llm/types'
import {
  ModelProposalOutput,
  PendingProposal,
  PROPOSAL_JSON_SCHEMA,
  type PendingProposalItem
} from '../../shared/schemas/proposal'
import { parseFrontmatter } from '../../shared/frontmatter'
import { readNovelManifest, readChapter, listMetadata } from '../project/service'
import { commitAll } from '../git/service'
import { matchCharacters } from '../context/assembler'

/**
 * The metadata pipeline: on chapter save, ask the model for full-document
 * rewrites of affected story-bible docs, queue them as pending proposals, and
 * apply/reject each only on the author's say-so.
 */

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ */
/* Pipeline state (.pandora/state.json)                                */
/* ------------------------------------------------------------------ */

interface PipelineState {
  chapters: Record<string, { lastProcessedHash: string }>
  /** sha256(path + newContent) of proposals the author rejected. */
  rejectedProposals?: string[]
}

const MAX_REJECTED_REMEMBERED = 200

async function readState(novelDir: string): Promise<PipelineState> {
  try {
    const raw = await readFile(join(novelDir, '.pandora', 'state.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PipelineState>
    return { ...parsed, chapters: parsed.chapters ?? {} }
  } catch {
    return { chapters: {} }
  }
}

async function writeState(novelDir: string, state: PipelineState): Promise<void> {
  await mkdir(join(novelDir, '.pandora'), { recursive: true })
  await writeFile(join(novelDir, '.pandora', 'state.json'), JSON.stringify(state, null, 2), 'utf8')
}

/* ------------------------------------------------------------------ */
/* Proposal storage (.pandora/proposals/)                              */
/* ------------------------------------------------------------------ */

function proposalsDir(novelDir: string): string {
  return join(novelDir, '.pandora', 'proposals')
}

export async function listProposals(novelDir: string): Promise<PendingProposal[]> {
  try {
    const files = (await readdir(proposalsDir(novelDir))).filter((f) => f.endsWith('.json'))
    const out: PendingProposal[] = []
    for (const f of files) {
      try {
        const raw = await readFile(join(proposalsDir(novelDir), f), 'utf8')
        out.push(PendingProposal.parse(JSON.parse(raw)))
      } catch {
        // Corrupt proposal file: skip it rather than blocking the queue.
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

async function writeProposal(novelDir: string, proposal: PendingProposal): Promise<void> {
  await mkdir(proposalsDir(novelDir), { recursive: true })
  await writeFile(
    join(proposalsDir(novelDir), `${proposal.id}.json`),
    JSON.stringify(proposal, null, 2),
    'utf8'
  )
}

async function deleteProposal(novelDir: string, id: string): Promise<void> {
  await rm(join(proposalsDir(novelDir), `${id}.json`), { force: true })
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/** Model output may only touch story-bible files. */
export function isAllowedProposalPath(path: string): boolean {
  const n = normalize(path).replaceAll('\\', '/')
  if (n.includes('..') || n.startsWith('/')) return false
  return (
    (n.startsWith('metadata/') && (n.endsWith('.md') || n === 'metadata/timeline.yaml')) &&
    n.split('/').length <= 3
  )
}

/** Content sanity per file type — never apply unparseable docs. */
export function validateProposalContent(path: string, content: string): string | null {
  if (path.endsWith('.yaml')) {
    try {
      parseYaml(content)
      return null
    } catch (err) {
      return `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  // Markdown always parses; require non-empty.
  if (!content.trim()) return 'Empty document'
  return null
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `You are the story-bible maintainer for a novel-writing studio. After the author saves a chapter, you update the novel's metadata so both the author and future AI assistance stay oriented.

You receive the current chapter, existing story-bible documents, and file conventions. Respond with COMPLETE new file contents for every document that needs creating or updating — never partial edits, never placeholders like "(unchanged)". Only include documents that genuinely need changes based on this chapter. Keep each document concise and factual; do not invent events that did not happen.

File conventions (all paths relative to the novel folder):
- metadata/summaries/<chapter-file-name>.md — REQUIRED every run: a summary of THIS chapter. Frontmatter: title, logline (one sentence). Body: 3-8 sentence summary.
- metadata/characters/<slug>.md — one per character. Frontmatter: name, aliases (list), role, status, first_appearance, attributes (map — stats, level, realm for LitRPG), relationships (list of {character, type}). Body: ## Appearance / ## Personality / ## Arc notes prose.
- metadata/world/<slug>.md — one per system/faction/place. Frontmatter: system (free-form map for structured rules: tiers, breakthrough requirements, stats per level). Body: prose explanation.
- metadata/synopsis.md — whole-novel synopsis. Frontmatter: logline, themes (list), status. Body: running synopsis including this chapter's events.
- metadata/glossary.md — frontmatter: entries (list of {term, definition}). Body: optional notes.
- metadata/timeline.yaml — YAML list of {id, when (in-world time label), chapter (chapter file path), summary, characters (list of slugs)}. Append this chapter's key events; keep existing entries.

Respond ONLY with the JSON object.`

interface RunContext {
  novelDir: string
  chapterFile: string
  provider: LLMProvider
  modelId: string
}

async function buildUserPrompt(novelDir: string, chapterFile: string): Promise<string> {
  const manifest = await readNovelManifest(novelDir)
  const entry = manifest.chapters.find((c) => c.file === chapterFile)
  const chapterRaw = await readChapter(novelDir, chapterFile)
  const chapterBody = parseFrontmatter(chapterRaw).body

  const listing = await listMetadata(novelDir)
  const parts: string[] = []

  parts.push(`# Novel: ${manifest.title}`)
  parts.push(`# Chapter just saved: ${entry?.title ?? chapterFile} (file: ${chapterFile})`)
  parts.push(`Summary file for this chapter must be: metadata/summaries/${basename(chapterFile)}`)
  parts.push(`\n## Chapter text\n\n${chapterBody}`)

  const synopsis = await safeRead(join(novelDir, 'metadata/synopsis.md'))
  if (synopsis) parts.push(`\n## Current metadata/synopsis.md\n\n\`\`\`\n${synopsis}\n\`\`\``)

  const glossary = await safeRead(join(novelDir, 'metadata/glossary.md'))
  if (glossary) parts.push(`\n## Current metadata/glossary.md\n\n\`\`\`\n${glossary}\n\`\`\``)

  const timeline = await safeRead(join(novelDir, 'metadata/timeline.yaml'))
  if (timeline) parts.push(`\n## Current metadata/timeline.yaml\n\n\`\`\`\n${timeline}\n\`\`\``)

  const existingSummary = await safeRead(join(novelDir, 'metadata/summaries', basename(chapterFile)))
  if (existingSummary) {
    parts.push(
      `\n## Current metadata/summaries/${basename(chapterFile)} (previous version of this chapter's summary)\n\n\`\`\`\n${existingSummary}\n\`\`\``
    )
  }

  // Character docs whose names/aliases appear in the chapter — plus the full
  // roster of known files so the model reuses slugs instead of duplicating.
  const characterSources: { name: string; aliases: string[]; facts: string; body: string }[] = []
  for (const c of listing.characters) {
    const raw = await safeRead(join(novelDir, c.file))
    if (!raw) continue
    const { data, body } = parseFrontmatter(raw)
    characterSources.push({
      name: typeof data['name'] === 'string' ? data['name'] : c.name,
      aliases: Array.isArray(data['aliases']) ? data['aliases'].map(String) : [],
      facts: raw,
      body
    })
  }
  const mentioned = matchCharacters(
    characterSources.map((c) => ({ ...c, facts: c.facts })),
    [chapterBody]
  )
  for (const m of mentioned) {
    const listed = listing.characters.find((c) => c.name === m.name)
    if (listed) {
      parts.push(`\n## Current ${listed.file}\n\n\`\`\`\n${m.facts}\n\`\`\``)
    }
  }
  if (listing.characters.length > 0) {
    parts.push(
      `\n## All existing character files\n${listing.characters.map((c) => `- ${c.file} (${c.name})`).join('\n')}`
    )
  }

  for (const w of listing.world) {
    const raw = await safeRead(join(novelDir, w.file))
    if (raw) parts.push(`\n## Current ${w.file}\n\n\`\`\`\n${raw}\n\`\`\``)
  }

  parts.push(
    '\nNow produce the JSON of proposals. Include the chapter summary; update the synopsis, timeline, characters, world docs, and glossary only where this chapter changes them. Create new character/world docs for significant new entities.'
  )
  return parts.join('\n')
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface RunResult {
  status: 'ran' | 'skipped-unchanged' | 'no-changes'
  proposalId?: string
  itemCount?: number
}

export async function runMetadataUpdate(ctx: RunContext): Promise<RunResult> {
  const { novelDir, chapterFile } = ctx
  const chapterRaw = await readChapter(novelDir, chapterFile)
  const chapterHash = sha256(chapterRaw)

  const state = await readState(novelDir)
  if (state.chapters[chapterFile]?.lastProcessedHash === chapterHash) {
    return { status: 'skipped-unchanged' }
  }

  const manifest = await readNovelManifest(novelDir)
  const chapterTitle = manifest.chapters.find((c) => c.file === chapterFile)?.title ?? chapterFile

  const userPrompt = await buildUserPrompt(novelDir, chapterFile)

  // Collect the full response (schema-constrained where supported).
  let raw = ''
  const controller = new AbortController()
  for await (const event of ctx.provider.chatStream(
    {
      modelId: ctx.modelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      responseFormat: { name: 'metadata_proposals', schema: PROPOSAL_JSON_SCHEMA }
    },
    controller.signal
  )) {
    if (event.type === 'delta') raw += event.text
    if (event.type === 'error') throw new Error(event.message)
  }

  // Parse; tolerate accidental markdown fences.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let output: ModelProposalOutput
  try {
    output = ModelProposalOutput.parse(JSON.parse(cleaned))
  } catch (err) {
    throw new Error(
      `The model's metadata response was not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : 'parse error'})`
    )
  }

  // Filter: unsafe paths, invalid content, no-ops, previously rejected.
  const rejected = new Set(state.rejectedProposals ?? [])
  const items: PendingProposalItem[] = []
  for (const p of output.proposals) {
    if (!isAllowedProposalPath(p.path)) continue
    if (validateProposalContent(p.path, p.newContent) !== null) continue
    if (rejected.has(sha256(p.path + p.newContent))) continue
    const current = await safeRead(join(novelDir, p.path))
    if (current !== null && current === p.newContent) continue
    items.push({
      path: p.path,
      action: current === null ? 'create' : 'update',
      newContent: p.newContent,
      rationale: p.rationale,
      baseHash: current === null ? '' : sha256(current)
    })
  }

  // Mark processed regardless of outcome — "no useful changes" shouldn't nag.
  state.chapters[chapterFile] = { lastProcessedHash: chapterHash }
  await writeState(novelDir, state)

  if (items.length === 0) return { status: 'no-changes' }

  const proposal: PendingProposal = {
    id: randomUUID(),
    chapterFile,
    chapterTitle,
    createdAt: Date.now(),
    items
  }
  await writeProposal(novelDir, proposal)
  return { status: 'ran', proposalId: proposal.id, itemCount: items.length }
}

/* ------------------------------------------------------------------ */
/* Review resolutions                                                  */
/* ------------------------------------------------------------------ */

export interface ResolveRequest {
  novelDir: string
  proposalId: string
  path: string
  resolution: 'accept' | 'reject'
  /** When the author edited the proposed content before accepting. */
  editedContent?: string
}

export async function resolveProposalItem(req: ResolveRequest): Promise<{ remaining: number }> {
  const proposals = await listProposals(req.novelDir)
  const proposal = proposals.find((p) => p.id === req.proposalId)
  if (!proposal) throw new Error('Proposal no longer exists')
  const item = proposal.items.find((i) => i.path === req.path)
  if (!item) throw new Error('Proposal item no longer exists')

  if (req.resolution === 'accept') {
    const content = req.editedContent ?? item.newContent
    const problem = validateProposalContent(item.path, content)
    if (problem) throw new Error(problem)
    const full = join(req.novelDir, item.path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
    await commitAll(
      req.novelDir,
      `metadata: ${basename(item.path).replace(/\.(md|yaml)$/, '')} (${proposal.chapterTitle})`,
      [item.path]
    )
  } else {
    const state = await readState(req.novelDir)
    const rejected = state.rejectedProposals ?? []
    rejected.push(sha256(item.path + item.newContent))
    state.rejectedProposals = rejected.slice(-MAX_REJECTED_REMEMBERED)
    await writeState(req.novelDir, state)
  }

  proposal.items = proposal.items.filter((i) => i.path !== req.path)
  if (proposal.items.length === 0) {
    await deleteProposal(req.novelDir, proposal.id)
  } else {
    await writeProposal(req.novelDir, proposal)
  }
  return { remaining: proposal.items.length }
}

/** Review payload: items enriched with current content + conflict flags. */
export async function proposalsForReview(novelDir: string): Promise<
  (Omit<PendingProposal, 'items'> & {
    items: (PendingProposalItem & { currentContent: string; conflict: boolean })[]
  })[]
> {
  const proposals = await listProposals(novelDir)
  const out = []
  for (const p of proposals) {
    const items = []
    for (const item of p.items) {
      const current = (await safeRead(join(novelDir, item.path))) ?? ''
      const conflict = item.baseHash !== '' && sha256(current) !== item.baseHash
      items.push({ ...item, currentContent: current, conflict })
    }
    out.push({ ...p, items })
  }
  return out
}
