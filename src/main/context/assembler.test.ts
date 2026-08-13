import { describe, it, expect } from 'vitest'
import {
  assembleContext,
  matchCharacters,
  mentions,
  resolveContextTarget,
  estimateTokens,
  type StorySource,
  type AssembleRequest
} from './assembler'

/** Deterministic counter for tests: 1 token per 4 chars, no margin. */
const count = (text: string): number => Math.ceil(text.length / 4)

function makeSource(overrides: Partial<StorySource> = {}): StorySource {
  return {
    novelTitle: 'The Iron Gate',
    author: 'Davin',
    customInstructions: null,
    synopsis: 'Kael Voss, a scavenger, discovers a cultivation manual and begins his ascent.',
    novelOutline: 'Act 1: discovery. Act 2: rivalry with Mira. Act 3: the sect trials.',
    chapterOutline: 'Beat 1: Kael confronts Elder Wu. Beat 2: the test. Beat 3: an unexpected ally.',
    worldDocs: [
      {
        name: 'cultivation-system',
        path: 'metadata/world/cultivation-system.md',
        content:
          'Realms: Iron Body (tiers 1-9), Bronze Core, Silver Soul. Breakthrough requires condensing qi.',
        logline: 'Cultivation realms, tiers, and breakthrough requirements.'
      }
    ],
    characters: [
      {
        name: 'Kael Voss',
        aliases: ['The Rust Prince'],
        facts: 'name: Kael Voss\nrealm: Iron Body Tier 2',
        body: 'A scrappy seventeen-year-old scavenger from the outer district.',
        path: 'metadata/characters/kael-voss.md',
        logline: 'Scavenger protagonist climbing the cultivation ranks.'
      },
      {
        name: 'Mira Thane',
        aliases: [],
        facts: 'name: Mira Thane\nrole: rival\nstatus: alive\nrealm: Bronze Core',
        body: 'Kael-adjacent rival with a hidden agenda.',
        path: 'metadata/characters/mira-thane.md',
        logline: null
      },
      {
        name: 'Elder Wu',
        aliases: [],
        facts: 'name: Elder Wu',
        body: 'Mysterious sect elder.',
        path: 'metadata/characters/elder-wu.md',
        logline: null
      }
    ],
    glossary: [
      { term: 'qi', definition: 'Ambient spiritual energy.' },
      { term: 'spirit stone', definition: 'Crystallized qi used as currency.' }
    ],
    summaries: [
      { title: 'Chapter 1', logline: 'Kael finds the manual.', content: 'Kael Voss scavenges the ruins and finds a manual.' },
      { title: 'Chapter 2', logline: 'First breakthrough.', content: 'Kael breaks through to Iron Body Tier 1 at great cost.' },
      { title: 'Chapter 3', logline: 'Mira appears.', content: 'Mira Thane confronts Kael about the manual.' }
    ],
    timelineTail: '- id: e1\n  when: Day 1\n  summary: Manual found',
    activeChapter: { title: 'Chapter 4', text: 'Kael Voss faced Elder Wu across the courtyard. The qi around them crackled.' },
    activeChapterIndex: 3,
    ...overrides
  }
}

function makeRequest(overrides: Partial<AssembleRequest> = {}): AssembleRequest {
  return {
    source: makeSource(),
    chatHistory: [],
    userMessage: 'What should happen next in this scene?',
    contextTokens: 8192,
    reservedOutput: 1024,
    ...overrides
  }
}

describe('matchCharacters', () => {
  it('matches by name and alias, case-insensitively', () => {
    const chars = makeSource().characters
    expect(matchCharacters(chars, ['the rust prince strikes']).map((c) => c.name)).toEqual([
      'Kael Voss'
    ])
    expect(matchCharacters(chars, ['MIRA THANE and kael voss talk']).map((c) => c.name)).toEqual([
      'Kael Voss',
      'Mira Thane'
    ])
    expect(matchCharacters(chars, ['nobody here'])).toEqual([])
  })

  it('does not match short names inside other words', () => {
    const chars = [{ name: 'Al', aliases: [], facts: 'name: Al', body: 'A friend.' }]
    expect(matchCharacters(chars, ['He always arrives late.'])).toEqual([])
    expect(matchCharacters(chars, ['Al always arrives late.']).map((c) => c.name)).toEqual(['Al'])
  })
})

