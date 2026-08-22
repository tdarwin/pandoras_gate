import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNovel, createChapter, writeChapter } from '../project/service'
import { MockProvider } from '../llm/mock'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  enqueueProposalItems,
  foldProposalsForPath,
  pendingProposalDocs,
  applyProposalDecisions,
  resolveAllProposals,
  listProposals,
  isAllowedProposalPath,
  validateProposalContent,
  rebaseProposal,
  sha256
} from './pipeline'
import { history, flushAutocommit } from '../git/service'

let dir: string
let novelDir: string
let provider: MockProvider

const CHAPTER = 'chapters/001-the-iron-gate.md'

function proposalJson(items: object[]): string {
  return JSON.stringify({ proposals: items })
}

const SUMMARY_ITEM = {
  path: 'metadata/summaries/001-the-iron-gate.md',
  action: 'create',
  newContent: '---\ntitle: The Iron Gate\nlogline: Kael finds the manual.\n---\nKael scavenges the ruins and finds a cultivation manual.\n',
  rationale: 'New chapter summary'
}

const CHARACTER_ITEM = {
  path: 'metadata/characters/kael-voss.md',
  action: 'create',
  newContent: '---\nname: Kael Voss\naliases: []\nrole: protagonist\nstatus: alive\n---\n## Appearance\nWiry.\n',
  rationale: 'New protagonist introduced'
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-pipe-'))
  const state = await createNovel({ parentDir: dir, title: 'Novel', author: 'D' })
  novelDir = state.dir
  await createChapter(novelDir, 'The Iron Gate')
  await writeChapter(
    novelDir,
    CHAPTER,
    '---\ntitle: The Iron Gate\nstatus: draft\n---\nKael Voss crept through the ruins…\n'
  )
  provider = new MockProvider()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = (): ReturnType<typeof runMetadataUpdate> =>
  runMetadataUpdate({ novelDir, chapterFile: CHAPTER, provider, modelId: 'mock-model' })

describe('path and content guards', () => {
  it('allows only Codex and outline paths', () => {
    expect(isAllowedProposalPath('metadata/characters/kael.md')).toBe(true)
    expect(isAllowedProposalPath('metadata/synopsis.md')).toBe(true)
    expect(isAllowedProposalPath('metadata/timeline.yaml')).toBe(true)
    expect(isAllowedProposalPath('outlines/novel.md')).toBe(true)
    expect(isAllowedProposalPath('outlines/001-the-iron-gate.md')).toBe(true)
    expect(isAllowedProposalPath('outlines/deep/nested.md')).toBe(false)
    expect(isAllowedProposalPath('outlines/../chapters/001.md')).toBe(false)
    expect(isAllowedProposalPath('chapters/001.md')).toBe(false)
    expect(isAllowedProposalPath('metadata/../novel.yaml')).toBe(false)
    expect(isAllowedProposalPath('/etc/passwd')).toBe(false)
    expect(isAllowedProposalPath('metadata/other.yaml')).toBe(false)
  })

  it('validates YAML content and rejects empty docs', () => {
    expect(validateProposalContent('metadata/timeline.yaml', '- id: e1\n  summary: x\n')).toBeNull()
    expect(validateProposalContent('metadata/timeline.yaml', '{{nope')).toBeTruthy()
    expect(validateProposalContent('metadata/synopsis.md', '   ')).toBeTruthy()
    expect(validateProposalContent('metadata/synopsis.md', 'fine')).toBeNull()
  })
})

describe('runMetadataUpdate', () => {
  it('produces a pending proposal from model output', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM, CHARACTER_ITEM]))
    const result = await run()
    expect(result.status).toBe('ran')
    expect(result.itemCount).toBe(2)

    const pending = await listProposals(novelDir)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.chapterTitle).toBe('The Iron Gate')
    expect(pending[0]!.items.map((i) => i.path)).toEqual([
      SUMMARY_ITEM.path,
      CHARACTER_ITEM.path
    ])
    // Requests the constrained schema.
    expect(provider.requests[0]!.responseFormat?.name).toBe('metadata_proposals')
  })

  it('skips an unchanged chapter on the second run', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    await run()
    const second = await run()
    expect(second.status).toBe('skipped-unchanged')
    expect(provider.requests).toHaveLength(1)
  })

  it('re-runs when the chapter changes', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    await run()
    await writeChapter(novelDir, CHAPTER, '---\ntitle: The Iron Gate\n---\nNew text entirely.\n')
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const result = await run()
    expect(result.status).toBe('ran')
  })

  it('filters unsafe paths, invalid YAML, and no-ops', async () => {
    provider.queue(
      proposalJson([
        SUMMARY_ITEM,
        { path: 'novel.yaml', action: 'update', newContent: 'pwned: true', rationale: 'x' },
        { path: '../outside.md', action: 'create', newContent: 'x', rationale: 'x' },
        { path: 'metadata/timeline.yaml', action: 'update', newContent: '{{bad yaml', rationale: 'x' }
      ])
    )
    const result = await run()
    expect(result.status).toBe('ran')
    expect(result.itemCount).toBe(1)
  })

  it('reports no-changes when everything is filtered', async () => {
    const synopsis = await readFile(join(novelDir, 'metadata/synopsis.md'), 'utf8')
    provider.queue(
      proposalJson([
        { path: 'metadata/synopsis.md', action: 'update', newContent: synopsis, rationale: 'no-op' }
      ])
    )
    const result = await run()
    expect(result.status).toBe('no-changes')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('throws a friendly error on non-JSON output', async () => {
    provider.queue('Sorry, I cannot do that.')
    await expect(run()).rejects.toThrow(/not valid JSON/)
  })

  it('tolerates markdown fences around JSON', async () => {
    provider.queue('```json\n' + proposalJson([SUMMARY_ITEM]) + '\n```')
    const result = await run()
    expect(result.status).toBe('ran')
  })
})

