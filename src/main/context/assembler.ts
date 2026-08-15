import type { ChatMessage } from '../../shared/llm/types'

/**
 * Context assembly: builds the model's message list from story materials
 * within a token budget. Pure — all file contents arrive pre-loaded in
 * StorySource, token counting is injected — so every budget edge is unit
 * testable.
 *
 * Budget: min(model window − reserved output, target). The target keeps
 * prompts lean on huge-window models instead of filling to the brim.
 *
 * Priority ladder (top never cut, bottom degrades first):
 *   1. system prompt (role + rules) + tool overhead — never cut
 *   2. recent chat turns                     — never below MIN_CHAT_TURNS
 *   3. active chapter                        — middle elided if enormous
 *   4. novel synopsis                        — truncated if needed
 *   5. world/system rules                    — per-doc caps + shared share cap
 *   6. matched character profiles            — degrade to frontmatter-only
 *   7. chapter summaries                     — degrade FARTHEST-first
 *   8. glossary + timeline tail              — first to drop
 *
 * Presentation order differs from allocation order for prompt caching: the
 * system message is [stable story materials][chat-matched extras][active
 * chapter]. Everything before the chat-matched extras is byte-identical
 * across turns (while the chapter's cast is unchanged), so providers can
 * cache it — `cachePrefixChars` marks the boundary.
 */

export interface CharacterSource {
  /** Display name, e.g. "Kael Voss". */
  name: string
  aliases: string[]
  /** Raw YAML frontmatter (structured facts). */
  facts: string
  /** Prose body. */
  body: string
  /** Codex path the model can pass to read_codex_doc. */
  path: string
  /** One-sentence description from frontmatter, when the doc carries one. */
  logline: string | null
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
  worldDocs: { name: string; path: string; content: string; logline: string | null }[]
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
   * Cap on assembled input tokens, independent of the model window. Without
   * it, huge-window models get the whole codex every message.
   */
  targetTokens?: number
  /**
   * Fixed prompt cost added outside assembly (tool system note + tool JSON
   * schemas). Counted against the budget and surfaced in the report so the
   * inspector matches what the provider actually bills.
   */
  toolOverheadTokens?: number
  /**
   * Whether the model can call the codex read tools. Enables the codex index
   * section, and — on tight budgets — lean retrieval-first assembly.
   */
  toolsAvailable?: boolean
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
  /** The model's full context window, for display alongside the budget. */
  windowTokens: number
  /**
   * 'lean': retrieval-first — codex bulk stays on disk, the model fetches
   * docs through tools. 'full': selective upfront inclusion.
   */
  mode: 'lean' | 'full'
  sections: { id: string; label: string; status: SectionStatus; tokens: number }[]
}

export interface AssembledContext {
  messages: ChatMessage[]
  report: ContextReport
  /**
   * Length (in chars) of the prefix of messages[0].content that stays
   * byte-identical across turns of a conversation — the cacheable part.
   */
  cachePrefixChars: number
}

export type TokenCounter = (text: string) => number

/** Default estimator: ~4 chars/token with a 10% safety margin. */
export const estimateTokens: TokenCounter = (text) => Math.ceil((text.length / 4) * 1.1)

const MIN_CHAT_TURNS = 4
/** The active chapter may take at most this share of the whole budget. */
const CHAPTER_BUDGET_SHARE = 0.5
/** All world docs together may take at most this share of the budget. */
const WORLD_BUDGET_SHARE = 0.25
/** A single world doc is truncated beyond this many tokens. */
const WORLD_DOC_TOKEN_CAP = 1500

/** Auto target: lean by default, scaling gently with the model window. */
const AUTO_TARGET_BASE = 12_288
const AUTO_TARGET_MAX = 24_576

/**
 * At or below this budget (and with tools available), assembly goes
 * retrieval-first: the codex index replaces the world/character/glossary
 * bulk and the model fetches full docs on demand.
 */
export const LEAN_CONTEXT_BUDGET_MAX = 16_384

/**
 * Resolves the user's context-size pref (0 = auto) to a token target for a
 * given model window. Auto: 12k, drifting up to 24k on very large windows —
 * never "whatever the window holds".
 */
export function resolveContextTarget(pref: number, windowTokens: number): number {
  if (pref > 0) return pref
  return Math.min(Math.max(AUTO_TARGET_BASE, Math.floor(windowTokens / 8)), AUTO_TARGET_MAX)
}

