import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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
  it('allows only story-bible and outline paths', () => {
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
    const edited = SUMMARY_ITEM.newContent.replace('finds a cultivation manual', 'steals a manual')
    await resolveProposalItem({
      novelDir,
      proposalId: proposalId!,
      path: SUMMARY_ITEM.path,
      resolution: 'accept',
      editedContent: edited
    })
    expect(await readFile(join(novelDir, SUMMARY_ITEM.path), 'utf8')).toBe(edited)
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

  it('flags conflicts when the target doc changed after proposal generation', async () => {
    const synopsisUpdate = {
      path: 'metadata/synopsis.md',
      action: 'update',
      newContent: '---\nlogline: New logline\n---\nUpdated synopsis.\n',
      rationale: 'Chapter changes the arc'
    }
    provider.queue(proposalJson([synopsisUpdate]))
    await run()

    // Author edits the synopsis before reviewing.
    await writeChapter(novelDir, 'metadata/synopsis.md', '---\nlogline: mine\n---\nMy own words.\n')

    const review = await proposalsForReview(novelDir)
    expect(review[0]!.items[0]!.conflict).toBe(true)
    expect(review[0]!.items[0]!.currentContent).toContain('My own words.')
  })

  it('sha256 is stable', () => {
    expect(sha256('abc')).toBe(sha256('abc'))
    expect(sha256('abc')).not.toBe(sha256('abd'))
  })
})