describe('runOutlineGeneration', () => {
  const NOVEL_OUTLINE_ITEM = {
    path: 'outlines/novel.md',
    action: 'create',
    newContent: '---\nscope: novel\nstatus: draft\n---\n## Act 1\n- Kael finds the manual\n',
    rationale: 'Initial novel outline'
  }

  it('queues an outline proposal for the novel', async () => {
    provider.queue(proposalJson([NOVEL_OUTLINE_ITEM]))
    const result = await runOutlineGeneration({
      novelDir,
      scope: 'novel',
      guidance: 'three acts',
      provider,
      modelId: 'mock-model'
    })
    expect(result.status).toBe('ran')
    const pending = await listProposals(novelDir)
    expect(pending[0]!.chapterTitle).toBe('Outline for the novel')
    expect(pending[0]!.items[0]!.path).toBe('outlines/novel.md')
    // Guidance made it into the prompt.
    expect(provider.requests[0]!.messages[1]!.content).toContain('three acts')
  })

  it('accepting an outline proposal writes into outlines/', async () => {
    provider.queue(proposalJson([NOVEL_OUTLINE_ITEM]))
    await runOutlineGeneration({
      novelDir,
      scope: 'novel',
      provider,
      modelId: 'mock-model'
    })
    await resolveAllProposals({ novelDir, paths: ['outlines/novel.md'], resolution: 'accept' })
    expect(await readFile(join(novelDir, 'outlines/novel.md'), 'utf8')).toContain('## Act 1')
    // Decisions coalesce into one commit rather than one per click.
    await flushAutocommit(novelDir)
    const log = await history(novelDir, 'outlines/novel.md')
    expect(log[0]!.message).toContain('outline: novel')
  })

  it('drops non-outline paths from an outline run', async () => {
    provider.queue(
      proposalJson([
        NOVEL_OUTLINE_ITEM,
        { path: 'metadata/synopsis.md', action: 'update', newContent: 'sneaky', rationale: 'x' }
      ])
    )
    const result = await runOutlineGeneration({
      novelDir,
      scope: 'novel',
      provider,
      modelId: 'mock-model'
    })
    expect(result.itemCount).toBe(1)
  })

  it('chapter outlines target the chapter file name', async () => {
    const item = {
      path: 'outlines/001-the-iron-gate.md',
      action: 'create',
      newContent: '---\nscope: chapter\nchapter: chapters/001-the-iron-gate.md\n---\n- Beat 1\n',
      rationale: 'Chapter outline'
    }
    provider.queue(proposalJson([item]))
    const result = await runOutlineGeneration({
      novelDir,
      scope: 'chapter',
      chapterFile: CHAPTER,
      provider,
      modelId: 'mock-model'
    })
    expect(result.status).toBe('ran')
    const pending = await listProposals(novelDir)
    expect(pending[0]!.chapterTitle).toBe('Outline for The Iron Gate')
  })
})