export function truncateToTokens(text: string, maxTokens: number, count: TokenCounter): string {
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
export function elideMiddle(text: string, maxTokens: number, count: TokenCounter): string {
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-word mention check. A bare substring test pulls in "Al" from
 * "always"; boundaries on both sides prevent that while staying
 * case-insensitive and Unicode-safe.
 */
export function mentions(haystack: string, needle: string): boolean {
  const n = needle.trim()
  if (n.length < 2) return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)
}

/** Characters mentioned (by name or alias) in the given texts. */
export function matchCharacters<T extends { name: string; aliases: string[] }>(
  characters: T[],
  texts: string[]
): T[] {
  const haystack = texts.join('\n')
  return characters.filter((c) => [c.name, ...c.aliases].some((needle) => mentions(haystack, needle)))
}

export function assembleContext(req: AssembleRequest, count: TokenCounter = estimateTokens): AssembledContext {
  const { source } = req
  const windowBudget = Math.max(0, req.contextTokens - req.reservedOutput)
  const budget = req.targetTokens !== undefined ? Math.min(windowBudget, Math.max(0, req.targetTokens)) : windowBudget
  const task = req.task ?? 'chat'
  // Retrieval-first: on tight budgets with tools available, the codex index
  // replaces the world/character/glossary bulk — the model fetches on demand.
  const lean = Boolean(req.toolsAvailable) && budget <= LEAN_CONTEXT_BUDGET_MAX && task === 'chat'
  const sections: ContextReport['sections'] = []
  const record = (id: string, label: string, status: SectionStatus, tokens: number): void => {
    sections.push({ id, label, status, tokens })
  }

  let used = 0
  const fits = (tokens: number): boolean => used + tokens <= budget

  /* 1 — system prompt (never cut) */
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
          "You are the author's writing assistant inside Pandora's Gate, a novel-writing studio.",
          `The author${source.author ? ` (${source.author})` : ''} is working on the novel "${source.novelTitle}".`,
          'You help with brainstorming, prose feedback, continuity, and craft — and you can ACT on the novel itself: revising and drafting chapters, and maintaining the Codex (the novel\'s canon reference: characters, world rules, outlines, and summaries).',
          'Story materials follow; treat them as canon. Be concrete.'
        ].join(' ')) + customSuffix
  used += count(basePrompt)
  record('system', 'System prompt', 'included', count(basePrompt))

  /* 1b — fixed tool overhead (note + schemas), billed but added outside assembly */
  if (req.toolOverheadTokens && req.toolOverheadTokens > 0) {
    used += req.toolOverheadTokens
    record('tools', 'Tool instructions & schemas', 'included', req.toolOverheadTokens)
  }

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

  /*
   * Two haystacks for relevance matching. Chapter-based matches are stable
   * across chat turns → cacheable prefix. Chat-based matches change every
   * message → volatile tail, after the cache boundary.
   */
  const chapterHaystack = source.activeChapter?.text ?? ''
  const chatHaystack = [...req.chatHistory.slice(-6).map((m) => m.content), req.userMessage].join('\n')

  const stableParts: string[] = []
  const volatileParts: string[] = []
  let chapterPart: string | null = null

  /* 3 — active chapter (allocated early, presented last for prefix stability) */
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
      chapterPart = `## Current chapter: ${source.activeChapter.title}\n\n${text}`
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
      stableParts.push(full)
      used += tokens
      record(id, label, 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 60) {
        stableParts.push(truncated + '\n[… outline truncated …]')
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
      stableParts.push(full)
      used += tokens
      record('synopsis', 'Novel synopsis', 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 50) {
        stableParts.push(truncated + '\n[… synopsis truncated …]')
        used += count(truncated)
        record('synopsis', 'Novel synopsis', 'degraded', count(truncated))
      } else {
        record('synopsis', 'Novel synopsis', 'dropped', 0)
      }
    }
  }

  if (task !== 'draft') addOutlines()

  /* 4.5 — codex index: one line per fetchable doc. In lean mode it REPLACES
   * the bulk sections below and carries fetch-first instructions; in full
   * mode it advertises what read_codex_doc can still pull in. */
  const addCodexIndex = (): void => {
    if (!req.toolsAvailable) return
    const firstSentence = (text: string): string => {
      const line = (text.trim().split('\n', 1)[0] ?? '').trim()
      return line.length > 110 ? line.slice(0, 110).trimEnd() + '…' : line
    }
    const factsField = (facts: string, key: string): string | null => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(facts)
      return m ? m[1]!.trim().replace(/^['"]|['"]$/g, '') : null
    }
    const lines: string[] = []
    for (const c of source.characters) {
      const summary =
        c.logline?.trim() ||
        [factsField(c.facts, 'role'), factsField(c.facts, 'status')].filter(Boolean).join(', ') ||
        firstSentence(c.body) ||
        'character'
      const aka = c.aliases.length > 0 ? ` (aka ${c.aliases.join(', ')})` : ''
      lines.push(`- ${c.path} — ${c.name}${aka}: ${summary}`)
    }
    for (const w of source.worldDocs) {
      const summary = w.logline?.trim() || firstSentence(w.content) || 'world/system doc'
      lines.push(`- ${w.path} — ${summary}`)
    }
    if (lean && source.glossary.length > 0) {
      lines.push(`- metadata/glossary.md — term definitions (${source.glossary.length} entries)`)
    }
    if (lines.length === 0) return
    const note = lean
      ? 'Only this index is loaded — the documents themselves are NOT. Before answering anything that depends on a specific character, world rule, or term, call read_codex_doc with the path below (find_in_chapter for chapter text) and answer from what it returns. Do not guess details you have not read.'
      : 'More codex detail is on disk than could be included above; fetch any doc with read_codex_doc.'
    const full = `## Codex index\n\n${note}\n\n${lines.join('\n')}`
    const tokens = count(full)
    if (fits(tokens)) {
      stableParts.push(full)
      used += tokens
      record('codex-index', `Codex index (${lines.length} docs)`, 'included', tokens)
    } else {
      const room = Math.max(0, budget - used)
      const truncated = truncateToTokens(full, room, count)
      if (count(truncated) > 60) {
        stableParts.push(truncated + '\n[… index truncated …]')
        used += count(truncated)
        record('codex-index', `Codex index (${lines.length} docs)`, 'degraded', count(truncated))
      } else {
        record('codex-index', 'Codex index', 'dropped', 0)
      }
    }
  }
  if (lean) addCodexIndex()

  /* 5 — world/system rules: chapter-relevant docs first, capped per doc and
   * as a group so a sprawling Codex can't crowd out everything else.
   * Lean mode: stays on disk, represented by the index. */
  if (!lean) {
    const docs = source.worldDocs.filter((d) => d.content.trim())
    const isRelevant = (name: string): boolean =>
      mentions(chapterHaystack, name) || mentions(chapterHaystack, name.replace(/[-_]/g, ' '))
    const ordered = [...docs.filter((d) => isRelevant(d.name)), ...docs.filter((d) => !isRelevant(d.name))]
    let worldBudget = Math.floor(budget * WORLD_BUDGET_SHARE)
    for (const doc of ordered) {
      const full = `## World & systems: ${doc.name}\n\n${doc.content.trim()}`
      const tokens = count(full)
      const room = Math.min(WORLD_DOC_TOKEN_CAP, worldBudget, Math.max(0, budget - used))
      if (tokens <= room) {
        stableParts.push(full)
        used += tokens
        worldBudget -= tokens
        record(`world:${doc.name}`, `World rules (${doc.name})`, 'included', tokens)
      } else {
        const truncated = truncateToTokens(full, room, count)
        const truncatedTokens = count(truncated)
        if (truncatedTokens > 80) {
          stableParts.push(truncated + '\n[… truncated …]')
          used += truncatedTokens
          worldBudget -= truncatedTokens
          record(`world:${doc.name}`, `World rules (${doc.name})`, 'degraded', truncatedTokens)
        } else {
          record(`world:${doc.name}`, `World rules (${doc.name})`, 'dropped', 0)
        }
      }
    }
  }

  /* 6 — characters: chapter cast in the stable prefix; characters who only
   * came up in conversation go after the cache boundary. Lean mode: index
   * entries stand in for profiles. */
  const stableChars = lean ? [] : matchCharacters(source.characters, [chapterHaystack])
  const volatileChars = lean
    ? []
    : matchCharacters(
        source.characters.filter((c) => !stableChars.includes(c)),
        [chatHaystack]
      )
  const addCharacter = (ch: CharacterSource, parts: string[]): void => {
    const full = `## Character: ${ch.name}\n\n${ch.facts.trim()}\n\n${ch.body.trim()}`
    const factsOnly = `## Character: ${ch.name}\n\n${ch.facts.trim()}`
    const fullTokens = count(full)
    const factsTokens = count(factsOnly)
    if (fits(fullTokens)) {
      parts.push(full)
      used += fullTokens
      record(`char:${ch.name}`, `Character (${ch.name})`, 'included', fullTokens)
    } else if (fits(factsTokens)) {
      parts.push(factsOnly)
      used += factsTokens
      record(`char:${ch.name}`, `Character (${ch.name})`, 'degraded', factsTokens)
    } else {
      record(`char:${ch.name}`, `Character (${ch.name})`, 'dropped', 0)
    }
  }
  for (const ch of stableChars) addCharacter(ch, stableParts)
  for (const ch of volatileChars) addCharacter(ch, volatileParts)

  /* 7 — chapter summaries: previous 2 in full, the rest as loglines.
   * Budget pressure sheds the FARTHEST chapters first — the two most recent
   * full summaries are the last summaries standing, not the first cut. */
  if (source.summaries.length > 0) {
    const idx = source.activeChapterIndex
    const n = source.summaries.length
    const lastPrev = idx < 0 ? n - 1 : idx - 1
    const fullFrom = Math.max(0, lastPrev - 1)
    // Allocation order: the 2 full summaries nearest the active chapter,
    // then older loglines nearest-first, then any later chapters' loglines.
    const order: number[] = []
    for (let i = lastPrev; i >= fullFrom; i--) order.push(i)
    for (let i = fullFrom - 1; i >= 0; i--) order.push(i)
    if (idx >= 0) for (let i = idx + 1; i < n; i++) order.push(i)

    const kept = new Map<number, string>()
    let summaryTokens = 0
    let anyDegraded = false
    for (const i of order) {
      const s = source.summaries[i]!
      const wantFull = i >= fullFrom && i <= lastPrev && Boolean(s.content.trim())
      let text = wantFull ? `### ${s.title}\n${s.content.trim()}` : `- ${s.title}: ${s.logline}`
      if (!wantFull) anyDegraded = true
      let tokens = count(text)
      if (wantFull && !fits(tokens)) {
        // A full summary that doesn't fit still earns its logline.
        text = `- ${s.title}: ${s.logline}`
        tokens = count(text)
        anyDegraded = true
      }
      if (fits(tokens)) {
        kept.set(i, text)
        used += tokens
        summaryTokens += tokens
      } else {
        anyDegraded = true
      }
    }
    if (kept.size > 0) {
      const parts = [...kept.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text)
      stableParts.push(`## Chapter summaries so far\n\n${parts.join('\n\n')}`)
      record(
        'summaries',
        `Chapter summaries (${kept.size})`,
        anyDegraded ? 'degraded' : 'included',
        summaryTokens
      )
    } else {
      record('summaries', 'Chapter summaries', 'dropped', 0)
    }
  }

  /* 8 — glossary + timeline tail: first to drop. Chapter-matched terms are
   * stable; terms that only came up in conversation join the volatile tail. */
  if (!lean && source.glossary.length > 0) {
    const stableTerms = source.glossary.filter((g) => mentions(chapterHaystack, g.term))
    const volatileTerms = source.glossary.filter(
      (g) => !stableTerms.includes(g) && mentions(chatHaystack, g.term)
    )
    const addGlossary = (id: string, terms: typeof source.glossary, parts: string[]): void => {
      if (terms.length === 0) return
      const text = `## Glossary\n\n${terms.map((g) => `- **${g.term}**: ${g.definition}`).join('\n')}`
      const tokens = count(text)
      if (fits(tokens)) {
        parts.push(text)
        used += tokens
        record(id, `Glossary (${terms.length} terms)`, 'included', tokens)
      } else {
        record(id, 'Glossary', 'dropped', 0)
      }
    }
    addGlossary('glossary', stableTerms, stableParts)
    addGlossary('glossary:chat', volatileTerms, volatileParts)
  }
  if (source.timelineTail?.trim()) {
    const text = `## Recent timeline events\n\n${source.timelineTail.trim()}`
    const tokens = count(text)
    if (fits(tokens)) {
      stableParts.push(text)
      used += tokens
      record('timeline', 'Timeline (recent events)', 'included', tokens)
    } else {
      record('timeline', 'Timeline', 'dropped', 0)
    }
  }

  /* Full mode still advertises what tools can fetch (lean added it earlier,
   * with fetch-first instructions and higher priority). */
  if (!lean) addCodexIndex()

  /* Compose: stable prefix, then chat-driven extras, then the live chapter. */
  const orderedParts = [...stableParts, ...volatileParts, ...(chapterPart ? [chapterPart] : [])]
  const systemContent =
    orderedParts.length > 0 ? `${basePrompt}\n\n---\n\n${orderedParts.join('\n\n---\n\n')}` : basePrompt
  const cachePrefixChars =
    stableParts.length > 0
      ? `${basePrompt}\n\n---\n\n${stableParts.join('\n\n---\n\n')}`.length
      : basePrompt.length

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...historyKept,
    { role: 'user', content: req.userMessage }
  ]

  return {
    messages,
    report: {
      budgetTokens: budget,
      usedTokens: used,
      windowTokens: req.contextTokens,
      mode: lean ? 'lean' : 'full',
      sections
    },
    cachePrefixChars
  }
}
