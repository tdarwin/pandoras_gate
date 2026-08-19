import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { createNovel, createChapter } from '../project/service'
import { listProposals } from '../metadata/pipeline'
import { MockProvider } from './mock'
import { chatToolDefinitions, executeTool, type ToolContext } from './tools'
import type { DeferredRun } from './chat'

let dir: string
let novelDir: string
let provider: MockProvider
let sent: unknown[]
let deferred: DeferredRun[]

function fakeSender(): WebContents {
  return {
    isDestroyed: () => false,
    send: (...args: unknown[]) => {
      sent.push(args)
    }
  } as unknown as WebContents
}

function ctx(activeFile: string | null): ToolContext {
  return {
    novelDir,
    activeFile,
    provider,
    modelId: 'mock-model',
    sender: fakeSender(),
    defer: (job) => deferred.push(job)
  }
}

/** Runs everything the tools deferred, as the chat orchestrator would. */
async function runDeferred(): Promise<string[]> {
  const results: string[] = []
  for (const job of deferred.splice(0)) results.push(await job.run(() => {}))
  return results
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-tools-'))
  const state = await createNovel({ parentDir: dir, title: 'Novel', author: 'D' })
  novelDir = state.dir
  await createChapter(novelDir, 'The Iron Gate')
  await writeFile(
    join(novelDir, 'chapters/001-the-iron-gate.md'),
    '---\ntitle: The Iron Gate\n---\nKael crept through the ruins.\n'
  )
  provider = new MockProvider()
  sent = []
  deferred = []
  vi.restoreAllMocks()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('chatToolDefinitions', () => {
  it('offers all tools when a chapter is open', () => {
    const tools = chatToolDefinitions(ctx('chapters/001-the-iron-gate.md'))
    expect(tools.map((t) => t.name)).toEqual([
      'write_codex_doc',
      'list_codex_docs',
      'read_codex_doc',
      'update_codex',
      'list_chapters',
      'create_chapter',
      'draft_chapter',
      'edit_chapter',
      'find_in_chapter',
      'edit_chapter_section',
      'append_to_chapter',
      'generate_outline'
    ])
  })

  it('drops open-chapter tools when no chapter is open', () => {
    const tools = chatToolDefinitions(ctx(null))
    expect(tools.map((t) => t.name)).toEqual([
      'write_codex_doc',
      'list_codex_docs',
      'read_codex_doc',
      'list_chapters',
      'create_chapter',
      'draft_chapter',
      'find_in_chapter',
      'edit_chapter_section',
      'append_to_chapter',
      'generate_outline'
    ])
  })
})

describe('write_codex_doc', () => {
  const CHAR_DOC =
    '---\nname: Mira Thane\naliases: []\nrole: rival\nstatus: alive\n---\n## Appearance\nSharp-eyed.\n'

  it('queues a document the model authored directly', async () => {
    const result = await executeTool(
      ctx(null),
      'write_codex_doc',
      JSON.stringify({
        path: 'metadata/characters/mira-thane.md',
        content: CHAR_DOC,
        rationale: 'Author asked for a profile of Mira'
      })
    )
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.chapterTitle).toBe('Chat suggestion')
    expect(proposals[0]!.items[0]!).toMatchObject({
      path: 'metadata/characters/mira-thane.md',
      action: 'create',
      newContent: CHAR_DOC
    })
    expect(sent.some((args) => (args as unknown[])[0] === 'proposals:changed')).toBe(true)
  })

  it('rejects disallowed paths and invalid YAML', async () => {
    const bad = await executeTool(
      ctx(null),
      'write_codex_doc',
      JSON.stringify({ path: 'novel.yaml', content: 'pwned', rationale: 'x' })
    )
    expect(bad).toContain('not an allowed path')

    const badYaml = await executeTool(
      ctx(null),
      'write_codex_doc',
      JSON.stringify({ path: 'metadata/timeline.yaml', content: '{{nope', rationale: 'x' })
    )
    expect(badYaml).toContain('Nothing queued')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('requires path and content', async () => {
    const result = await executeTool(
      ctx(null),
      'write_codex_doc',
      JSON.stringify({ path: 'metadata/synopsis.md' })
    )
    expect(result).toContain('required')
  })
})

describe('chapter tools', () => {
  it('list_chapters shows order, status, and the open chapter', async () => {
    const result = await executeTool(ctx('chapters/001-the-iron-gate.md'), 'list_chapters', '{}')
    expect(result).toContain('1. The Iron Gate (chapters/001-the-iron-gate.md, status: draft, OPEN IN EDITOR)')
  })

  it('create_chapter adds an empty chapter and notifies the renderer', async () => {
    const result = await executeTool(
      ctx(null),
      'create_chapter',
      JSON.stringify({ title: 'First Breakthrough' })
    )
    expect(result).toContain('Created chapter 2')
    expect(result).toContain('chapters/002-first-breakthrough.md')
    const notify = sent.find((args) => (args as unknown[])[0] === 'novel:updated')
    expect(notify).toBeDefined()
    const state = (notify as unknown[])[1] as { manifest: { chapters: { title: string }[] } }
    expect(state.manifest.chapters.map((c) => c.title)).toEqual([
      'The Iron Gate',
      'First Breakthrough'
    ])
  })

  it('draft_chapter emits a draft request for a valid chapter', async () => {
    const result = await executeTool(
      ctx('chapters/001-the-iron-gate.md'),
      'draft_chapter',
      JSON.stringify({ instructions: 'Open with the storm.' })
    )
    expect(result).toContain('will start streaming')
    const req = sent.find((args) => (args as unknown[])[0] === 'draft:requested')
    expect((req as unknown[])[1]).toEqual({
      chapterFile: 'chapters/001-the-iron-gate.md',
      instructions: 'Open with the storm.'
    })
  })

  it('create_chapter refuses duplicate titles', async () => {
    const result = await executeTool(
      ctx(null),
      'create_chapter',
      JSON.stringify({ title: 'the iron gate' })
    )
    expect(result).toContain('already exists')
    expect(result).toContain('chapters/001-the-iron-gate.md')
    const manifest = await executeTool(ctx(null), 'list_chapters', '{}')
    expect(manifest.split('\n')).toHaveLength(1)
  })

  it('append_to_chapter targets an existing (empty) chapter through review', async () => {
    await executeTool(ctx(null), 'create_chapter', JSON.stringify({ title: 'The Trial' }))
    const result = await executeTool(
      ctx(null),
      'append_to_chapter',
      JSON.stringify({
        chapterFile: 'chapters/002-the-trial.md',
        content: 'The moved scene lands here.',
        rationale: 'Moving the scene from chapter one'
      })
    )
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    const item = proposals[0]!.items[0]!
    expect(item.path).toBe('chapters/002-the-trial.md')
    expect(item.newContent).toContain('The moved scene lands here.')
  })

  it('append_to_chapter refuses nonexistent chapters instead of inviting creation', async () => {
    const result = await executeTool(
      ctx(null),
      'append_to_chapter',
      JSON.stringify({ chapterFile: 'chapters/099-nope.md', content: 'x' })
    )
    expect(result).toContain('does not exist')
    expect(result).toContain('Do NOT create')
  })

  it('draft_chapter rejects unknown chapters', async () => {
    const result = await executeTool(
      ctx(null),
      'draft_chapter',
      JSON.stringify({ chapterFile: 'chapters/099-nope.md' })
    )
    expect(result).toContain('Error')
    expect(sent.some((args) => (args as unknown[])[0] === 'draft:requested')).toBe(false)
  })

  it('edit_chapter queues a full revision as a reviewable proposal', async () => {
    // The revision generation returns raw prose (not JSON).
    provider.queue('Kael crept through the ruins at night, rain hammering the shattered stone.')
    const result = await executeTool(
      ctx('chapters/001-the-iron-gate.md'),
      'edit_chapter',
      JSON.stringify({ instructions: 'Set the scene at night, in the rain.' })
    )
    expect(result).toContain('Queued')
    expect(provider.requests).toHaveLength(0)
    await runDeferred()

    const proposals = await listProposals(novelDir)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.chapterTitle).toBe('Chapter edit: The Iron Gate')
    const item = proposals[0]!.items[0]!
    expect(item.path).toBe('chapters/001-the-iron-gate.md')
    expect(item.action).toBe('update')
    // Frontmatter preserved verbatim, body replaced.
    expect(item.newContent).toContain('title: The Iron Gate')
    expect(item.newContent).toContain('rain hammering the shattered stone')
    expect(item.newContent).not.toContain('Kael crept through the ruins.\n')
    // The revision request carried the chapter text and instructions.
    const prompt = provider.requests[0]!.messages.at(-1)!.content
    expect(prompt).toContain('Kael crept through the ruins.')
    expect(prompt).toContain('Set the scene at night, in the rain.')
  })

  it('edit_chapter requires instructions and an open chapter', async () => {
    expect(await executeTool(ctx('chapters/001-the-iron-gate.md'), 'edit_chapter', '{}')).toContain(
      'required'
    )
    expect(
      await executeTool(ctx(null), 'edit_chapter', JSON.stringify({ instructions: 'x' }))
    ).toContain('no chapter is open')
  })
})

describe('find_in_chapter / edit_chapter_section', () => {
  const CHAPTER = 'chapters/001-the-iron-gate.md'
  const BODY =
    'Kael crept through the ruins.\n\nThe elder waited at the gate, arms folded against the wind.\n\nRain began to fall as Kael spoke his first words.\n'

  beforeEach(async () => {
    await writeFile(
      join(novelDir, CHAPTER),
      `---\ntitle: The Iron Gate\nstatus: draft\n---\n${BODY}`
    )
  })

  it('find_in_chapter returns matching paragraphs with context and position', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'find_in_chapter',
      JSON.stringify({ query: 'elder' })
    )
    expect(result).toContain('1 match(es)')
    expect(result).toContain('paragraph 2 of 3')
    expect(result).toContain('The elder waited at the gate')
    // Context includes neighboring paragraphs.
    expect(result).toContain('Kael crept through the ruins.')
  })

  it('find_in_chapter reports no matches politely', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'find_in_chapter',
      JSON.stringify({ query: 'dragon' })
    )
    expect(result).toContain('No matches')
  })

  it('edit_chapter_section splices a unique passage and queues a diff', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'edit_chapter_section',
      JSON.stringify({
        find: 'The elder waited at the gate, arms folded against the wind.',
        replacement: 'The elder waited at the gate, hood drawn low against the storm.',
        rationale: 'Author wants the storm foreshadowed here'
      })
    )
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    const item = proposals[0]!.items[0]!
    expect(item.path).toBe(CHAPTER)
    expect(item.newContent).toContain('hood drawn low against the storm')
    expect(item.newContent).toContain('Kael crept through the ruins.')
    expect(item.newContent).toContain('title: The Iron Gate')
    expect(item.newContent).not.toContain('arms folded against the wind')
  })

  it('rejects text that is not found, guiding toward exact quoting', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'edit_chapter_section',
      JSON.stringify({ find: 'The elder waited at the door', replacement: 'x' })
    )
    expect(result).toContain('not found')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('rejects ambiguous matches with a count', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'edit_chapter_section',
      JSON.stringify({ find: 'Kael', replacement: 'Kael Voss' })
    )
    expect(result).toContain('appears 2 times')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('edits a chapter other than the open one via chapterFile', async () => {
    await executeTool(ctx(null), 'create_chapter', JSON.stringify({ title: 'Elsewhere' }))
    await writeFile(
      join(novelDir, 'chapters/002-elsewhere.md'),
      '---\ntitle: Elsewhere\nstatus: draft\n---\nA quiet paragraph sits here.\n'
    )
    const result = await executeTool(
      ctx(CHAPTER),
      'edit_chapter_section',
      JSON.stringify({
        chapterFile: 'chapters/002-elsewhere.md',
        find: 'A quiet paragraph sits here.',
        replacement: 'A louder paragraph stands here.'
      })
    )
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    expect(proposals[0]!.items[0]!.path).toBe('chapters/002-elsewhere.md')
  })

  it('supports deletion via empty replacement', async () => {
    const result = await executeTool(
      ctx(CHAPTER),
      'edit_chapter_section',
      JSON.stringify({
        find: 'Rain began to fall as Kael spoke his first words.\n',
        replacement: ''
      })
    )
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    expect(proposals[0]!.items[0]!.newContent).not.toContain('Rain began to fall')
  })
})