describe('run bookkeeping', () => {
  const BAD_PATH_ITEM = {
    // The prefix small local models routinely forget.
    path: 'characters/kael-voss.md',
    action: 'create',
    newContent: '---\nname: Kael Voss\n---\nWiry.\n',
    rationale: 'New protagonist'
  }

  it('says why nothing appeared when every suggestion was refused', async () => {
    provider.queue(proposalJson([BAD_PATH_ITEM]))
    const result = await run()
    expect(result.status).toBe('no-changes')
    expect(result.dropped).toEqual([
      { path: BAD_PATH_ITEM.path, reason: 'that file is not part of the Codex' }
    ])
  })

  it('does not mark a chapter processed when everything was refused', async () => {
    provider.queue(proposalJson([BAD_PATH_ITEM]))
    await run()
    // Running again must actually re-analyse: the previous run produced
    // nothing usable, so the chapter is not done — "skipped-unchanged" here
    // would bury it until its text changes.
    provider.queue(proposalJson([SUMMARY_ITEM]))
    expect((await run()).status).toBe('ran')
  })

  it('still marks a chapter processed when the model simply had nothing to add', async () => {
    provider.queue(proposalJson([]))
    expect((await run()).status).toBe('no-changes')
    provider.queue(proposalJson([SUMMARY_ITEM]))
    expect((await run()).status).toBe('skipped-unchanged')
  })

  it('persists the proposal before recording that the chapter was processed', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    await run()
    // The other order loses a whole run to a crash between the two writes.
    // Assert the end state both ways: the work exists AND is marked done.
    expect(await listProposals(novelDir)).toHaveLength(1)
    const state = JSON.parse(await readFile(join(novelDir, '.pandora/state.json'), 'utf8'))
    expect(state.chapters[CHAPTER].lastProcessedHash).toBeTruthy()
  })

  it('coalesces two runs for the same chapter into one model call', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const [a, b] = await Promise.all([run(), run()])
    expect(a).toEqual(b)
    // One generation, one proposal file — not two near-duplicates and two bills.
    expect(provider.requests).toHaveLength(1)
    expect(await listProposals(novelDir)).toHaveLength(1)
  })

  it('keeps a rejection recorded while a slow run was in flight', async () => {
    // Queue something to reject, and reject it mid-generation.
    provider.queue(proposalJson([CHARACTER_ITEM]))
    await run()
    await writeChapter(novelDir, CHAPTER, '---\ntitle: The Iron Gate\n---\nRevised text.\n')

    provider.queue(proposalJson([SUMMARY_ITEM]))
    const orig = provider.chatStream.bind(provider)
    provider.chatStream = async function* (req, signal) {
      // The author rejects an older suggestion while the model is thinking.
      await resolveAllProposals({
        novelDir,
        paths: [CHARACTER_ITEM.path],
        resolution: 'reject'
      })
      yield* orig(req, signal)
    }
    await run()

    // The run must not write back the copy of state.json it read before the
    // call — that is how the rejection used to disappear and the identical
    // suggestion come straight back.
    const state = JSON.parse(await readFile(join(novelDir, '.pandora/state.json'), 'utf8'))
    expect(state.rejectedProposals).toHaveLength(1)
  })
})

