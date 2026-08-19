import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNovel, createChapter, writeChapter } from '../project/service'
import { MockProvider } from '../llm/mock'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  resolveProposalItem,
  proposalsForReview,
  listProposals,
  isAllowedProposalPath,
  validateProposalContent,
  rebaseProposal,
  sha256
} from './pipeline'
import { history } from '../git/service'

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
    const { proposalId } = await runOutlineGeneration({
      novelDir,
      scope: 'novel',
      provider,
      modelId: 'mock-model'
    })
    await resolveProposalItem({
      novelDir,
      proposalId: proposalId!,
      path: 'outlines/novel.md',
      resolution: 'accept'
    })
    expect(await readFile(join(novelDir, 'outlines/novel.md'), 'utf8')).toContain('## Act 1')
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

describe('review resolutions', () => {
  it('accept writes the file and commits', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const { proposalId } = await run()

    const { remaining } = await resolveProposalItem({
      novelDir,
      proposalId: proposalId!,
      path: SUMMARY_ITEM.path,
      resolution: 'accept'
    })
    expect(remaining).toBe(0)
    expect(await listProposals(novelDir)).toHaveLength(0)

    const written = await readFile(join(novelDir, SUMMARY_ITEM.path), 'utf8')
    expect(written).toBe(SUMMARY_ITEM.newContent)
    const log = await history(novelDir, SUMMARY_ITEM.path)
    expect(log[0]!.message).toContain('metadata: 001-the-iron-gate')
  })

  it('accept with edited content writes the edit', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const { proposalId } = await run()
    const review = await proposalsForReview(novelDir)
    const edited = SUMMARY_ITEM.newContent.replace('finds a cultivation manual', 'steals a manual')
    await resolveProposalItem({
      novelDir,
      proposalId: proposalId!,
      path: SUMMARY_ITEM.path,
      resolution: 'accept',
      editedContent: edited,
      expectedCurrentHash: review[0]!.items[0]!.currentHash
    })
    expect(await readFile(join(novelDir, SUMMARY_ITEM.path), 'utf8')).toBe(edited)
  })

  it('accept with edited content refuses when the file moved on underneath', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM]))
    const { proposalId } = await run()
    const review = await proposalsForReview(novelDir)
    // The file changes AFTER the author started editing the suggestion.
    await writeChapter(novelDir, SUMMARY_ITEM.path, '---\ntitle: X\n---\nSomeone else wrote this.\n')
    await expect(
      resolveProposalItem({
        novelDir,
        proposalId: proposalId!,
        path: SUMMARY_ITEM.path,
        resolution: 'accept',
        editedContent: SUMMARY_ITEM.newContent,
        expectedCurrentHash: review[0]!.items[0]!.currentHash
      })
    ).rejects.toThrow(/changed while you were reviewing/)
  })

  it('reject remembers the rejection and suppresses identical re-proposals', async () => {
    provider.queue(proposalJson([SUMMARY_ITEM, CHARACTER_ITEM]))
    const { proposalId } = await run()
    await resolveProposalItem({
      novelDir,
      proposalId: proposalId!,
      path: CHARACTER_ITEM.path,
      resolution: 'reject'
    })

    // Chapter changes; model proposes the exact same character doc again.
    await writeChapter(novelDir, CHAPTER, '---\ntitle: The Iron Gate\n---\nRevised text.\n')
    provider.queue(proposalJson([CHARACTER_ITEM]))
    const result = await run()
    expect(result.status).toBe('no-changes')
  })

  it('flags a conflict when the passage a proposal rewrites was itself rewritten', async () => {
    const synopsisUpdate = {
      path: 'metadata/synopsis.md',
      action: 'create',
      newContent: '---\nlogline: New logline\n---\nUpdated synopsis.\n',
      rationale: 'Chapter changes the arc'
    }
    provider.queue(proposalJson([synopsisUpdate]))
    await run()

    // Author writes their own synopsis before reviewing — the create's path
    // is claimed, nothing to rebase onto.
    await writeChapter(novelDir, 'metadata/synopsis.md', '---\nlogline: mine\n---\nMy own words.\n')

    const review = await proposalsForReview(novelDir)
    expect(review[0]!.items[0]!.conflict).toBe(true)
    expect(review[0]!.items[0]!.currentContent).toContain('My own words.')
    // And a bare accept is refused, readably.
    await expect(
      resolveProposalItem({
        novelDir,
        proposalId: review[0]!.id,
        path: 'metadata/synopsis.md',
        resolution: 'accept'
      })
    ).rejects.toThrow(/changed since the suggestion was made/)
  })

  it('sha256 is stable', () => {
    expect(sha256('abc')).toBe(sha256('abc'))
    expect(sha256('abc')).not.toBe(sha256('abd'))
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
    const review = await proposalsForReview(novelDir)
    expect(review[0]!.items.find((i) => i.path === CHAR_PATH)!.conflict).toBe(true)
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
    const review = await proposalsForReview(novelDir)
    const items = review[0]!.items
    // Hash matched → cleanly acceptable; stale → preserved as needs-review.
    expect(items.find((i) => i.path === 'metadata/synopsis.md')!.conflict).toBe(false)
    expect(items.find((i) => i.path === 'metadata/glossary.md')!.conflict).toBe(true)
    // The migration persisted the new shape.
    const rewritten = JSON.parse(
      await readFile(join(novelDir, '.pandora/proposals/legacy-1.json'), 'utf8')
    )
    expect(rewritten.items[0].baseContent).toBe(synopsis)
    expect(rewritten.items[0].baseHash).toBeUndefined()
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
