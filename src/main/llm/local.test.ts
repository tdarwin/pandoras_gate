import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '../../shared/llm/types'

const dirs = vi.hoisted(() => ({ userData: '' }))

// worker-host imports utilityProcess at module load; it is never started here.
vi.mock('electron', () => ({
  app: { getPath: (): string => dirs.userData },
  utilityProcess: {}
}))

import {
  contextCeilingFor,
  isManagedModelFile,
  listLocalModels,
  localProvider,
  removeLocalModel,
  type LocalModelEntry
} from './local'
import { DEFAULT_CONTEXT_CEILING } from '../../shared/llm/memory'

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

describe('contextCeilingFor', () => {
  const entry = (over: Partial<LocalModelEntry>): LocalModelEntry => ({
    path: '/m.gguf',
    name: 'M',
    contextLength: 8192,
    sizeBytes: 1,
    ...over
  })

  it('caps the trained window at the app policy ceiling', () => {
    // Regression: warm-load passed the trained window straight through, so a
    // large-memory machine resolved a 256k context (~17GB of KV cache) while
    // the picker had promised 64k.
    expect(contextCeilingFor(entry({ trainContextLength: 262144 }))).toBe(DEFAULT_CONTEXT_CEILING)
  })

  it('uses the trained window when it is below the ceiling', () => {
    expect(contextCeilingFor(entry({ trainContextLength: 32768 }))).toBe(32768)
  })

  it('falls back to the stored window when the trained one is unknown', () => {
    expect(contextCeilingFor(entry({ contextLength: 16384 }))).toBe(16384)
  })

  it('never exceeds the ceiling however large the stored window', () => {
    expect(contextCeilingFor(entry({ contextLength: 1_000_000 }))).toBe(DEFAULT_CONTEXT_CEILING)
  })
})

describe('isManagedModelFile', () => {
  it('claims files the app downloaded, including per-repo subdirectories', () => {
    expect(isManagedModelFile(join(dirs.userData, 'models', 'a.gguf'))).toBe(true)
    expect(isManagedModelFile(join(dirs.userData, 'models', 'owner__repo', 'a.gguf'))).toBe(true)
  })

  it('leaves files the user imported from elsewhere alone', () => {
    expect(isManagedModelFile('/Users/someone/Downloads/a.gguf')).toBe(false)
    // Guards against a prefix match on a sibling directory.
    expect(isManagedModelFile(join(dirs.userData, 'models-backup', 'a.gguf'))).toBe(false)
  })
})

describe('removeLocalModel', () => {
  it('deletes a downloaded file, whether or not any catalog still lists it', async () => {
    // Regression: removal used to delete only when the live catalog still had
    // the model, so rotating the catalog orphaned multi-gigabyte files.
    await removeLocalModel(presentPath)
    expect(await listLocalModels()).toEqual([])
    await expect(access(presentPath)).rejects.toThrow()
  })

  it('only deregisters a file the user imported from their own disk', async () => {
    const outside = join(dirs.userData, 'elsewhere', 'mine.gguf')
    await mkdir(join(dirs.userData, 'elsewhere'), { recursive: true })
    await writeFile(outside, 'gguf')
    await writeFile(
      join(dirs.userData, 'app-state.json'),
      JSON.stringify({
        recentNovels: [],
        localModels: [{ path: outside, name: 'Mine', contextLength: 8192, sizeBytes: 1 }]
      })
    )

    await removeLocalModel(outside)
    expect(await listLocalModels()).toEqual([])
    // Still on disk — the app never owned it.
    await expect(access(outside)).resolves.toBeUndefined()
  })

  it('leaves the other quants alone when one is removed from a shared repo', async () => {
    // Regression: the per-repo directory is shared by every quant pulled from
    // that repo, so removing one used to recursively delete the rest — they
    // vanished from disk while still registered.
    const repoDir = join(dirs.userData, 'models', 'owner__repo')
    const q4 = join(repoDir, 'model-Q4_K_M.gguf')
    const q8 = join(repoDir, 'model-Q8_0.gguf')
    await mkdir(repoDir, { recursive: true })
    await writeFile(q4, 'gguf')
    await writeFile(q8, 'gguf')
    await writeFile(
      join(dirs.userData, 'app-state.json'),
      JSON.stringify({
        recentNovels: [],
        localModels: [
          { path: q4, name: 'Q4', contextLength: 8192, sizeBytes: 1 },
          { path: q8, name: 'Q8', contextLength: 8192, sizeBytes: 1 }
        ]
      })
    )

    await removeLocalModel(q4)
    await expect(access(q4)).rejects.toThrow()
    await expect(access(q8)).resolves.toBeUndefined()
    expect((await listLocalModels()).map((m) => m.name)).toEqual(['Q8'])
    // The shared directory has to survive while a sibling still lives in it.
    await expect(access(repoDir)).resolves.toBeUndefined()
  })

  it('refuses to treat a path escaping the models directory as managed', async () => {
    // This function decides what gets deleted, so an un-normalized path must
    // not be able to walk out of modelsDir() and back somewhere else.
    const escaped = join(dirs.userData, 'models', '..', 'elsewhere', 'mine.gguf')
    expect(isManagedModelFile(escaped)).toBe(false)

    await mkdir(join(dirs.userData, 'elsewhere'), { recursive: true })
    await writeFile(join(dirs.userData, 'elsewhere', 'mine.gguf'), 'gguf')
    await writeFile(
      join(dirs.userData, 'app-state.json'),
      JSON.stringify({
        recentNovels: [],
        localModels: [{ path: escaped, name: 'Escaped', contextLength: 8192, sizeBytes: 1 }]
      })
    )
    await removeLocalModel(escaped)
    await expect(access(join(dirs.userData, 'elsewhere', 'mine.gguf'))).resolves.toBeUndefined()
  })

  it('cleans up the per-repo directory a Hugging Face download created', async () => {
    const repoDir = join(dirs.userData, 'models', 'owner__repo')
    const nested = join(repoDir, 'model.gguf')
    await mkdir(repoDir, { recursive: true })
    await writeFile(nested, 'gguf')
    await writeFile(
      join(dirs.userData, 'app-state.json'),
      JSON.stringify({
        recentNovels: [],
        localModels: [{ path: nested, name: 'HF', contextLength: 8192, sizeBytes: 1 }]
      })
    )

    await removeLocalModel(nested)
    await expect(access(repoDir)).rejects.toThrow()
    // The shared models directory itself must survive.
    await expect(access(join(dirs.userData, 'models'))).resolves.toBeUndefined()
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