describe('folding proposals for one document', () => {
  const SYN = 'metadata/synopsis.md'
  const BASE_SYN = ['---', 'logline: L', '---', 'Alpha.', '', 'Beta.', '', 'Gamma.', ''].join('\n')

  /** Three separate proposals against one base, each a single-paragraph edit. */
  async function queueThreeAgainstOneBase(): Promise<void> {
    await writeChapter(novelDir, SYN, BASE_SYN)
    for (const [from, to] of [
      ['Alpha.', 'Alpha edited.'],
      ['Beta.', 'Beta edited.'],
      ['Gamma.', 'Gamma edited.']
    ] as const) {
      await enqueueProposalItems(novelDir, `Edit ${from}`, [
        { path: SYN, newContent: BASE_SYN.replace(from, to), rationale: 'r', base: BASE_SYN }
      ])
    }
  }

  it('composes sibling edits that share a base instead of overwriting them', async () => {
    await queueThreeAgainstOneBase()
    const folded = await foldProposalsForPath(novelDir, SYN)
    expect(folded.chain).toHaveLength(3)
    expect(folded.blocked).toEqual([])
    // The last link carries all three — the failure mode this replaces is the
    // third proposal, generated against the same base, reverting the first two.
    const final = folded.chain[2]!.content
    expect(final).toContain('Alpha edited.')
    expect(final).toContain('Beta edited.')
    expect(final).toContain('Gamma edited.')
  })

  it('sets a proposal that will not re-anchor aside instead of poisoning the chain', async () => {
    await writeChapter(novelDir, SYN, BASE_SYN)
    await enqueueProposalItems(novelDir, 'Good', [
      { path: SYN, newContent: BASE_SYN.replace('Alpha.', 'Alpha edited.'), rationale: 'r', base: BASE_SYN }
    ])
    // Generated against a base that shares no context with the file.
    await enqueueProposalItems(novelDir, 'Stale', [
      {
        path: SYN,
        newContent: '---\nlogline: L\n---\nSomething else entirely, rewritten.\n',
        rationale: 'r',
        base: '---\nlogline: L\n---\nA document that never existed here.\n'
      }
    ])
    const folded = await foldProposalsForPath(novelDir, SYN)
    expect(folded.chain).toHaveLength(1)
    expect(folded.blocked).toHaveLength(1)
    expect(folded.blocked[0]!.sourceTitle).toBe('Stale')
    expect(folded.blocked[0]!.reason).toMatch(/changed or moved/)
  })

  it('reports every pending document without shipping bodies', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM, CHARACTER_ITEM]))
    await run()
    const docs = await pendingProposalDocs(novelDir)
    expect(docs.map((d) => d.path).sort()).toEqual(
      [CHARACTER_ITEM.path, SUMMARY_ITEM.path].sort()
    )
    // Neither file exists yet, so both are creates — and each carries the name
    // its own frontmatter claims, for a navigation row that has no file to read.
    const character = docs.find((d) => d.path === CHARACTER_ITEM.path)!
    expect(character.action).toBe('create')
    expect(character.label).toBe('Kael Voss')
    expect(character.sources).toEqual(['The Iron Gate'])
  })
})

