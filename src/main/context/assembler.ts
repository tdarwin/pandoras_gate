import type { ChatMessage } from '../../shared/llm/types'

/**
 * Context assembly: builds the model's message list from story materials
 * within a token budget. Pure — all file contents arrive pre-loaded in
 * StorySource, token counting is injected — so every budget edge is unit
 * testable.
 *
 * Priority ladder (top never cut, bottom degrades first):
 *   1. system prompt (role + rules)          — never cut
 *   2. recent chat turns                     — never below MIN_CHAT_TURNS
 *   3. active chapter                        — middle elided if enormous
 *   4. novel synopsis                        — truncated if needed
 *   5. world/system rules                    — truncated if needed
 *   6. matched character profiles            — degrade to frontmatter-only
 *   7. chapter summaries                     — older ones collapse to loglines
 *   8. glossary + timeline tail              — first to drop
 */

export interface CharacterSource {
  /** Display name, e.g. "Kael Voss". */
  name: string
  aliases: string[]
  /** Raw YAML frontmatter (structured facts). */
  facts: string
  /** Prose body. */
  body: string
}

export interface StorySource {
  novelTitle: string
  author: string
  /** Author's standing instructions from novel.yaml (never cut). */
  customInstructions: string | null
  synopsis: string | null
  /** Body of outlines/novel.md, if present. */
  novelOutline: string | null
  /** Body of the active chapter's outline doc, if present. */
  chapterOutline: string | null
  worldDocs: { name: string; content: string }[]
  characters: CharacterSource[]
  glossary: { term: string; definition: string }[]
  /** In manifest order. `logline` is the one-line degraded form. */
  summaries: { title: string; logline: string; content: string }[]
  /** YAML tail of timeline.yaml (already truncated to recent events). */
  timelineTail: string | null
  activeChapter: { title: string; text: string } | null
  /** 0-based index of the active chapter in the manifest, -1 if none. */
  activeChapterIndex: number
}

export interface AssembleRequest {
  source: StorySource
  chatHistory: ChatMessage[]
  userMessage: string
  /** Total model context in tokens. */
  contextTokens: number
  /** Tokens reserved for the model's reply. */
  reservedOutput: number
  /**
   * 'chat' (default): writing-partner conversation.
   * 'draft': ghost-drafting a chapter — outlines get top billing and the
   * system prompt demands prose-only output.
   */
  task?: 'chat' | 'draft'
}

export type SectionStatus = 'included' | 'degraded' | 'dropped'

export interface ContextReport {
  budgetTokens: number
  usedTokens: number
  sections: { id: string; label: string; status: SectionStatus; tokens: number }[]
}

export interface AssembledContext {
  messages: ChatMessage[]
  report: ContextReport
}

export type TokenCounter = (text: string) => number

/** Default estimator: ~4 chars/token with a 10% safety margin. */
export const estimateTokens: TokenCounter = (text) => Math.ceil((text.length / 4) * 1.1)

const MIN_CHAT_TURNS = 4
/** The active chapter may take at most this share of the whole budget. */
const CHAPTER_BUDGET_SHARE = 0.5

