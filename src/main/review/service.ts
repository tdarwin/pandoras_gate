import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { LLMProvider } from '../../shared/llm/types'
import { parseFrontmatter, serializeFrontmatter } from '../../shared/frontmatter'
import { readNovelManifest, readChapter, listMetadata } from '../project/service'
import { enqueueProposalItems, type RunResult } from '../metadata/pipeline'
import { estimateTokens, elideMiddle, truncateToTokens } from '../context/assembler'
import { logInfo } from '../log'
import { withSpan } from '../telemetry'
import { tracedChatStream } from '../llm/genai-otel'

/**
 * Editing reviews: the author asks for a specific kind of editorial pass over
 * one chapter or the whole novel.
 *
 * - proofread / copy-edit produce LINE EDITS: the model rewrites each chapter
 *   body, and the differences land in the proposal queue for tracked-changes
 *   review. Chapters are never elided for these — a model that can't fit the
 *   whole chapter is skipped rather than allowed to truncate prose.
 * - developmental / fact-check produce REPORTS: a markdown document queued as
 *   a proposal that, once accepted, lives in metadata/reviews/ and is
 *   browsable from the Codex.
 */

export type ReviewType = 'proofread' | 'copy-edit' | 'developmental' | 'fact-check'

export interface ReviewRequest {
  novelDir: string
  scope: 'chapter' | 'novel'
  /** Required when scope is 'chapter'. */
  chapterFile?: string
  reviewType: ReviewType
  /** The author's direction, e.g. "watch for tense slips". */
  guidance?: string
  provider: LLMProvider
  modelId: string
  conversationId?: string
  onStatus?: (text: string) => void
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

const LINE_EDIT_SYSTEMS: Record<'proofread' | 'copy-edit', string> = {
  proofread: `You are a meticulous proofreader for a novelist. Correct only mechanical errors: spelling, punctuation, capitalization, doubled words, malformed dialogue punctuation, and unambiguous grammatical mistakes.

Do NOT rephrase sentences, change word choices, alter rhythm, or "improve" style — the author's voice is untouchable. Deliberate stylistic choices (sentence fragments, comma splices in narration or dialogue, invented words, dialect) stay exactly as written unless clearly accidental. When canon spellings are provided, enforce them.

Output the COMPLETE corrected chapter body in markdown — every paragraph, including ones you did not change. No commentary, no explanations, no YAML frontmatter, no chapter-title heading. If nothing needs correcting, output the chapter exactly as given.`,

  'copy-edit': `You are a copy editor for a novelist. Make line-level edits for correctness and clarity: fix grammar, punctuation, and spelling; smooth genuinely awkward or tangled sentences; trim accidental word repetition; fix small in-chapter continuity slips (a character sitting who was just standing); keep names, terminology, hyphenation, and capitalization consistent. When canon spellings are provided, enforce them.

Preserve the author's voice, tense, point of view, and pacing. Do not restructure scenes, add new content, or condense. When a sentence works, leave it alone — a light hand is the mark of a good copy editor.

Output the COMPLETE edited chapter body in markdown — every paragraph, including ones you did not change. No commentary, no explanations, no YAML frontmatter, no chapter-title heading. If nothing needs changing, output the chapter exactly as given.`
}

const REPORT_SYSTEMS: Record<'developmental' | 'fact-check', string> = {
  developmental: `You are a developmental editor for a novelist. You assess story craft — structure, pacing, character arcs, stakes, point-of-view discipline, scene purpose, and emotional progression — and give actionable, prioritized feedback. Be candid and specific: name what works, name what doesn't, and say why it matters to the reader.

Write your assessment as a markdown report with exactly these sections:
## Overview
## What's working
## Structure & pacing
## Character & point of view
## Stakes & tension
## Recommendations
The Recommendations section is a numbered list in priority order; each item names the problem, why it matters, and one concrete suggestion.

Ground every observation in the material provided (quote short phrases where useful). Do not rewrite the author's prose for them. Output ONLY the report body in markdown — no YAML frontmatter, no preamble, no sign-off.`,

  'fact-check': `You are the continuity editor for a novel. Check the given text against the story's own canon — the Codex documents (characters, world rules, timeline, summaries, glossary) — and against itself. This is fiction: "facts" means the story's established canon, not the real world. Flag real-world impossibilities only when clearly unintended (a revolver firing twelve shots).

Report every contradiction or inconsistency you can support with evidence: character details (names, appearance, relationships, abilities, injuries, status), world and system rules (magic or leveling mechanics, costs, limits), timeline order, geography and travel, object continuity, and internal contradictions within the text itself.

Write a markdown report with exactly these sections:
## Summary
## Findings
## Uncertain
Findings is a numbered list ordered by severity; each item gives the quote or location, what it conflicts with (name the Codex document or earlier passage), and a suggested resolution. Uncertain lists possible issues you could not verify from the material provided. If you find no issues, say so plainly in Summary and leave Findings empty.

Output ONLY the report body in markdown — no YAML frontmatter, no preamble, no sign-off.`
}

const REVIEW_LABELS: Record<ReviewType, string> = {
  proofread: 'Proofread',
  'copy-edit': 'Copy edit',
  developmental: 'Developmental review',
  'fact-check': 'Fact check'
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const FALLBACK_WINDOW = 16_384
/** Room reserved for a report; line edits size output per chapter instead. */
const REPORT_RESERVED_OUTPUT = 4096
/** Cap for any single codex doc quoted into a report prompt. */
const DOC_CAP = 1400

async function modelWindow(provider: LLMProvider, modelId: string): Promise<number> {
  const window = await provider
    .listModels()
    .then((models) => models.find((m) => m.id === modelId)?.contextLength)
    .catch(() => undefined)
  return window ?? FALLBACK_WINDOW
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** One streamed completion collected into a string. */
async function generate(
  req: ReviewRequest,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  let text = ''
  const controller = new AbortController()
  for await (const event of tracedChatStream(
    req.provider,
    {
      modelId: req.modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      maxTokens
    },
    controller.signal,
    { conversationId: req.conversationId ?? randomUUID(), providerId: req.provider.id }
  )) {
    if (event.type === 'delta') text += event.text
    if (event.type === 'error') throw new Error(event.message)
  }
  return text.trim()
}

/**
 * Compact canon reference for line edits: character names/aliases and
 * glossary terms, so small models keep spellings straight without paying
 * for whole Codex docs.
 */
async function canonSpellings(novelDir: string, count: (t: string) => number): Promise<string> {
  const listing = await listMetadata(novelDir)
  const lines: string[] = []
  for (const c of listing.characters) {
    const raw = await safeRead(join(novelDir, c.file))
    if (!raw) continue
    const { data } = parseFrontmatter(raw)
    const aliases = Array.isArray(data['aliases']) ? data['aliases'].map(String) : []
    lines.push(`- ${c.name}${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`)
  }
  const glossary = await safeRead(join(novelDir, 'metadata/glossary.md'))
  if (glossary) {
    const { data } = parseFrontmatter(glossary)
    if (Array.isArray(data['entries'])) {
      for (const e of data['entries'] as { term?: unknown }[]) {
        if (typeof e?.term === 'string') lines.push(`- ${e.term}`)
      }
    }
  }
  if (lines.length === 0) return ''
  const block = `\n## Canon spellings (enforce these)\n${lines.join('\n')}`
  return count(block) <= 600 ? block : truncateToTokens(block, 600, count)
}

/* ------------------------------------------------------------------ */
/* Line-edit reviews (proofread / copy-edit)                           */
/* ------------------------------------------------------------------ */

async function runLineEditReview(req: ReviewRequest): Promise<RunResult> {
  const count = estimateTokens
  const type = req.reviewType as 'proofread' | 'copy-edit'
  const system = LINE_EDIT_SYSTEMS[type]
  const label = REVIEW_LABELS[type]
  const manifest = await readNovelManifest(req.novelDir)
  const window = await modelWindow(req.provider, req.modelId)

  const targets =
    req.scope === 'chapter'
      ? manifest.chapters.filter((c) => c.file === req.chapterFile)
      : manifest.chapters
  if (targets.length === 0) throw new Error('No chapters to review')

  const canon = await canonSpellings(req.novelDir, count)
  const guidance = req.guidance?.trim()
    ? `\n## Author's notes for this pass\n\n${req.guidance.trim()}`
    : ''

  const proposals: { path: string; newContent: string; rationale: string; base: string }[] = []
  const skipped: string[] = []

  for (const [i, entry] of targets.entries()) {
    req.onStatus?.(
      targets.length > 1
        ? `${label}: “${entry.title}” (${i + 1}/${targets.length})…`
        : `${label}: “${entry.title}”…`
    )
    const raw = await readChapter(req.novelDir, entry.file)
    const body = parseFrontmatter(raw).body
    const frontmatterPrefix = raw.slice(0, raw.length - body.length)
    if (!body.trim()) continue

    const user = `# Chapter: ${entry.title}${canon}${guidance}\n\n## Chapter text\n\n${body.trim()}\n\nNow output the complete ${type === 'proofread' ? 'corrected' : 'edited'} chapter body.`
    // The whole chapter must fit going in AND coming back out — never elide
    // prose that the model will be asked to reproduce.
    const needed = Math.ceil(count(body) * 1.25) + 256
    if (count(system) + count(user) + needed > window) {
      skipped.push(entry.title)
      continue
    }

    const revised = await generate(req, system, user, needed, 0.2)
    if (!revised) {
      skipped.push(entry.title)
      continue
    }
    // A drastically shorter "revision" means the model truncated or summarized
    // — never offer that as an edit.
    if (revised.length < body.trim().length * 0.6) {
      skipped.push(entry.title)
      continue
    }
    proposals.push({
      path: entry.file,
      newContent: `${frontmatterPrefix}${revised}\n`,
      rationale: req.guidance?.trim()
        ? `${label} — ${req.guidance.trim().slice(0, 160)}`
        : `${label} of “${entry.title}”`,
      // The chapter as read at THIS chapter's turn in the pass — for a
      // novel-wide review, later chapters' generations happen after this.
      base: raw
    })
  }

  if (skipped.length > 0) {
    req.onStatus?.(`Skipped (too long for this model or empty): ${skipped.join(', ')}`)
    logInfo('review', `${type}: skipped ${skipped.length} chapter(s)`, skipped)
  }

  const targetFiles = new Set(targets.map((t) => t.file))
  const sourceTitle =
    req.scope === 'chapter'
      ? `${label}: ${targets[0]!.title}`
      : `${label}: ${manifest.title}`
  const { queued } = await enqueueProposalItems(req.novelDir, sourceTitle, proposals, (p) =>
    targetFiles.has(p)
  )
  if (queued === 0) return { status: 'no-changes' }
  return { status: 'ran', itemCount: queued }
}

/* ------------------------------------------------------------------ */
/* Report reviews (developmental / fact-check)                         */
/* ------------------------------------------------------------------ */

/** Builds the material block for a report review within a token budget. */
async function buildReportMaterial(req: ReviewRequest, budgetTokens: number): Promise<string> {
  const count = estimateTokens
  const { novelDir } = req
  const manifest = await readNovelManifest(novelDir)
  const listing = await listMetadata(novelDir)
  const parts: string[] = []
  let used = 0
  const room = (): number => Math.max(0, budgetTokens - used)
  const push = (text: string): void => {
    parts.push(text)
    used += count(text)
  }
  const pushCapped = (text: string, cap = DOC_CAP): void => {
    const allowed = Math.min(cap, room())
    if (allowed < 120) return
    push(count(text) <= allowed ? text : truncateToTokens(text, allowed, count))
  }

  if (req.scope === 'chapter') {
    const entry = manifest.chapters.find((c) => c.file === req.chapterFile)
    if (!entry) throw new Error(`Chapter not in manifest: ${req.chapterFile}`)
    push(`# Novel: ${manifest.title}`)
    push(`# Under review: chapter “${entry.title}” (${entry.file})`)

    // The chapter itself claims the biggest share.
    const chapterBody = parseFrontmatter(await readChapter(novelDir, entry.file)).body
    const chapterCap = Math.floor(budgetTokens * 0.55)
    const text =
      count(chapterBody) > chapterCap ? elideMiddle(chapterBody, chapterCap, count) : chapterBody
    push(`\n## Chapter text\n\n${text}`)

    const synopsis = await safeRead(join(novelDir, 'metadata/synopsis.md'))
    if (synopsis) pushCapped(`\n## Synopsis (story so far)\n\n\`\`\`\n${synopsis}\n\`\`\``)

    if (req.reviewType === 'developmental') {
      const chapterOutline = await safeRead(join(novelDir, 'outlines', basename(entry.file)))
      if (chapterOutline)
        pushCapped(`\n## This chapter's outline\n\n\`\`\`\n${chapterOutline}\n\`\`\``)
      const novelOutline = await safeRead(join(novelDir, 'outlines/novel.md'))
      if (novelOutline) pushCapped(`\n## Novel outline\n\n\`\`\`\n${novelOutline}\n\`\`\``)
      // Recent summaries orient pacing feedback without full chapters.
      const idx = manifest.chapters.findIndex((c) => c.file === entry.file)
      for (const prev of manifest.chapters.slice(Math.max(0, idx - 3), idx)) {
        const s = await safeRead(join(novelDir, 'metadata/summaries', basename(prev.file)))
        if (s) pushCapped(`\n## Summary: ${prev.title}\n\n\`\`\`\n${s}\n\`\`\``, 700)
      }
    } else {
      // Fact-check: the canon. Characters and world docs matter most.
      for (const c of listing.characters) {
        const raw = await safeRead(join(novelDir, c.file))
        if (raw) pushCapped(`\n## Codex — ${c.file}\n\n\`\`\`\n${raw}\n\`\`\``, 1000)
      }
      for (const w of listing.world) {
        const raw = await safeRead(join(novelDir, w.file))
        if (raw) pushCapped(`\n## Codex — ${w.file}\n\n\`\`\`\n${raw}\n\`\`\``, 1000)
      }
      const timeline = await safeRead(join(novelDir, 'metadata/timeline.yaml'))
      if (timeline) pushCapped(`\n## Codex — timeline.yaml\n\n\`\`\`\n${timeline}\n\`\`\``)
      const glossary = await safeRead(join(novelDir, 'metadata/glossary.md'))
      if (glossary) pushCapped(`\n## Codex — glossary.md\n\n\`\`\`\n${glossary}\n\`\`\``)
    }
    return parts.join('\n')
  }

  // Novel scope: reviewed from summaries, outline, and Codex — say so.
  push(`# Novel: ${manifest.title}`)
  push(
    `# Under review: the whole novel (${manifest.chapters.length} chapters). Full chapter text is NOT included — you are working from the synopsis, outline, chapter summaries, and Codex. Confine claims to what this material supports.`
  )
  push(
    `\n## Chapters\n${manifest.chapters.map((c, i) => `${i + 1}. ${c.title} (${c.status})`).join('\n')}`
  )

  const synopsis = await safeRead(join(novelDir, 'metadata/synopsis.md'))
  if (synopsis) pushCapped(`\n## Synopsis\n\n\`\`\`\n${synopsis}\n\`\`\``, 1800)
  const novelOutline = await safeRead(join(novelDir, 'outlines/novel.md'))
  if (novelOutline) pushCapped(`\n## Novel outline\n\n\`\`\`\n${novelOutline}\n\`\`\``, 1800)

  for (const s of listing.summaries) {
    const raw = await safeRead(join(novelDir, s.file))
    if (raw) pushCapped(`\n## Summary: ${s.title}\n\n\`\`\`\n${raw}\n\`\`\``, 700)
  }
  const timeline = await safeRead(join(novelDir, 'metadata/timeline.yaml'))
  if (timeline) pushCapped(`\n## Codex — timeline.yaml\n\n\`\`\`\n${timeline}\n\`\`\``)
  for (const c of listing.characters) {
    const raw = await safeRead(join(novelDir, c.file))
    if (raw) pushCapped(`\n## Codex — ${c.file}\n\n\`\`\`\n${raw}\n\`\`\``, 800)
  }
  for (const w of listing.world) {
    const raw = await safeRead(join(novelDir, w.file))
    if (raw) pushCapped(`\n## Codex — ${w.file}\n\n\`\`\`\n${raw}\n\`\`\``, 800)
  }
  return parts.join('\n')
}

async function runReportReview(req: ReviewRequest): Promise<RunResult> {
  const count = estimateTokens
  const type = req.reviewType as 'developmental' | 'fact-check'
  const system = REPORT_SYSTEMS[type]
  const label = REVIEW_LABELS[type]
  const manifest = await readNovelManifest(req.novelDir)

  const targetTitle =
    req.scope === 'chapter'
      ? (manifest.chapters.find((c) => c.file === req.chapterFile)?.title ?? 'chapter')
      : manifest.title

  req.onStatus?.(`Gathering material for the ${label.toLowerCase()}…`)
  const window = await modelWindow(req.provider, req.modelId)
  const budget = Math.max(2048, window - REPORT_RESERVED_OUTPUT - count(system) - 200)
  const material = await buildReportMaterial(req, budget)
  const guidance = req.guidance?.trim()
    ? `\n## Author's notes for this review\n\n${req.guidance.trim()}`
    : ''
  const user = `${material}${guidance}\n\nNow write the ${label.toLowerCase()} report.`

  req.onStatus?.(`Asking the model for a ${label.toLowerCase()} of “${targetTitle}”…`)
  const report = await generate(req, system, user, REPORT_RESERVED_OUTPUT, 0.3)
  if (!report) throw new Error('The model returned an empty report')

  const date = new Date().toISOString().slice(0, 10)
  const slug =
    req.scope === 'chapter' ? basename(req.chapterFile!, '.md') : 'novel'
  const path = `metadata/reviews/${date}-${req.reviewType}-${slug}.md`
  const content = serializeFrontmatter({
    data: {
      name: `${label} — ${targetTitle} (${date})`,
      review_type: req.reviewType,
      scope: req.scope,
      target: req.scope === 'chapter' ? req.chapterFile! : 'novel',
      model: req.modelId,
      date
    },
    body: `${report}\n`
  })

  const { queued } = await enqueueProposalItems(
    req.novelDir,
    `${label}: ${targetTitle}`,
    [
      {
        path,
        newContent: content,
        rationale: req.guidance?.trim()
          ? `${label} — ${req.guidance.trim().slice(0, 160)}`
          : `${label} of “${targetTitle}” — accept to keep it in the Codex`
      }
    ],
    (p) => p === path
  )
  if (queued === 0) return { status: 'no-changes' }
  return { status: 'ran', itemCount: queued }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function runEditingReview(req: ReviewRequest): Promise<RunResult> {
  if (req.scope === 'chapter' && !req.chapterFile) {
    throw new Error('chapterFile is required for a chapter review')
  }
  return withSpan(
    'invoke_workflow editing-review',
    {
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.request.model': req.modelId,
      ...(req.conversationId ? { 'gen_ai.conversation.id': req.conversationId } : {}),
      'review.type': req.reviewType,
      'review.scope': req.scope
    },
    async (span) => {
      const result =
        req.reviewType === 'proofread' || req.reviewType === 'copy-edit'
          ? await runLineEditReview(req)
          : await runReportReview(req)
      span.setAttribute('review.status', result.status)
      if (result.itemCount !== undefined) span.setAttribute('review.items', result.itemCount)
      logInfo('review', `${req.reviewType} (${req.scope}): ${result.status}`, result.itemCount)
      return result
    }
  )
}