describe('deciding', () => {
  const SYN = 'metadata/synopsis.md'
  const CURRENT = ['---', 'logline: L', '---', 'Alpha.', '', 'Beta.', ''].join('\n')

  /** One proposal editing both paragraphs, so a hunk can be decided apart. */
  async function queueTwoHunks(): Promise<string> {
    await writeChapter(novelDir, SYN, CURRENT)
    const proposed = CURRENT.replace('Alpha.', 'Alpha edited.').replace('Beta.', 'Beta edited.')
    await enqueueProposalItems(novelDir, 'Copy edit', [
      { path: SYN, newContent: proposed, rationale: 'r', base: CURRENT }
    ])
    return proposed
  }

  it('accepting one hunk writes it and re-anchors what is left', async () => {
    const proposed = await queueTwoHunks()
    const withFirst = CURRENT.replace('Alpha.', 'Alpha edited.')
    const proposalId = (await listProposals(novelDir))[0]!.id

    const result = await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: CURRENT,
      write: withFirst,
      decisions: [{ proposalId, newContent: proposed }]
    })
    expect(result.remaining).toBe(1)
    expect(await readFile(join(novelDir, SYN), 'utf8')).toBe(withFirst)

    const item = (await listProposals(novelDir))[0]!.items[0]!
    // The base advances to what the file now says, so the remaining diff is
    // exactly the undecided hunk.
    expect(item.baseContent).toBe(withFirst)
    expect(item.newContent).toBe(proposed)
    // Something landed, so this is no longer a suggestion the author refused.
    expect(item.asProposed).toBeNull()
  })

  it('rejecting one hunk shrinks the proposal and leaves the file alone', async () => {
    await queueTwoHunks()
    const withoutFirst = CURRENT.replace('Beta.', 'Beta edited.')
    const proposalId = (await listProposals(novelDir))[0]!.id

    await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: CURRENT,
      write: null,
      decisions: [{ proposalId, newContent: withoutFirst }]
    })
    expect(await readFile(join(novelDir, SYN), 'utf8')).toBe(CURRENT)
    const item = (await listProposals(novelDir))[0]!.items[0]!
    expect(item.newContent).toBe(withoutFirst)
    expect(item.baseContent).toBe(CURRENT)
    // Nothing accepted yet, so a later clean reject can still be remembered.
    expect(item.asProposed).not.toBeNull()
  })

  it('resolves the item when nothing is left to suggest', async () => {
    await queueTwoHunks()
    const proposalId = (await listProposals(novelDir))[0]!.id
    await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: CURRENT,
      write: null,
      // Everything rejected: what remains is what the file already says.
      decisions: [{ proposalId, newContent: CURRENT }]
    })
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('leaves a proposal it was not told about alone', async () => {
    // The fold sets aside proposals it cannot combine, and the author is told
    // they still need a look. Accepting the ones that DID combine used to
    // delete them anyway — the work vanished with no trace and no rejection.
    await writeChapter(novelDir, SYN, CURRENT)
    await enqueueProposalItems(novelDir, 'Good', [
      { path: SYN, newContent: CURRENT.replace('Alpha.', 'Alpha edited.'), rationale: 'r', base: CURRENT }
    ])
    await enqueueProposalItems(novelDir, 'Stale', [
      {
        path: SYN,
        newContent: '---\nlogline: L\n---\nSomething else entirely, rewritten.\n',
        rationale: 'r',
        base: '---\nlogline: L\n---\nA document that never existed here.\n'
      }
    ])
    const folded = await foldProposalsForPath(novelDir, SYN)
    expect(folded.chain).toHaveLength(1)
    expect(folded.blocked).toHaveLength(1)

    const result = await resolveAllProposals({ novelDir, paths: [SYN], resolution: 'accept' })
    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(1)
    // The blocked one is still there to look at.
    const left = await listProposals(novelDir)
    expect(left).toHaveLength(1)
    expect(left[0]!.chapterTitle).toBe('Stale')
  })

  it('refuses when the file moved on underneath the review', async () => {
    await queueTwoHunks()
    await writeChapter(novelDir, SYN, '---\nlogline: L\n---\nSomeone else wrote this.\n')
    await expect(
      applyProposalDecisions({
        novelDir,
        path: SYN,
        expectedCurrent: CURRENT,
        write: CURRENT.replace('Alpha.', 'Alpha edited.'),
        decisions: []
      })
    ).rejects.toThrow(/changed while you were reviewing/)
    expect(await readFile(join(novelDir, SYN), 'utf8')).toContain('Someone else wrote this.')
  })

  it('accepting commits the pre-decision file first, so quiet saves reach history', async () => {
    await queueTwoHunks()
    const typed = CURRENT.replace('Beta.', 'Beta, as the author typed it.')
    // A quiet save: on disk, never committed.
    await writeFile(join(novelDir, SYN), typed, 'utf8')
    await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: typed,
      write: typed.replace('Alpha.', 'Alpha edited.'),
      decisions: []
    })
    const log = await history(novelDir, SYN)
    expect(log.some((c) => c.message.includes('before accepting suggestions'))).toBe(true)
  })

  it('does not remember an ACCEPT as a refusal', async () => {
    // The refusal fingerprint exists to stop a rejected suggestion coming
    // back. Recording it on accept meant that after a history restore the
    // identical, wanted suggestion was silently dropped — and each accept
    // burned one of the 200 remembered slots.
    provider.queue(proposalJson([SUMMARY_ITEM]))
    await run()
    await resolveAllProposals({ novelDir, paths: [SUMMARY_ITEM.path], resolution: 'accept' })

    const state = JSON.parse(await readFile(join(novelDir, '.pandora/state.json'), 'utf8'))
    expect(state.rejectedProposals ?? []).toEqual([])

    // …and the same suggestion can be made again.
    await writeChapter(novelDir, CHAPTER, '---\ntitle: The Iron Gate\n---\nRevised text.\n')
    await writeChapter(novelDir, SUMMARY_ITEM.path, 'The author reverted this.\n')
    provider.queue(proposalJson([SUMMARY_ITEM]))
    expect((await run()).status).toBe('ran')
  })

  it('dismisses what could not be folded when the author rejects everything', async () => {
    // Accept leaves a blocked proposal to look at; reject must not, or the nav
    // dot stays and the author has no way to clear it.
    await writeChapter(novelDir, SYN, CURRENT)
    await enqueueProposalItems(novelDir, 'Good', [
      { path: SYN, newContent: CURRENT.replace('Alpha.', 'Alpha edited.'), rationale: 'r', base: CURRENT }
    ])
    await enqueueProposalItems(novelDir, 'Stale', [
      {
        path: SYN,
        newContent: '---\nlogline: L\n---\nSomething else entirely, rewritten.\n',
        rationale: 'r',
        base: '---\nlogline: L\n---\nA document that never existed here.\n'
      }
    ])
    const result = await resolveAllProposals({ novelDir, paths: [SYN], resolution: 'reject' })
    expect(result.skipped).toBe(0)
    expect(await listProposals(novelDir)).toHaveLength(0)
    expect(await readFile(join(novelDir, SYN), 'utf8')).toBe(CURRENT)
  })

  it('remembers a clean reject, and suppresses the identical re-proposal', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM, CHARACTER_ITEM]))
    await run()
    await resolveAllProposals({
      novelDir,
      paths: [CHARACTER_ITEM.path],
      resolution: 'reject'
    })

    // Chapter changes; model proposes the exact same character doc again.
    await writeChapter(novelDir, CHAPTER, '---\ntitle: The Iron Gate\n---\nRevised text.\n')
    provider.queue(proposalJson([CHARACTER_ITEM]))
    expect((await run()).status).toBe('no-changes')
  })

  it('does not remember a rejection once part of the same suggestion was accepted', async () => {
    const proposed = await queueTwoHunks()
    const proposalId = (await listProposals(novelDir))[0]!.id
    const withFirst = CURRENT.replace('Alpha.', 'Alpha edited.')
    // Accept one hunk...
    await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: CURRENT,
      write: withFirst,
      decisions: [{ proposalId, newContent: proposed }]
    })
    // ...then reject the rest.
    await applyProposalDecisions({
      novelDir,
      path: SYN,
      expectedCurrent: withFirst,
      write: null,
      decisions: [{ proposalId, newContent: withFirst }]
    })
    // The document has moved on; re-proposing the rest later is correct, so
    // nothing was fingerprinted as refused.
    const state = JSON.parse(await readFile(join(novelDir, '.pandora/state.json'), 'utf8'))
    expect(state.rejectedProposals ?? []).toEqual([])
  })

  it('survives overlapping decisions on one novel', async () => {
    // Ten documents, all decided at once. Each is a read-modify-write of the
    // same proposal JSON and of state.json.
    const paths = Array.from({ length: 10 }, (_, i) => `metadata/characters/c${i}.md`)
    for (const path of paths) {
      await enqueueProposalItems(novelDir, `Create ${path}`, [
        { path, newContent: `---\nname: C\n---\nBody ${path}.\n`, rationale: 'r' }
      ])
    }
    const idFor = new Map(
      (await listProposals(novelDir)).map((p) => [p.items[0]!.path, p.id])
    )
    await Promise.all(
      paths.map((path) => {
        const write = `---\nname: C\n---\nBody ${path}.\n`
        return applyProposalDecisions({
          novelDir,
          path,
          expectedCurrent: '',
          write,
          decisions: [{ proposalId: idFor.get(path)!, newContent: write }]
        })
      })
    )
    expect(await listProposals(novelDir)).toHaveLength(0)
    for (const path of paths) {
      expect(await readFile(join(novelDir, path), 'utf8')).toContain(`Body ${path}.`)
    }
  })

  it('accept-all applies every foldable document and reports what it skipped', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM, CHARACTER_ITEM]))
    await run()
    const result = await resolveAllProposals({ novelDir, resolution: 'accept' })
    expect(result.applied).toBe(2)
    expect(result.skipped).toBe(0)
    expect(await listProposals(novelDir)).toHaveLength(0)
    expect(await readFile(join(novelDir, SUMMARY_ITEM.path), 'utf8')).toBe(SUMMARY_ITEM.newContent)
    await flushAutocommit(novelDir)
    const log = await history(novelDir, SUMMARY_ITEM.path)
    expect(log[0]!.message).toContain('metadata: 001-the-iron-gate')
  })

  it('sha256 is stable', () => {
    expect(sha256('abc')).toBe(sha256('abc'))
    expect(sha256('abc')).not.toBe(sha256('abd'))
  })

  // The stored proposal JSON lives inside the novel folder, so a foreign or
  // hand-edited novel can put any target path in it. Writing must re-check.
  it('refuses a stored proposal whose path escapes the allowed set', async () => {
    await expect(
      applyProposalDecisions({
        novelDir,
        path: '../outside-the-novel.md',
        expectedCurrent: '',
        write: 'pwned\n',
        decisions: []
      })
    ).rejects.toThrow(/may not touch/)
  })

  it('refuses a stored proposal targeting an unlisted chapter path', async () => {
    await expect(
      applyProposalDecisions({
        novelDir,
        path: 'chapters/not-in-manifest.md',
        expectedCurrent: '',
        write: 'pwned\n',
        decisions: []
      })
    ).rejects.toThrow(/may not touch/)
  })
})