describe('list_codex_docs / read_codex_doc', () => {
  it('lists seeded docs and reads one back', async () => {
    const listing = await executeTool(ctx(null), 'list_codex_docs', '{}')
    expect(listing).toContain('metadata/synopsis.md')
    expect(listing).toContain('metadata/timeline.yaml')

    const doc = await executeTool(
      ctx(null),
      'read_codex_doc',
      JSON.stringify({ path: 'metadata/synopsis.md' })
    )
    expect(doc).toContain('logline:')
  })

  it('read rejects bad paths and reports missing docs', async () => {
    expect(
      await executeTool(ctx(null), 'read_codex_doc', JSON.stringify({ path: '../secrets.json' }))
    ).toContain('Error')
    expect(
      await executeTool(
        ctx(null),
        'read_codex_doc',
        JSON.stringify({ path: 'metadata/characters/nobody.md' })
      )
    ).toContain('does not exist')
  })
})

describe('executeTool', () => {
  it('update_codex runs the pipeline and queues proposals', async () => {
    provider.queue(
      JSON.stringify({
        proposals: [
          {
            path: 'metadata/summaries/001-the-iron-gate.md',
            action: 'create',
            newContent: '---\ntitle: The Iron Gate\nlogline: Kael sneaks in.\n---\nSummary.\n',
            rationale: 'Chapter summary'
          }
        ]
      })
    )
    const result = await executeTool(ctx('chapters/001-the-iron-gate.md'), 'update_codex', '{}')
    // The tool defers the generation — nothing runs during the reply.
    expect(result).toContain('Queued')
    expect(provider.requests).toHaveLength(0)
    expect(await listProposals(novelDir)).toHaveLength(0)
    expect(deferred).toHaveLength(1)

    const results = await runDeferred()
    expect(results).toEqual(['1 suggestion'])
    expect(await listProposals(novelDir)).toHaveLength(1)
  })

  it('update_codex forces a run even when the chapter is unchanged', async () => {
    const summary = {
      proposals: [
        {
          path: 'metadata/summaries/001-the-iron-gate.md',
          action: 'create',
          newContent: '---\ntitle: The Iron Gate\nlogline: Kael sneaks in.\n---\nSummary v1.\n',
          rationale: 'Chapter summary'
        }
      ]
    }
    provider.queue(JSON.stringify(summary))
    await executeTool(ctx('chapters/001-the-iron-gate.md'), 'update_codex', '{}')
    await runDeferred()
    // Same chapter content — an explicit second request must still run.
    summary.proposals[0]!.newContent = summary.proposals[0]!.newContent.replace('v1', 'v2')
    provider.queue(JSON.stringify(summary))
    await executeTool(ctx('chapters/001-the-iron-gate.md'), 'update_codex', '{}')
    await runDeferred()
    expect(provider.requests).toHaveLength(2)
  })

  it('update_codex refuses without an open chapter', async () => {
    const result = await executeTool(ctx(null), 'update_codex', '{}')
    expect(result).toContain('Error')
    expect(await listProposals(novelDir)).toHaveLength(0)
  })

  it('generate_outline queues an outline proposal', async () => {
    provider.queue(
      JSON.stringify({
        proposals: [
          {
            path: 'outlines/novel.md',
            action: 'create',
            newContent: '---\nscope: novel\n---\n## Act 1\n',
            rationale: 'Novel outline'
          }
        ]
      })
    )
    const result = await executeTool(
      ctx(null),
      'generate_outline',
      JSON.stringify({ scope: 'novel', guidance: 'three acts' })
    )
    expect(result).toContain('Queued')
    expect(provider.requests).toHaveLength(0)
    await runDeferred()
    const proposals = await listProposals(novelDir)
    expect(proposals[0]!.items[0]!.path).toBe('outlines/novel.md')
  })

  it('reports unknown tools and bad arguments as errors, not throws', async () => {
    expect(await executeTool(ctx(null), 'no_such_tool', '{}')).toContain('unknown tool')
    expect(await executeTool(ctx(null), 'generate_outline', '{{{')).toContain('Error')
  })
})
