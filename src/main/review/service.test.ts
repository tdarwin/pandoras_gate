import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNovel, createChapter, writeChapter, listMetadata } from '../project/service'
import { MockProvider } from '../llm/mock'
import { listProposals, resolveProposalItem } from '../metadata/pipeline'
import { runEditingReview, type ReviewRequest } from './service'

let dir: string
let novelDir: string
let provider: MockProvider

const CHAPTER = 'chapters/001-the-iron-gate.md'
const BODY = 'Kael Voss crept threw the ruins, hearth pounding. The gate loomed ahead of him.'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-review-'))
  const state = await createNovel({ parentDir: dir, title: 'Novel', author: 'D' })
  novelDir = state.dir
  await createChapter(novelDir, 'The Iron Gate')
  await writeChapter(novelDir, CHAPTER, `---\ntitle: The Iron Gate\nstatus: draft\n---\n${BODY}\n`)
  provider = new MockProvider()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = (over: Partial<ReviewRequest> = {}): ReturnType<typeof runEditingReview> =>
  runEditingReview({
    novelDir,
    scope: 'chapter',
    chapterFile: CHAPTER,
    reviewType: 'copy-edit',
    provider,
    modelId: 'mock-model',
    ...over
  })

describe('line-edit reviews', () => {
  it('queues the revised chapter as a tracked-change proposal', async () => {
    const fixed = BODY.replace('threw', 'through').replace('hearth', 'heart')
    provider.queue(fixed)
    const result = await run()
    expect(result.status).toBe('ran')
    expect(result.itemCount).toBe(1)

    const pending = await listProposals(novelDir)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.chapterTitle).toBe('Copy edit: The Iron Gate')
    const item = pending[0]!.items[0]!
    expect(item.path).toBe(CHAPTER)
    expect(item.action).toBe('update')
    // Frontmatter is preserved verbatim; only the body was revised.
    expect(item.newContent).toContain('title: The Iron Gate')
    expect(item.newContent).toContain('through')
    expect(item.newContent).not.toContain('hearth')
  })

  it('reports no-changes when the model returns the chapter unchanged', async () => {
    provider.queue(BODY)
    const result = await run({ reviewType: 'proofread' })
    expect(result.status).toBe('no-changes')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('never offers a drastically truncated "revision" as an edit', async () => {
    provider.queue('Kael.')
    const result = await run()
    expect(result.status).toBe('no-changes')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('covers every chapter for novel scope in one proposal', async () => {
    await createChapter(novelDir, 'The Trial')
    await writeChapter(
      novelDir,
      'chapters/002-the-trial.md',
      '---\ntitle: The Trial\nstatus: draft\n---\nThe trial began at dawn, and it was alot to take in.\n'
    )
    provider.queue(BODY.replace('threw', 'through'))
    provider.queue('The trial began at dawn, and it was a lot to take in.')
    const result = await run({ scope: 'novel', chapterFile: undefined })
    expect(result.status).toBe('ran')
    expect(result.itemCount).toBe(2)
    const pending = await listProposals(novelDir)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.items.map((i) => i.path)).toEqual([CHAPTER, 'chapters/002-the-trial.md'])
    expect(provider.requests).toHaveLength(2)
  })

  it('passes author guidance and canon spellings into the prompt', async () => {
    await mkdir(join(novelDir, 'metadata/characters'), { recursive: true })
    await writeFile(
      join(novelDir, 'metadata/characters/kael-voss.md'),
      '---\nname: Kael Voss\naliases: [the Scavenger]\n---\nWiry.\n',
      'utf8'
    )
    provider.queue(BODY)
    await run({ guidance: 'watch for tense slips' })
    const prompt = provider.requests[0]!.messages.find((m) => m.role === 'user')!.content
    expect(prompt).toContain('watch for tense slips')
    expect(prompt).toContain('Kael Voss')
    expect(prompt).toContain('the Scavenger')
  })
})

describe('line-edit review bases', () => {
  it("stores the chapter as read at ITS turn as the item's base", async () => {
    // Two chapters; the author keeps typing into chapter 1 while chapter 2's
    // generation runs. Chapter 1's base must be the pre-typing text.
    await createChapter(novelDir, 'The Trial')
    const CH2 = 'chapters/002-the-trial.md'
    const BODY2 = 'The trial began at dawn with the elders assembled.'
    await writeChapter(novelDir, CH2, `---\ntitle: The Trial\nstatus: draft\n---\n${BODY2}\n`)

    provider.queue(BODY.replace('threw', 'through'))
    provider.queue(BODY2.replace('began', 'commenced'))
    // Simulate typing DURING the pass: mutate chapter 1 when chapter 2's
    // generation starts (i.e. after chapter 1 was read and generated).
    const orig = provider.chatStream.bind(provider)
    let call = 0
    provider.chatStream = (req, signal) => {
      call += 1
      if (call === 2) {
        void writeChapter(
          novelDir,
          CHAPTER,
          `---\ntitle: The Iron Gate\nstatus: draft\n---\n${BODY} New words typed meanwhile.\n`
        )
      }
      return orig(req, signal)
    }

    const result = await run({ scope: 'novel' })
    expect(result.status).toBe('ran')
    const pending = await listProposals(novelDir)
    const item1 = pending[0]!.items.find((i) => i.path === CHAPTER)!
    // The base is the run-start read, NOT the enqueue-time disk content.
    expect(item1.baseContent).toContain(BODY)
    expect(item1.baseContent).not.toContain('New words typed meanwhile.')
  })
})

describe('report reviews', () => {
  it('queues a fact-check report that joins the Codex when accepted', async () => {
    await mkdir(join(novelDir, 'metadata/characters'), { recursive: true })
    await writeFile(
      join(novelDir, 'metadata/characters/kael-voss.md'),
      '---\nname: Kael Voss\n---\nHas green eyes.\n',
      'utf8'
    )
    provider.queue('## Summary\nMostly consistent.\n\n## Findings\n1. Eye color conflict.\n\n## Uncertain\nNone.')
    const result = await run({ reviewType: 'fact-check' })
    expect(result.status).toBe('ran')

    const pending = await listProposals(novelDir)
    expect(pending).toHaveLength(1)
    const item = pending[0]!.items[0]!
    expect(item.path).toMatch(/^metadata\/reviews\/\d{4}-\d{2}-\d{2}-fact-check-001-the-iron-gate\.md$/)
    expect(item.action).toBe('create')
    expect(item.newContent).toContain('review_type: fact-check')
    expect(item.newContent).toContain('Eye color conflict')
    // The prompt carried the canon the checker needs.
    const prompt = provider.requests[0]!.messages.find((m) => m.role === 'user')!.content
    expect(prompt).toContain('Has green eyes.')

    // Accepting the proposal writes the report and it becomes browsable.
    await resolveProposalItem({
      novelDir,
      proposalId: pending[0]!.id,
      path: item.path,
      resolution: 'accept'
    })
    const listing = await listMetadata(novelDir)
    expect(listing.reviews).toHaveLength(1)
    expect(listing.reviews[0]!.title).toContain('Fact check — The Iron Gate')
    const onDisk = await readFile(join(novelDir, item.path), 'utf8')
    expect(onDisk).toContain('## Findings')
  })

  it('reviews the whole novel from summaries and outline', async () => {
    await mkdir(join(novelDir, 'metadata/summaries'), { recursive: true })
    await writeFile(
      join(novelDir, 'metadata/summaries/001-the-iron-gate.md'),
      '---\ntitle: The Iron Gate\n---\nKael finds the gate.\n',
      'utf8'
    )
    provider.queue('## Overview\nPromising start.\n\n## What\'s working\n- voice\n\n## Structure & pacing\nFine.\n\n## Character & point of view\nFine.\n\n## Stakes & tension\nLow.\n\n## Recommendations\n1. Raise stakes.')
    const result = await run({ reviewType: 'developmental', scope: 'novel', chapterFile: undefined })
    expect(result.status).toBe('ran')
    const pending = await listProposals(novelDir)
    const item = pending[0]!.items[0]!
    expect(item.path).toMatch(/^metadata\/reviews\/\d{4}-\d{2}-\d{2}-developmental-novel\.md$/)
    const prompt = provider.requests[0]!.messages.find((m) => m.role === 'user')!.content
    expect(prompt).toContain('Kael finds the gate.')
    expect(prompt).toContain('Full chapter text is NOT included')
  })
})