describe('proposal bases', () => {
  const CHAR_PATH = 'metadata/characters/kael-voss.md'
  const PRE_EDIT = '---\nname: Kael Voss\n---\nOld body.\n'
  const MID_RUN_EDIT = '---\nname: Kael Voss\n---\nMy new body, typed mid-run.\n'
  const MODEL_REWRITE = '---\nname: Kael Voss\n---\nModel body.\n'

  it('captures codex bases BEFORE the model call, so a mid-run edit conflicts instead of reverting', async () => {
    await writeChapter(novelDir, CHAR_PATH, PRE_EDIT)
    provider.queue(
      proposalJson([{ path: CHAR_PATH, action: 'update', newContent: MODEL_REWRITE, rationale: 'x' }])
    )
    // The author edits the doc while the (slow) generation runs.
    const orig = provider.chatStream.bind(provider)
    provider.chatStream = async function* (req, signal) {
      await writeChapter(novelDir, CHAR_PATH, MID_RUN_EDIT)
      yield* orig(req, signal)
    }
    await run()

    const pending = await listProposals(novelDir)
    const stored = pending[0]!.items.find((i) => i.path === CHAR_PATH)!
    // The base is what the model SAW, not the enqueue-time disk content.
    expect(stored.baseContent).toBe(PRE_EDIT)
    // And the mid-run edit surfaces as a conflict instead of being silently
    // reverted by a wholesale accept.
    const folded = await foldProposalsForPath(novelDir, CHAR_PATH)
    expect(folded.chain).toHaveLength(0)
    expect(folded.blocked).toHaveLength(1)
  })

  it('reads 0.5.0-era proposals (baseHash) instead of dropping them', async () => {
    const synopsis = '---\nlogline: current\n---\nCurrent synopsis.\n'
    await writeChapter(novelDir, 'metadata/synopsis.md', synopsis)
    await writeChapter(novelDir, 'metadata/glossary.md', '---\nentries: []\n---\n')
    const legacy = {
      id: 'legacy-1',
      chapterFile: CHAPTER,
      chapterTitle: 'The Iron Gate',
      createdAt: Date.now(),
      items: [
        {
          path: 'metadata/synopsis.md',
          action: 'update',
          newContent: '---\nlogline: new\n---\nUpdated synopsis.\n',
          rationale: 'r',
          // Matches the doc on disk: the doc IS the base.
          baseHash: sha256(synopsis)
        },
        {
          path: 'metadata/glossary.md',
          action: 'update',
          newContent: '---\nentries:\n  - term: qi\n    definition: life force\n---\n',
          rationale: 'r',
          // Stale hash: the base is unrecoverable.
          baseHash: sha256('a version that no longer exists')
        }
      ]
    }
    await mkdir(join(novelDir, '.pandora/proposals'), { recursive: true })
    await writeFile(
      join(novelDir, '.pandora/proposals/legacy-1.json'),
      JSON.stringify(legacy),
      'utf8'
    )

    const list = await listProposals(novelDir)
    expect(list).toHaveLength(1)
    // Hash matched → cleanly foldable; stale → preserved as needs-review.
    expect((await foldProposalsForPath(novelDir, 'metadata/synopsis.md')).chain).toHaveLength(1)
    const glossary = await foldProposalsForPath(novelDir, 'metadata/glossary.md')
    expect(glossary.chain).toHaveLength(0)
    expect(glossary.blocked).toHaveLength(1)
    // The migration persisted the new shape.
    const rewritten = JSON.parse(
      await readFile(join(novelDir, '.pandora/proposals/legacy-1.json'), 'utf8')
    )
    expect(rewritten.items[0].baseContent).toBe(synopsis)
    expect(rewritten.items[0].baseHash).toBeUndefined()
    // 0.6.0-era items had no `asProposed`; nothing could be partly decided
    // then, so `newContent` still IS the content as first proposed.
    expect(rewritten.items[0].asProposed).toBe(rewritten.items[0].newContent)
  })
})