describe('mentions', () => {
  it('requires word boundaries on both sides', () => {
    expect(mentions('the qing dynasty', 'qi')).toBe(false)
    expect(mentions('gathered qi in the courtyard', 'qi')).toBe(true)
    expect(mentions('a spirit stone, please', 'spirit stone')).toBe(true)
    expect(mentions('respirit stones', 'spirit stone')).toBe(false)
  })

  it('rejects sub-2-char needles and escapes regex specials', () => {
    expect(mentions('anything', 'a')).toBe(false)
    expect(mentions('found Dr. Voss (retired) here', 'Dr. Voss (retired)')).toBe(true)
  })
})

describe('resolveContextTarget', () => {
  it('is lean by default and scales gently with the window', () => {
    expect(resolveContextTarget(0, 8192)).toBe(12_288) // window caps it later
    expect(resolveContextTarget(0, 32_768)).toBe(12_288)
    expect(resolveContextTarget(0, 131_072)).toBe(16_384)
    expect(resolveContextTarget(0, 200_000)).toBe(24_576)
    expect(resolveContextTarget(0, 1_000_000)).toBe(24_576)
  })

  it('honors an explicit preference', () => {
    expect(resolveContextTarget(16_384, 200_000)).toBe(16_384)
    expect(resolveContextTarget(8192, 8192)).toBe(8192)
  })
})

describe('assembleContext — happy path', () => {
  it('includes everything when the budget is generous', () => {
    const { messages, report } = assembleContext(makeRequest(), count)
    expect(messages[0]!.role).toBe('system')
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: 'What should happen next in this scene?'
    })

    const system = messages[0]!.content
    expect(system).toContain('The Iron Gate')
    expect(system).toContain('Current chapter: Chapter 4')
    expect(system).toContain('Story synopsis')
    expect(system).toContain('cultivation-system')
    expect(system).toContain('Kael Voss')     // in chapter
    expect(system).toContain('Elder Wu')      // in chapter
    expect(system).toContain('Chapter summaries')
    expect(system).toContain('qi')            // glossary term in chapter
    expect(system).toContain('Recent timeline events')

    expect(report.sections.every((s) => s.status !== 'dropped')).toBe(true)
    expect(report.usedTokens).toBeLessThanOrEqual(report.budgetTokens)
  })

  it('omits characters not mentioned anywhere', () => {
    const req = makeRequest({
      source: makeSource({
        activeChapter: { title: 'Ch', text: 'A quiet scene with no names.' }
      })
    })
    const { messages, report } = assembleContext(req, count)
    // Her profile facts must be absent (name may still surface in summaries).
    expect(messages[0]!.content).not.toContain('realm: Bronze Core')
    expect(report.sections.find((s) => s.id === 'char:Mira Thane')).toBeUndefined()
  })

  it('matches characters mentioned in chat history and the user message', () => {
    const req = makeRequest({
      source: makeSource({ activeChapter: null, activeChapterIndex: -1 }),
      chatHistory: [{ role: 'user', content: 'Tell me about Mira Thane.' }],
      userMessage: 'And what does Elder Wu want?'
    })
    const { messages } = assembleContext(req, count)
    expect(messages[0]!.content).toContain('Mira Thane')
    expect(messages[0]!.content).toContain('Elder Wu')
  })
})

