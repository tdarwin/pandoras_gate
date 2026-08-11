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
import { logInfo } from '../log'
import { withSpan } from '../telemetry'
import { tracedChatStream } from '../llm/genai-otel'

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

/** Model output may only touch story-bible and outline files. */
export function isAllowedProposalPath(path: string): boolean {
  const n = normalize(path).replaceAll('\\', '/')
  if (n.includes('..') || n.startsWith('/')) return false
  if (n.startsWith('metadata/') && (n.endsWith('.md') || n === 'metadata/timeline.yaml')) {
    return n.split('/').length <= 3
  }
  if (n.startsWith('outlines/') && n.endsWith('.md')) {
    return n.split('/').length === 2
  }
  return false
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

const SYSTEM_PROMPT = `You are the Codex maintainer for a novel-writing studio (the Codex is the novel's story bible). After the author saves a chapter, you update the Codex so both the author and future AI assistance stay oriented.

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
  /** Run even if the chapter is unchanged (explicit user/agent request). */
  force?: boolean
  /** gen_ai.conversation.id when triggered from a chat session. */
  conversationId?: string
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
  return withSpan(
    'invoke_workflow codex-update',
    {
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.request.model': ctx.modelId,
      ...(ctx.conversationId ? { 'gen_ai.conversation.id': ctx.conversationId } : {}),
      'codex.chapter': ctx.chapterFile
    },
    async (span) => {
      const result = await runMetadataUpdateInner(ctx)
      span.setAttribute('codex.status', result.status)
      if (result.itemCount !== undefined) span.setAttribute('codex.items', result.itemCount)
      logInfo('codex', `update for ${ctx.chapterFile}: ${result.status}`, result.itemCount)
      return result
    }
  )
}

async function runMetadataUpdateInner(ctx: RunContext): Promise<RunResult> {
  const { novelDir, chapterFile } = ctx
  const chapterRaw = await readChapter(novelDir, chapterFile)
  const chapterHash = sha256(chapterRaw)

  const state = await readState(novelDir)
  if (!ctx.force && state.chapters[chapterFile]?.lastProcessedHash === chapterHash) {
    return { status: 'skipped-unchanged' }
  }

  const manifest = await readNovelManifest(novelDir)
  const chapterTitle = manifest.chapters.find((c) => c.file === chapterFile)?.title ?? chapterFile

  const userPrompt = await buildUserPrompt(novelDir, chapterFile)

  // Collect the full response (schema-constrained where supported).
  let raw = ''
  const controller = new AbortController()
  for await (const event of tracedChatStream(
    ctx.provider,
    {
      modelId: ctx.modelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      responseFormat: { name: 'metadata_proposals', schema: PROPOSAL_JSON_SCHEMA }
    },
    controller.signal,
    { conversationId: ctx.conversationId ?? randomUUID(), providerId: ctx.provider.id }
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
/* Direct proposal enqueue (chat agent's write_codex_doc)              */
/* ------------------------------------------------------------------ */

/**
 * Queues author-visible proposals from content produced directly by the chat
 * agent (no pipeline run). Same guards as pipeline output: path allowlist,
 * content validation, no-op suppression. `pathFilter` overrides the default
 * Codex allowlist for special flows (chapter edits target one exact file).
 */
export async function enqueueProposalItems(
  novelDir: string,
  sourceTitle: string,
  proposals: { path: string; newContent: string; rationale: string }[],
  pathFilter: (path: string) => boolean = isAllowedProposalPath
): Promise<{ queued: number; rejected: string[] }> {
  const items: PendingProposalItem[] = []
  const rejected: string[] = []
  for (const p of proposals) {
    if (!pathFilter(p.path)) {
      rejected.push(`${p.path}: not an allowed path`)
      continue
    }
    const problem = validateProposalContent(p.path, p.newContent)
    if (problem) {
      rejected.push(`${p.path}: ${problem}`)
      continue
    }
    const current = await safeRead(join(novelDir, p.path))
    if (current !== null && current === p.newContent) {
      rejected.push(`${p.path}: identical to the current content`)
      continue
    }
    items.push({
      path: p.path,
      action: current === null ? 'create' : 'update',
      newContent: p.newContent,
      rationale: p.rationale,
      baseHash: current === null ? '' : sha256(current)
    })
  }
  if (items.length > 0) {
    await writeProposal(novelDir, {
      id: randomUUID(),
      chapterFile: '',
      chapterTitle: sourceTitle,
      createdAt: Date.now(),
      items
    })
  }
  return { queued: items.length, rejected }
}

/* ------------------------------------------------------------------ */
/* Chapter revision (edit_chapter tool)                                */
/* ------------------------------------------------------------------ */

const CHAPTER_EDIT_SYSTEM = `You are revising one chapter of a novel exactly as the author instructed. You receive the chapter's current text and the author's instructions.

Output the COMPLETE revised chapter body in markdown — every paragraph, including ones you did not change. Preserve the author's voice, tense, and point of view. Make only changes consistent with the instructions; do not embellish elsewhere. Output ONLY the chapter prose: no YAML frontmatter, no chapter-title heading, no commentary, no explanations.`

export interface ChapterEditRequest {
  novelDir: string
  chapterFile: string
  instructions: string
  provider: LLMProvider
  modelId: string
  conversationId?: string
}

/**
 * Generates a revised version of a chapter per the author's instructions and
 * queues it as a reviewable proposal (word-level diff in the review panel).
 * The chapter file itself is untouched until the author accepts.
 */
export async function runChapterEdit(req: ChapterEditRequest): Promise<RunResult> {
  return withSpan(
    'invoke_workflow chapter-edit',
    {
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.request.model': req.modelId,
      ...(req.conversationId ? { 'gen_ai.conversation.id': req.conversationId } : {}),
      'chapter.file': req.chapterFile
    },
    async (span) => {
      const manifest = await readNovelManifest(req.novelDir)
      const entry = manifest.chapters.find((c) => c.file === req.chapterFile)
      if (!entry) throw new Error(`Chapter not in manifest: ${req.chapterFile}`)

      const raw = await readChapter(req.novelDir, req.chapterFile)
      const body = parseFrontmatter(raw).body
      // Everything before the body (the frontmatter block) is preserved verbatim.
      const frontmatterPrefix = raw.slice(0, raw.length - body.length)
      if (!body.trim()) {
        throw new Error('The chapter is empty — use drafting to write new prose instead.')
      }

      let revised = ''
      const controller = new AbortController()
      for await (const event of tracedChatStream(
        req.provider,
        {
          modelId: req.modelId,
          messages: [
            { role: 'system', content: CHAPTER_EDIT_SYSTEM },
            {
              role: 'user',
              content: `# Chapter: ${entry.title}\n\n## Current text\n\n${body.trim()}\n\n## Author's instructions\n\n${req.instructions.trim()}\n\nNow output the complete revised chapter body.`
            }
          ],
          temperature: 0.4
        },
        controller.signal,
        { conversationId: req.conversationId ?? randomUUID(), providerId: req.provider.id }
      )) {
        if (event.type === 'delta') revised += event.text
        if (event.type === 'error') throw new Error(event.message)
      }

      revised = revised.trim()
      if (!revised) throw new Error('The model returned an empty revision')
      const newContent = `${frontmatterPrefix}${revised}\n`

      const { queued, rejected } = await enqueueProposalItems(
        req.novelDir,
        `Chapter edit: ${entry.title}`,
        [
          {
            path: req.chapterFile,
            newContent,
            rationale: req.instructions.trim().slice(0, 200)
          }
        ],
        (p) => p === req.chapterFile
      )
      span.setAttribute('chapter.edit_queued', queued > 0)
      logInfo('chapter-edit', `${req.chapterFile}: queued=${queued}`, rejected)
      if (queued === 0) {
        return { status: 'no-changes' }
      }
      return { status: 'ran', itemCount: 1 }
    }
  )
}

/* ------------------------------------------------------------------ */
/* Outline generation (through the same proposal machinery)            */
/* ------------------------------------------------------------------ */

const OUTLINE_SYSTEM_PROMPT = `You are a story-outlining collaborator in a novel-writing studio. You produce or revise outline documents that the author reviews before anything is saved.

Outline file conventions (all paths relative to the novel folder):
- outlines/novel.md — the whole-novel outline. Frontmatter: scope: novel, status. Body: markdown outline of acts/arcs and a bullet or two per planned chapter.
- outlines/<chapter-file-name> — one chapter's outline (same file name as the chapter, e.g. outlines/003-the-trial.md). Frontmatter: scope: chapter, chapter: <chapters/...>, status. Body: beat-by-beat outline for that chapter (scene goals, conflicts, reveals, emotional turns).

Respect what the author has already written and any existing outline structure; refine rather than replace wholesale unless asked. Respond with COMPLETE new file contents via the JSON schema — never partial edits. Only include the outline document(s) being requested.

Respond ONLY with the JSON object.`

export interface OutlineRequest {
  novelDir: string
  scope: 'novel' | 'chapter'
  /** Required when scope is 'chapter'. */
  chapterFile?: string
  /** The author's direction for this outline, e.g. "three-act, slow-burn rivalry". */
  guidance?: string
  provider: LLMProvider
  modelId: string
  conversationId?: string
}

async function buildOutlinePrompt(req: OutlineRequest): Promise<string> {
  const { novelDir } = req
  const manifest = await readNovelManifest(novelDir)
  const parts: string[] = [`# Novel: ${manifest.title}`]

  if (req.scope === 'chapter') {
    const entry = manifest.chapters.find((c) => c.file === req.chapterFile)
    if (!entry) throw new Error(`Chapter not in manifest: ${req.chapterFile}`)
    parts.push(
      `# Task: outline the chapter "${entry.title}" — target file: outlines/${basename(entry.file)}`
    )
  } else {
    parts.push('# Task: outline the whole novel — target file: outlines/novel.md')
  }

  const synopsis = await safeRead(join(novelDir, 'metadata/synopsis.md'))
  if (synopsis) parts.push(`\n## Current synopsis\n\n\`\`\`\n${synopsis}\n\`\`\``)

  const novelOutline = await safeRead(join(novelDir, 'outlines/novel.md'))
  if (novelOutline) parts.push(`\n## Current outlines/novel.md\n\n\`\`\`\n${novelOutline}\n\`\`\``)

  parts.push(
    `\n## Chapters so far\n${manifest.chapters.map((c, i) => `${i + 1}. ${c.title} (${c.file}, ${c.status})`).join('\n') || '(none yet)'}`
  )

  // Chapter summaries give the model the story-so-far cheaply.
  const listing = await listMetadata(novelDir)
  for (const s of listing.summaries) {
    const raw = await safeRead(join(novelDir, s.file))
    if (raw) parts.push(`\n## Summary: ${s.title}\n\n\`\`\`\n${raw}\n\`\`\``)
  }

  if (req.scope === 'chapter' && req.chapterFile) {
    const existing = await safeRead(join(novelDir, 'outlines', basename(req.chapterFile)))
    if (existing) {
      parts.push(
        `\n## Current outlines/${basename(req.chapterFile)}\n\n\`\`\`\n${existing}\n\`\`\``
      )
    }
    const chapterRaw = await safeRead(join(novelDir, req.chapterFile))
    if (chapterRaw) {
      const body = parseFrontmatter(chapterRaw).body.trim()
      if (body) parts.push(`\n## Chapter text so far\n\n${body}`)
    }
  }

  if (req.guidance?.trim()) {
    parts.push(`\n## Author's direction\n\n${req.guidance.trim()}`)
  }

  parts.push('\nNow produce the JSON with the outline document.')
  return parts.join('\n')
}

export async function runOutlineGeneration(req: OutlineRequest): Promise<RunResult> {
  return withSpan(
    'invoke_workflow outline-generation',
    {
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.request.model': req.modelId,
      ...(req.conversationId ? { 'gen_ai.conversation.id': req.conversationId } : {}),
      'outline.scope': req.scope
    },
    async (span) => {
      const result = await runOutlineGenerationInner(req)
      span.setAttribute('outline.status', result.status)
      logInfo('outline', `${req.scope} outline: ${result.status}`)
      return result
    }
  )
}

async function runOutlineGenerationInner(req: OutlineRequest): Promise<RunResult> {
  const { novelDir } = req
  const manifest = await readNovelManifest(novelDir)
  const chapterTitle =
    req.scope === 'chapter'
      ? (manifest.chapters.find((c) => c.file === req.chapterFile)?.title ?? 'chapter')
      : 'the novel'

  const userPrompt = await buildOutlinePrompt(req)

  let raw = ''
  const controller = new AbortController()
  for await (const event of tracedChatStream(
    req.provider,
    {
      modelId: req.modelId,
      messages: [
        { role: 'system', content: OUTLINE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4,
      responseFormat: { name: 'outline_proposals', schema: PROPOSAL_JSON_SCHEMA }
    },
    controller.signal,
    { conversationId: req.conversationId ?? randomUUID(), providerId: req.provider.id }
  )) {
    if (event.type === 'delta') raw += event.text
    if (event.type === 'error') throw new Error(event.message)
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let output: ModelProposalOutput
  try {
    output = ModelProposalOutput.parse(JSON.parse(cleaned))
  } catch (err) {
    throw new Error(
      `The model's outline response was not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : 'parse error'})`
    )
  }

  const items: PendingProposalItem[] = []
  for (const p of output.proposals) {
    if (!isAllowedProposalPath(p.path) || !p.path.startsWith('outlines/')) continue
    if (validateProposalContent(p.path, p.newContent) !== null) continue
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

  if (items.length === 0) return { status: 'no-changes' }

  const proposal: PendingProposal = {
    id: randomUUID(),
    chapterFile: req.scope === 'chapter' ? req.chapterFile! : 'outlines/novel.md',
    chapterTitle: `Outline for ${chapterTitle}`,
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
    const label = item.path.startsWith('outlines/')
      ? 'outline'
      : item.path.startsWith('chapters/')
        ? 'chapter edit'
        : 'metadata'
    await commitAll(
      req.novelDir,
      `${label}: ${basename(item.path).replace(/\.(md|yaml)$/, '')} (${proposal.chapterTitle})`,
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