describe('rebaseProposal', () => {
  const BASE = [
    '---',
    'title: The Iron Gate',
    '---',
    'Kael crept through the ruins.',
    '',
    'The gate loomed ahead.',
    '',
    'He touched the cold iron.',
    ''
  ].join('\n')
  // The proposal rewrites the middle paragraph.
  const PROPOSED = BASE.replace('The gate loomed ahead.', 'The gate loomed, vast and black.')

  it('applies cleanly when the file is unchanged', () => {
    expect(rebaseProposal(BASE, PROPOSED, BASE)).toEqual({ content: PROPOSED })
  })

  it('keeps prose the author wrote in ANOTHER paragraph since the run', () => {
    const current = BASE.replace(
      'He touched the cold iron.',
      'He touched the cold iron. It burned.'
    )
    const result = rebaseProposal(BASE, PROPOSED, current)
    expect(result).toHaveProperty('content')
    const content = (result as { content: string }).content
    expect(content).toContain('The gate loomed, vast and black.')
    expect(content).toContain('It burned.')
  })

  it('two sibling proposals against one base both survive sequential accepts', () => {
    const second = BASE.replace('Kael crept through the ruins.', 'Kael slipped through the ruins.')
    const afterFirst = (rebaseProposal(BASE, PROPOSED, BASE) as { content: string }).content
    const result = rebaseProposal(BASE, second, afterFirst)
    const content = (result as { content: string }).content
    expect(content).toContain('Kael slipped through the ruins.')
    expect(content).toContain('The gate loomed, vast and black.')
  })

  it('conflicts when the edited paragraph itself changed', () => {
    const current = BASE.replace('The gate loomed ahead.', 'The gate was gone entirely.')
    expect(rebaseProposal(BASE, PROPOSED, current)).toHaveProperty('conflict')
  })

  it('does not re-anchor a short repeated paragraph somewhere else', () => {
    const base = ['"No."', '', 'She waited.', '', '"No."', '', 'He left.', ''].join('\n')
    // Rewrite the SECOND "No." (unique via its neighbours).
    const proposed = ['"No."', '', 'She waited.', '', '"Never."', '', 'He left.', ''].join('\n')
    // The author deleted that whole exchange; an identical "No." remains above.
    const current = ['"No."', '', 'She waited.', '', 'Rain fell.', ''].join('\n')
    expect(rebaseProposal(base, proposed, current)).toHaveProperty('conflict')
  })

  it('re-appends an end-of-file addition to the CURRENT end', () => {
    const appended = BASE.replace(/\s+$/, '') + '\n\nA bell rang out.\n'
    const current = BASE.replace(/\s+$/, '') + '\n\nKael kept writing meanwhile.\n'
    const result = rebaseProposal(BASE, appended, current)
    const content = (result as { content: string }).content
    expect(content.endsWith('Kael kept writing meanwhile.\n\nA bell rang out.\n')).toBe(true)
  })

  it('creates apply only while the path is unclaimed', () => {
    expect(rebaseProposal(null, 'new doc\n', null)).toEqual({ content: 'new doc\n' })
    expect(rebaseProposal(null, 'new doc\n', 'someone else\n')).toHaveProperty('conflict')
    expect(rebaseProposal(null, 'new doc\n', 'new doc\n')).toEqual({ content: 'new doc\n' })
  })

  it('treats an already-applied change as clean', () => {
    expect(rebaseProposal(BASE, PROPOSED, PROPOSED)).toEqual({ content: PROPOSED })
  })

  it('conflicts when the file was deleted', () => {
    expect(rebaseProposal(BASE, PROPOSED, null)).toHaveProperty('conflict')
  })
})

