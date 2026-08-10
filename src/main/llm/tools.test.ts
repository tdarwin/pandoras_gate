import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { createNovel, createChapter } from '../project/service'
import { listProposals } from '../metadata/pipeline'
import { MockProvider } from './mock'
import { chatToolDefinitions, executeTool, type ToolContext } from './tools'

let dir: string
let novelDir: string
let provider: MockProvider
let sent: unknown[]

function fakeSender(): WebContents {
  return {
    isDestroyed: () => false,
    send: (...args: unknown[]) => {
      sent.push(args)
    }
  } as unknown as WebContents
}

function ctx(activeFile: string | null): ToolContext {
  return { novelDir, activeFile, provider, modelId: 'mock-model', sender: fakeSender() }
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
  vi.restoreAllMocks()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('chatToolDefinitions', () => {
  it('offers both tools when a chapter is open', () => {
    const tools = chatToolDefinitions(ctx('chapters/001-the-iron-gate.md'))
    expect(tools.map((t) => t.name)).toEqual(['update_codex', 'generate_outline'])
  })

  it('drops update_codex when no chapter is open', () => {
    const tools = chatToolDefinitions(ctx(null))
    expect(tools.map((t) => t.name)).toEqual(['generate_outline'])
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
    expect(result).toContain('review queue')
    expect(await listProposals(novelDir)).toHaveLength(1)
    // Renderer was notified to refresh.
    expect(sent.some((args) => (args as unknown[])[0] === 'proposals:changed')).toBe(true)
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
    expect(result).toContain('review queue')
    const proposals = await listProposals(novelDir)
    expect(proposals[0]!.items[0]!.path).toBe('outlines/novel.md')
  })

  it('reports unknown tools and bad arguments as errors, not throws', async () => {
    expect(await executeTool(ctx(null), 'no_such_tool', '{}')).toContain('unknown tool')
    expect(await executeTool(ctx(null), 'generate_outline', '{{{')).toContain('Error')
  })
})
