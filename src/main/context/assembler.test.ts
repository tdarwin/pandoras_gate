import { describe, it, expect } from 'vitest'
import {
  assembleContext,
  matchCharacters,
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
        content:
          'Realms: Iron Body (tiers 1-9), Bronze Core, Silver Soul. Breakthrough requires condensing qi.'
      }
    ],
    characters: [
      {
        name: 'Kael Voss',
        aliases: ['The Rust Prince'],
        facts: 'name: Kael Voss\nrealm: Iron Body Tier 2',
        body: 'A scrappy seventeen-year-old scavenger from the outer district.'
      },
      {
        name: 'Mira Thane',
        aliases: [],
        facts: 'name: Mira Thane\nrealm: Bronze Core',
        body: 'Kael-adjacent rival with a hidden agenda.'
      },
      {
        name: 'Elder Wu',
        aliases: [],
        facts: 'name: Elder Wu',
        body: 'Mysterious sect elder.'
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
        { name: 'Kael Voss', aliases: [], facts: 'name: Kael Voss\nrealm: Tier 2', body: bigBody }
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