describe('prompt budget', () => {
  it('fits the codex prompt to the model window, truncating and listing omissions', async () => {
    const bigProse = 'The gate loomed and the qi thickened around Kael Voss. '.repeat(600)
    await writeChapter(
      novelDir,
      CHAPTER,
      `---\ntitle: The Iron Gate\nstatus: draft\n---\n${bigProse}`
    )
    for (let i = 0; i < 3; i++) {
      await writeChapter(
        novelDir,
        `metadata/world/system-${i}.md`,
        `---\nlogline: rules ${i}\n---\n${'Rule detail follows here. '.repeat(700)}`
      )
    }
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const result = await run()
    expect(result.status).toBe('ran')

    const req = provider.requests[0]!
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0)
    const estTokens = Math.ceil((promptChars / 4) * 1.1)
    // MockProvider reports an 8192 window; 4096 is reserved for the JSON.
    expect(estTokens).toBeLessThanOrEqual(8192 - 4096 + 96)

    const user = req.messages[1]!.content
    expect(user).toContain('elided for space') // chapter middle elided
    expect(user).toMatch(/truncated for space|Not shown for space/) // world docs bounded
  })

  it('includes everything untouched when the window is roomy', async () => {
    await writeChapter(
      novelDir,
      'metadata/world/magic.md',
      '---\nlogline: how magic works\n---\nSmall doc.\n'
    )
    provider.queue(proposalJson([SUMMARY_ITEM]))
    await run()
    const user = provider.requests[0]!.messages[1]!.content
    expect(user).toContain('Kael Voss crept through the ruins')
    expect(user).toContain('metadata/world/magic.md')
    expect(user).not.toContain('elided for space')
    expect(user).not.toContain('Not shown for space')
  })
})