describe('assembleContext — budget pressure', () => {
  it('never exceeds the budget', () => {
    for (const contextTokens of [512, 1024, 2048, 4096]) {
      const { report } = assembleContext(makeRequest({ contextTokens, reservedOutput: 128 }), count)
      expect(report.usedTokens).toBeLessThanOrEqual(report.budgetTokens)
    }
  })

  it('elides the middle of an enormous active chapter', () => {
    const huge = 'The beginning of the chapter. ' + 'filler sentence here. '.repeat(3000) + ' The very end.'
    const req = makeRequest({
      source: makeSource({ activeChapter: { title: 'Big', text: huge } }),
      contextTokens: 4096,
      reservedOutput: 512
    })
    const { messages, report } = assembleContext(req, count)
    const chapterSection = report.sections.find((s) => s.id === 'chapter')
    expect(chapterSection?.status).toBe('degraded')
    expect(messages[0]!.content).toContain('middle of chapter elided')
    expect(messages[0]!.content).toContain('The beginning of the chapter.')
    expect(messages[0]!.content).toContain('The very end.')
  })

  it('degrades characters to facts-only before dropping', () => {
    const bigBody = 'Backstory paragraph. '.repeat(500)
    const source = makeSource({
      characters: [
        {
          name: 'Kael Voss',
          aliases: [],
          facts: 'name: Kael Voss\nrealm: Tier 2',
          body: bigBody,
          path: 'metadata/characters/kael-voss.md',
          logline: null
        }
      ],
      activeChapter: { title: 'Ch', text: 'Kael Voss stood alone.' },
      worldDocs: [],
      synopsis: null,
      summaries: [],
      glossary: [],
      timelineTail: null
    })
    // Budget: enough for chapter + facts, not the giant body.
    const { messages, report } = assembleContext(
      makeRequest({ source, contextTokens: 700, reservedOutput: 100 }),
      count
    )
    const section = report.sections.find((s) => s.id === 'char:Kael Voss')
    expect(section?.status).toBe('degraded')
    expect(messages[0]!.content).toContain('realm: Tier 2')
    expect(messages[0]!.content).not.toContain('Backstory paragraph.')
  })

  it('drops glossary and timeline first under pressure', () => {
    // Tight budget: enough for the (elided) chapter but nothing at the bottom
    // of the ladder. Glossary/timeline are sizeable so they cannot sneak in.
    const bigChapter = 'Kael gathered qi in the courtyard. ' + 'The duel raged on. '.repeat(200)
    const req = makeRequest({
      source: makeSource({
        activeChapter: { title: 'Big', text: bigChapter },
        glossary: [{ term: 'qi', definition: 'Ambient spiritual energy. '.repeat(80) }],
        timelineTail: '- summary: an event\n'.repeat(60)
      }),
      contextTokens: 350,
      reservedOutput: 100
    })
    const { report } = assembleContext(req, count)
    const glossary = report.sections.find((s) => s.id === 'glossary')
    const timeline = report.sections.find((s) => s.id === 'timeline')
    const chapter = report.sections.find((s) => s.id === 'chapter')
    // Chapter survives (possibly degraded); glossary/timeline die first.
    expect(chapter?.status).not.toBe('dropped')
    if (glossary) expect(glossary.status).toBe('dropped')
    if (timeline) expect(timeline.status).toBe('dropped')
  })

  it('collapses older summaries to loglines, keeps recent ones full', () => {
    const { messages } = assembleContext(makeRequest(), count)
    const system = messages[0]!.content
    // Chapters 2 and 3 precede active chapter 4 → full summaries.
    expect(system).toContain('Kael breaks through to Iron Body Tier 1')
    expect(system).toContain('Mira Thane confronts Kael')
    // Chapter 1 is older → logline only.
    expect(system).toContain('Chapter 1: Kael finds the manual.')
    expect(system).not.toContain('scavenges the ruins')
  })

  it('keeps at least the minimum chat turns even when over budget', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i}: ` + 'chatter '.repeat(100)
    }))
    const { messages } = assembleContext(
      makeRequest({ chatHistory: history, contextTokens: 800, reservedOutput: 100 }),
      count
    )
    const nonSystem = messages.filter((m) => m.role !== 'system')
    // ≥ 4 history turns + 1 current user message
    expect(nonSystem.length).toBeGreaterThanOrEqual(5)
    // Newest history retained
    expect(nonSystem.some((m) => m.content.startsWith('Turn 9'))).toBe(true)
  })

  it('includes outlines in chat mode and prioritizes them when drafting', () => {
    const chat = assembleContext(makeRequest(), count)
    expect(chat.messages[0]!.content).toContain('Act 1: discovery')
    expect(chat.messages[0]!.content).toContain('Beat 1: Kael confronts Elder Wu')

    const draft = assembleContext(makeRequest({ task: 'draft' }), count)
    expect(draft.messages[0]!.content).toContain('ghost-drafting')
    expect(draft.messages[0]!.content).toContain('Output ONLY the chapter prose')
    // In draft mode outlines outrank the synopsis in the fill order.
    const sys = draft.messages[0]!.content
    expect(sys.indexOf('Beat 1: Kael confronts Elder Wu')).toBeLessThan(
      sys.indexOf('Story synopsis')
    )
  })

  it('handles an empty project gracefully', () => {
    const source = makeSource({
      synopsis: null,
      novelOutline: null,
      chapterOutline: null,
      worldDocs: [],
      characters: [],
      glossary: [],
      summaries: [],
      timelineTail: null,
      activeChapter: null,
      activeChapterIndex: -1
    })
    const { messages, report } = assembleContext(makeRequest({ source }), count)
    expect(messages).toHaveLength(2) // system + user
    expect(report.usedTokens).toBeGreaterThan(0)
  })

  it('works with the default estimator too', () => {
    const { report } = assembleContext(makeRequest())
    expect(report.usedTokens).toBeGreaterThan(0)
    expect(estimateTokens('12345678')).toBe(3) // 8/4 * 1.1 → ceil(2.2)
  })
})

describe('assembleContext — target budget', () => {
  it('caps the budget at the target on huge windows', () => {
    const { report } = assembleContext(
      makeRequest({ contextTokens: 200_000, reservedOutput: 2048, targetTokens: 4096 }),
      count
    )
    expect(report.budgetTokens).toBe(4096)
    expect(report.windowTokens).toBe(200_000)
    expect(report.usedTokens).toBeLessThanOrEqual(4096)
  })

  it('uses the window when it is smaller than the target', () => {
    const { report } = assembleContext(
      makeRequest({ contextTokens: 4096, reservedOutput: 1024, targetTokens: 12_288 }),
      count
    )
    expect(report.budgetTokens).toBe(3072)
  })

  it('counts fixed tool overhead against the budget and reports it', () => {
    const { report } = assembleContext(makeRequest({ toolOverheadTokens: 500 }), count)
    expect(report.sections.find((s) => s.id === 'tools')).toEqual({
      id: 'tools',
      label: 'Tool instructions & schemas',
      status: 'included',
      tokens: 500
    })
    expect(report.usedTokens).toBeGreaterThanOrEqual(500)
  })
})

describe('assembleContext — world docs', () => {
  it('truncates a single oversized world doc at the per-doc cap', () => {
    const bigDoc = 'System rule line. '.repeat(600) // ~2,700 tokens
    const { report } = assembleContext(
      makeRequest({
        source: makeSource({
          worldDocs: [
            { name: 'levels', path: 'metadata/world/levels.md', content: bigDoc, logline: null }
          ]
        }),
        contextTokens: 32_768,
        reservedOutput: 1024
      }),
      count
    )
    const world = report.sections.find((s) => s.id === 'world:levels')
    expect(world?.status).toBe('degraded')
    expect(world!.tokens).toBeLessThanOrEqual(1500)
  })

  it('bounds all world docs together to a share of the budget', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({
      name: `doc-${i}`,
      path: `metadata/world/doc-${i}.md`,
      content: 'Rule text here. '.repeat(200), // ~800 tokens each
      logline: null
    }))
    const { report } = assembleContext(
      makeRequest({ source: makeSource({ worldDocs: docs }), contextTokens: 8192, reservedOutput: 0 }),
      count
    )
    const worldTokens = report.sections
      .filter((s) => s.id.startsWith('world:'))
      .reduce((sum, s) => sum + s.tokens, 0)
    expect(worldTokens).toBeLessThanOrEqual(Math.floor(8192 * 0.25))
    expect(worldTokens).toBeGreaterThan(0)
  })

  it('puts world docs named in the chapter first', () => {
    const source = makeSource({
      worldDocs: [
        { name: 'alchemy', path: 'metadata/world/alchemy.md', content: 'Potions and pills.', logline: null },
        {
          name: 'cultivation-system',
          path: 'metadata/world/cultivation-system.md',
          content: 'Realms and tiers.',
          logline: null
        }
      ],
      activeChapter: { title: 'Ch', text: 'He studied the cultivation system all night.' }
    })
    const { messages } = assembleContext(makeRequest({ source }), count)
    const sys = messages[0]!.content
    expect(sys.indexOf('World & systems: cultivation-system')).toBeLessThan(
      sys.indexOf('World & systems: alchemy')
    )
  })
})

describe('assembleContext — summaries priority', () => {
  it('sheds the farthest summaries first under pressure, never the recent full ones', () => {
    const summaries = Array.from({ length: 30 }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      logline: `Logline ${i + 1}.`,
      content: `Full summary of chapter ${i + 1}. ` + 'Detail. '.repeat(40)
    }))
    const source = makeSource({
      summaries,
      activeChapterIndex: 29,
      activeChapter: { title: 'Chapter 30', text: 'Kael Voss fights.' }
    })
    const { messages, report } = assembleContext(
      makeRequest({ source, contextTokens: 100_000, reservedOutput: 0, targetTokens: 600 }),
      count
    )
    const sys = messages[0]!.content
    // The two chapters nearest the active one keep their full summaries…
    expect(sys).toContain('Full summary of chapter 29')
    expect(sys).toContain('Full summary of chapter 28')
    // …while the farthest loglines are what gets dropped.
    expect(sys).not.toContain('Logline 1.')
    expect(sys).toContain('Logline 27.')
    expect(report.sections.find((s) => s.id === 'summaries')?.status).toBe('degraded')
  })
})

describe('assembleContext — retrieval-first (lean) mode', () => {
  it('goes lean on tight budgets with tools available', () => {
    const { messages, report } = assembleContext(
      makeRequest({ toolsAvailable: true, targetTokens: 12_288, contextTokens: 16_384, reservedOutput: 2048 }),
      count
    )
    expect(report.mode).toBe('lean')
    const sys = messages[0]!.content
    // The index is present, with fetchable paths and fetch-first instructions.
    expect(sys).toContain('## Codex index')
    expect(sys).toContain('metadata/characters/kael-voss.md')
    expect(sys).toContain('metadata/world/cultivation-system.md')
    expect(sys).toContain('read_codex_doc')
    // The bulk stays on disk.
    expect(sys).not.toContain('World & systems:')
    expect(sys).not.toContain('## Character:')
    expect(report.sections.some((s) => s.id.startsWith('world:'))).toBe(false)
    expect(report.sections.some((s) => s.id.startsWith('char:'))).toBe(false)
    // The core survives.
    expect(sys).toContain('Current chapter: Chapter 4')
    expect(sys).toContain('Story synopsis')
    expect(sys).toContain('Chapter summaries')
    expect(sys).toContain('Recent timeline events')
  })

  it('index lines use loglines, then facts, then first sentences', () => {
    const { messages } = assembleContext(makeRequest({ toolsAvailable: true }), count)
    const sys = messages[0]!.content
    // Kael has an explicit logline.
    expect(sys).toContain('Kael Voss (aka The Rust Prince): Scavenger protagonist climbing')
    // Mira has no logline → role/status from facts.
    expect(sys).toContain('Mira Thane: rival, alive')
    // Elder Wu has neither → first sentence of the body.
    expect(sys).toContain('Elder Wu: Mysterious sect elder.')
    // Glossary is discoverable in lean mode.
    expect(sys).toContain('metadata/glossary.md — term definitions (2 entries)')
  })

  it('stays full without tools, on big budgets, and when drafting', () => {
    const noTools = assembleContext(makeRequest(), count)
    expect(noTools.report.mode).toBe('full')
    expect(noTools.messages[0]!.content).not.toContain('## Codex index')

    const bigBudget = assembleContext(
      makeRequest({
        toolsAvailable: true,
        targetTokens: 24_576,
        contextTokens: 200_000,
        reservedOutput: 2048
      }),
      count
    )
    expect(bigBudget.report.mode).toBe('full')
    // Full mode with tools keeps the bulk AND advertises the index.
    expect(bigBudget.messages[0]!.content).toContain('World & systems:')
    expect(bigBudget.messages[0]!.content).toContain('## Codex index')

    const draft = assembleContext(makeRequest({ toolsAvailable: true, task: 'draft' }), count)
    expect(draft.report.mode).toBe('full')
  })

  it('keeps the index inside the cacheable prefix', () => {
    const { messages, cachePrefixChars } = assembleContext(
      makeRequest({ toolsAvailable: true }),
      count
    )
    expect(messages[0]!.content.slice(0, cachePrefixChars)).toContain('## Codex index')
  })
})

describe('assembleContext — cacheable prefix', () => {
  it('keeps chapter and chat-driven sections after the cache boundary', () => {
    const { messages, cachePrefixChars } = assembleContext(
      makeRequest({ userMessage: 'Tell me about Mira Thane.' }),
      count
    )
    const sys = messages[0]!.content
    const prefix = sys.slice(0, cachePrefixChars)
    const tail = sys.slice(cachePrefixChars)
    // Stable story materials live in the prefix.
    expect(prefix).toContain('Story synopsis')
    expect(prefix).toContain('World & systems')
    expect(prefix).toContain('Chapter summaries')
    // The live chapter and conversation-driven extras come after it.
    expect(prefix).not.toContain('Current chapter:')
    expect(tail).toContain('Current chapter: Chapter 4')
    // Mira is only mentioned in the user message → volatile tail.
    expect(prefix).not.toContain('realm: Bronze Core')
    expect(tail).toContain('realm: Bronze Core')
  })

  it('adds glossary terms raised only in conversation after the prefix', () => {
    const { messages, cachePrefixChars, report } = assembleContext(
      makeRequest({
        source: makeSource({
          activeChapter: { title: 'Ch', text: 'A quiet scene with no special terms.' }
        }),
        userMessage: 'What is a spirit stone worth?'
      }),
      count
    )
    expect(report.sections.find((s) => s.id === 'glossary:chat')).toBeDefined()
    const tail = messages[0]!.content.slice(cachePrefixChars)
    expect(tail).toContain('Crystallized qi used as currency.')
  })

  it('does not pull glossary terms from inside other words', () => {
    const { messages } = assembleContext(
      makeRequest({
        source: makeSource({
          activeChapter: { title: 'Ch', text: 'The qing dynasty vase gleamed.' }
        })
      }),
      count
    )
    expect(messages[0]!.content).not.toContain('Ambient spiritual energy.')
  })
})
