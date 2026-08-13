import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '../../shared/llm/types'

const dirs = vi.hoisted(() => ({ userData: '' }))

// worker-host imports utilityProcess at module load; it is never started here.
vi.mock('electron', () => ({
  app: { getPath: (): string => dirs.userData },
  utilityProcess: {}
}))

import { listLocalModels, localProvider } from './local'

let missingPath: string
let presentPath: string

beforeEach(async () => {
  dirs.userData = await mkdtemp(join(tmpdir(), 'pandora-local-'))
  presentPath = join(dirs.userData, 'models', 'present.gguf')
  missingPath = join(dirs.userData, 'models', 'missing.gguf')
  await mkdir(join(dirs.userData, 'models'), { recursive: true })
  await writeFile(presentPath, 'gguf')
  await writeFile(
    join(dirs.userData, 'app-state.json'),
    JSON.stringify({
      recentNovels: [],
      localModels: [
        { path: presentPath, name: 'Present', contextLength: 8192, sizeBytes: 1 },
        { path: missingPath, name: 'Missing', contextLength: 8192, sizeBytes: 1 }
      ]
    })
  )
})

afterEach(async () => {
  await rm(dirs.userData, { recursive: true, force: true })
})

describe('listLocalModels', () => {
  it('hides entries whose file is missing without touching the registry', async () => {
    const models = await listLocalModels()
    expect(models.map((m) => m.path)).toEqual([presentPath])

    // The entry is hidden, not removed: it returns when the file does.
    await writeFile(missingPath, 'gguf')
    expect((await listLocalModels()).map((m) => m.path)).toEqual([presentPath, missingPath])
  })
})

describe('LocalProvider.chatStream', () => {
  it('yields a clean error for a model whose file is gone', async () => {
    const events: StreamEvent[] = []
    const stream = localProvider.chatStream(
      { modelId: missingPath, messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal
    )
    for await (const event of stream) events.push(event)
    expect(events).toEqual([
      { type: 'error', message: `Local model not found: ${missingPath}` }
    ])
  })
})