function truncateToTokens(text: string, maxTokens: number, count: TokenCounter): string {
  if (count(text) <= maxTokens) return text
  // Binary search the cut point; cheap since count is O(1)-ish on slices.
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (count(text.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

/** Keeps the head and tail of a chapter, eliding the middle. */
function elideMiddle(text: string, maxTokens: number, count: TokenCounter): string {
  const marker = '\n\n[… middle of chapter elided for space …]\n\n'
  const half = Math.floor((maxTokens - count(marker)) / 2)
  const head = truncateToTokens(text, half, count)
  // Take the tail by reversing the truncation logic.
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (count(text.slice(text.length - mid)) <= half) lo = mid
    else hi = mid - 1
  }
  const tail = text.slice(text.length - lo)
  return head + marker + tail
}

/** Characters mentioned (by name or alias) in the given texts. */
export function matchCharacters(
  characters: CharacterSource[],
  texts: string[]
): CharacterSource[] {
  const haystack = texts.join('\n').toLowerCase()
  return characters.filter((c) =>
    [c.name, ...c.aliases].some((needle) => {
      const n = needle.trim().toLowerCase()
      return n.length > 1 && haystack.includes(n)
    })
  )
}

export function assembleContext(req: AssembleRequest, count: TokenCounter = estimateTokens): AssembledContext {
  const { source } = req
  const budget = Math.max(0, req.contextTokens - req.reservedOutput)
  const sections: ContextReport['sections'] = []
  const record = (id: string, label: string, status: SectionStatus, tokens: number): void => {
    sections.push({ id, label, status, tokens })
  }

  let used = 0
  const fits = (tokens: number): boolean => used + tokens <= budget

  /* 1 — system prompt (never cut) */
  const task = req.task ?? 'chat'
  const custom = source.customInstructions?.trim()
  const customSuffix = custom
    ? `\n\nAuthor's standing instructions for this novel (always follow):\n${custom}`
    : ''
  const basePrompt =
    (task === 'draft'
      ? [
          `You are ghost-drafting prose for the novel "${source.novelTitle}"${source.author ? ` by ${source.author}` : ''}.`,
          'Story materials follow; treat them as canon and follow the outline where one is given.',
          'Write vivid, immersive chapter prose in markdown. Match the voice of any existing text.',
          'Output ONLY the chapter prose — no headings for the chapter title, no commentary, no notes, no frontmatter.'
        ].join(' ')
      : [
          "You are the author's writing assistant inside Pandora's Box, a novel-writing studio.",
          `The author${source.author ? ` (${source.author})` : ''} is working on the novel "${source.novelTitle}".`,
          'You help with brainstorming, prose feedback, continuity, and craft — and you can ACT on the novel itself: revising and drafting chapters, and maintaining the Codex (the story bible of characters, world rules, outlines, and summaries).',
          'Story materials follow; treat them as canon. Be concrete.'
        ].join(' ')) + customSuffix
  used += count(basePrompt)
  record('system', 'System prompt', 'included', count(basePrompt))

  /* 2 — chat history: newest-first retention, keep at least MIN_CHAT_TURNS */
  const historyKept: ChatMessage[] = []
  {
    const turns = [...req.chatHistory].reverse()
    let historyTokens = 0
    for (let i = 0; i < turns.length; i++) {
      const t = count(turns[i]!.content) + 4
      if (i < MIN_CHAT_TURNS || fits(t)) {
        historyKept.unshift(turns[i]!)
        historyTokens += t
        used += t
      } else {
        break
      }
    }
    if (req.chatHistory.length > 0) {
      record(
        'history',
        `Chat history (${historyKept.length}/${req.chatHistory.length} turns)`,
        historyKept.length === req.chatHistory.length ? 'included' : 'degraded',
        historyTokens
      )
    }
  }

  /* user message (always) */
  const userTokens = count(req.userMessage)
  used += userTokens

  /* 3 — active chapter */
  const contextParts: string[] = []
  if (source.activeChapter) {
    const full = source.activeChapter.text
    const fullTokens = count(full)
    const chapterCap = Math.floor(budget * CHAPTER_BUDGET_SHARE)
    let text = full
    let status: SectionStatus = 'included'
    if (fullTokens > chapterCap || !fits(fullTokens)) {
      const room = Math.min(chapterCap, Math.max(0, budget - used))
      text = elideMiddle(full, room, count)
      status = 'degraded'
    }
    const tokens = count(text)
    if (fits(tokens)) {
      contextParts.push(`## Current chapter: ${source.activeChapter.title}\n\n${text}`)
      used += tokens
      record('chapter', `Current chapter (${source.activeChapter.title})`, status, tokens)
    } else {
      record('chapter', `Current chapter (${source.activeChapter.title})`, 'dropped', 0)
    }
  }

  /* 3.5 — outlines: top priority when drafting, right after synopsis in chat */
  const addOutline = (id: string, label: string, header: string, text: string | null): void => {
    if (!text?.trim()) return
    const full = `## ${header}\n\n${text.trim()}`
    const tokens = count(full)
    if (fits(tokens)) {
      contextParts.push(full)
      used += tokens
      record(id, label, 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 60) {
        contextParts.push(truncated + '\n[… outline truncated …]')
        used += count(truncated)
        record(id, label, 'degraded', count(truncated))
      } else {
        record(id, label, 'dropped', 0)
      }
    }
  }
  const addOutlines = (): void => {
    addOutline(
      'outline:chapter',
      'Chapter outline',
      'Outline for the current chapter',
      source.chapterOutline
    )
    addOutline('outline:novel', 'Novel outline', 'Novel outline', source.novelOutline)
  }
  if (task === 'draft') addOutlines()

  /* 4 — synopsis */
  if (source.synopsis?.trim()) {
    const full = `## Story synopsis\n\n${source.synopsis.trim()}`
    const tokens = count(full)
    if (fits(tokens)) {
      contextParts.push(full)
      used += tokens
      record('synopsis', 'Novel synopsis', 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 50) {
        contextParts.push(truncated + '\n[… synopsis truncated …]')
        used += count(truncated)
        record('synopsis', 'Novel synopsis', 'degraded', count(truncated))
      } else {
        record('synopsis', 'Novel synopsis', 'dropped', 0)
      }
    }
  }

  if (task !== 'draft') addOutlines()

  /* 5 — world/system rules */
  for (const doc of source.worldDocs) {
    if (!doc.content.trim()) continue
    const full = `## World & systems: ${doc.name}\n\n${doc.content.trim()}`
    const tokens = count(full)
    if (fits(tokens)) {
      contextParts.push(full)
      used += tokens
      record(`world:${doc.name}`, `World rules (${doc.name})`, 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 80) {
        contextParts.push(truncated + '\n[… truncated …]')
        used += count(truncated)
        record(`world:${doc.name}`, `World rules (${doc.name})`, 'degraded', count(truncated))
      } else {
        record(`world:${doc.name}`, `World rules (${doc.name})`, 'dropped', 0)
      }
    }
  }

  /* 6 — characters appearing in the active chapter or recent chat */
  const matchTexts = [
    source.activeChapter?.text ?? '',
    ...req.chatHistory.slice(-6).map((m) => m.content),
    req.userMessage
  ]
  const matched = matchCharacters(source.characters, matchTexts)
  for (const ch of matched) {
    const full = `## Character: ${ch.name}\n\n${ch.facts.trim()}\n\n${ch.body.trim()}`
    const factsOnly = `## Character: ${ch.name}\n\n${ch.facts.trim()}`
    const fullTokens = count(full)
    const factsTokens = count(factsOnly)
    if (fits(fullTokens)) {
      contextParts.push(full)
      used += fullTokens
      record(`char:${ch.name}`, `Character (${ch.name})`, 'included', fullTokens)
    } else if (fits(factsTokens)) {
      contextParts.push(factsOnly)
      used += factsTokens
      record(`char:${ch.name}`, `Character (${ch.name})`, 'degraded', factsTokens)
    } else {
      record(`char:${ch.name}`, `Character (${ch.name})`, 'dropped', 0)
    }
  }

  /* 7 — chapter summaries: previous 2 in full, older as loglines */
  if (source.summaries.length > 0) {
    const idx = source.activeChapterIndex
    const parts: string[] = []
    let summaryTokens = 0
    let anyDegraded = false
    const fullFrom = idx < 0 ? source.summaries.length - 2 : idx - 2
    for (let i = 0; i < source.summaries.length; i++) {
      if (i === idx) continue // active chapter is present in full already
      const s = source.summaries[i]!
      const isRecent = i >= fullFrom && i < (idx < 0 ? source.summaries.length : idx)
      const text = isRecent && s.content.trim() ? `### ${s.title}\n${s.content.trim()}` : `- ${s.title}: ${s.logline}`
      if (!isRecent || !s.content.trim()) anyDegraded = true
      const tokens = count(text)
      if (used + tokens <= budget) {
        parts.push(text)
        used += tokens
        summaryTokens += tokens
      } else {
        anyDegraded = true
        break
      }
    }
    if (parts.length > 0) {
      contextParts.push(`## Chapter summaries so far\n\n${parts.join('\n\n')}`)
      record(
        'summaries',
        `Chapter summaries (${parts.length})`,
        anyDegraded ? 'degraded' : 'included',
        summaryTokens
      )
    } else {
      record('summaries', 'Chapter summaries', 'dropped', 0)
    }
  }

  /* 8 — glossary + timeline tail: first to drop */
  if (source.glossary.length > 0) {
    const haystack = matchTexts.join('\n').toLowerCase()
    const matchedTerms = source.glossary.filter((g) => haystack.includes(g.term.toLowerCase()))
    if (matchedTerms.length > 0) {
      const text = `## Glossary\n\n${matchedTerms.map((g) => `- **${g.term}**: ${g.definition}`).join('\n')}`
      const tokens = count(text)
      if (fits(tokens)) {
        contextParts.push(text)
        used += tokens
        record('glossary', `Glossary (${matchedTerms.length} terms)`, 'included', tokens)
      } else {
        record('glossary', 'Glossary', 'dropped', 0)
      }
    }
  }
  if (source.timelineTail?.trim()) {
    const text = `## Recent timeline events\n\n${source.timelineTail.trim()}`
    const tokens = count(text)
    if (fits(tokens)) {
      contextParts.push(text)
      used += tokens
      record('timeline', 'Timeline (recent events)', 'included', tokens)
    } else {
      record('timeline', 'Timeline', 'dropped', 0)
    }
  }

  const systemContent =
    contextParts.length > 0 ? `${basePrompt}\n\n---\n\n${contextParts.join('\n\n---\n\n')}` : basePrompt

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...historyKept,
    { role: 'user', content: req.userMessage }
  ]

  return {
    messages,
    report: { budgetTokens: budget, usedTokens: used, sections }
  }
}
