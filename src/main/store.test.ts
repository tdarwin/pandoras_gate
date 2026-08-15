import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyStatePaths } from './store'

// The migration under test takes explicit dirs, so electron is never touched.
vi.mock('electron', () => ({
  app: {
    getPath: (): never => {
      throw new Error('tests pass explicit dirs')
    }
  }
}))

let base: string
let oldDir: string
let newDir: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'pandora-store-'))
  oldDir = join(base, 'pandoras-box')
  newDir = join(base, 'pandoras-gate')
  await mkdir(join(newDir, 'models'), { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

interface TestState {
  recentNovels?: string[]
  localModels?: { path: string; name: string; contextLength: number; sizeBytes: number }[]
  novelModels?: Record<string, string>
  prefs?: Record<string, unknown>
}

async function writeState(state: TestState): Promise<void> {
  await writeFile(join(newDir, 'app-state.json'), JSON.stringify(state, null, 2), 'utf8')
}

async function readState(): Promise<TestState> {
  return JSON.parse(await readFile(join(newDir, 'app-state.json'), 'utf8')) as TestState
}

function modelEntry(path: string): NonNullable<TestState['localModels']>[number] {
  return { path, name: 'Test Model', contextLength: 8192, sizeBytes: 123 }
}

describe('migrateLegacyStatePaths', () => {
  it('rewrites localModels paths whose file moved to the new userData dir', async () => {
    const moved = join(newDir, 'models', 'mistral.gguf')
    await writeFile(moved, 'gguf')
    await writeState({ localModels: [modelEntry(join(oldDir, 'models', 'mistral.gguf'))] })

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 1, dropped: 0 })
    expect((await readState()).localModels).toEqual([modelEntry(moved)])
  })

  it('preserves subdirectories when rewriting', async () => {
    const sub = join(newDir, 'models', 'org__repo')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'quant.gguf'), 'gguf')
    await writeState({
      localModels: [modelEntry(join(oldDir, 'models', 'org__repo', 'quant.gguf'))]
    })

    migrateLegacyStatePaths(newDir, oldDir)

    expect((await readState()).localModels?.[0]?.path).toBe(join(sub, 'quant.gguf'))
  })

  it('keeps entries whose file still exists at the old location', async () => {
    const stillOld = join(oldDir, 'models', 'stayed.gguf')
    await mkdir(join(oldDir, 'models'), { recursive: true })
    await writeFile(stillOld, 'gguf')
    await writeState({ localModels: [modelEntry(stillOld)] })

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 0, dropped: 0 })
    expect((await readState()).localModels).toEqual([modelEntry(stillOld)])
  })

  it('drops entries whose file exists in neither location', async () => {
    const keeper = join(newDir, 'models', 'present.gguf')
    await writeFile(keeper, 'gguf')
    await writeState({
      localModels: [modelEntry(join(oldDir, 'models', 'gone.gguf')), modelEntry(keeper)]
    })

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 0, dropped: 1 })
    expect((await readState()).localModels).toEqual([modelEntry(keeper)])
  })

  it('drops a rewrite that duplicates a model re-imported at the new location', async () => {
    const moved = join(newDir, 'models', 'dup.gguf')
    await writeFile(moved, 'gguf')
    await writeState({
      localModels: [modelEntry(moved), modelEntry(join(oldDir, 'models', 'dup.gguf'))]
    })

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 0, dropped: 1 })
    expect((await readState()).localModels).toEqual([modelEntry(moved)])
  })

  it('rewrites and drops novelModels ids, leaving remote ids and keys alone', async () => {
    const moved = join(newDir, 'models', 'nemo.gguf')
    await writeFile(moved, 'gguf')
    await writeState({
      novelModels: {
        '/novels/alpha': join(oldDir, 'models', 'nemo.gguf'),
        '/novels/beta': join(oldDir, 'models', 'vanished.gguf'),
        '/novels/gamma': 'anthropic/claude-sonnet-4-5'
      }
    })

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 1, dropped: 1 })
    expect((await readState()).novelModels).toEqual({
      '/novels/alpha': moved,
      '/novels/gamma': 'anthropic/claude-sonnet-4-5'
    })
  })

  it('leaves the state file untouched when nothing references the legacy dir', async () => {
    const local = join(newDir, 'models', 'clean.gguf')
    await writeState({
      recentNovels: ['/novels/alpha'],
      localModels: [modelEntry(local)],
      novelModels: { '/novels/alpha': local }
    })
    const before = await readFile(join(newDir, 'app-state.json'), 'utf8')

    const result = migrateLegacyStatePaths(newDir, oldDir)

    expect(result).toEqual({ rewritten: 0, dropped: 0 })
    expect(await readFile(join(newDir, 'app-state.json'), 'utf8')).toBe(before)
  })

  it('does nothing when the state file is missing', async () => {
    expect(migrateLegacyStatePaths(newDir, oldDir)).toEqual({ rewritten: 0, dropped: 0 })
  })

  // The shape that shipped the bug: every model imported before the rename,
  // one of them in a per-repo subdirectory, plus a per-novel selection.
  it('heals a full pre-rename state file, idempotently, leaving other sections intact', async () => {
    const novelDir = join(base, 'Documents', 'Novels Maybe', 'the-iron-gate')
    const files = [
      join('models', 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf'),
      join('models', 'org__repo-GGUF', 'Ministral-8B-Q4_K_M.gguf')
    ]
    await mkdir(join(newDir, 'models', 'org__repo-GGUF'), { recursive: true })
    for (const f of files) await writeFile(join(newDir, f), 'gguf')
    const prefs = { autoCodex: true, theme: 'system' }
    await writeState({
      recentNovels: [novelDir],
      localModels: files.map((f) => modelEntry(join(oldDir, f))),
      novelModels: { [novelDir]: join(oldDir, files[0]!) },
      prefs
    })

    expect(migrateLegacyStatePaths(newDir, oldDir)).toEqual({ rewritten: 3, dropped: 0 })

    const healed = await readState()
    expect(JSON.stringify(healed)).not.toContain('pandoras-box')
    expect(healed.localModels?.map((m) => m.path)).toEqual(files.map((f) => join(newDir, f)))
    expect(healed.novelModels).toEqual({ [novelDir]: join(newDir, files[0]!) })
    expect(healed.recentNovels).toEqual([novelDir])
    expect(healed.prefs).toEqual(prefs)

    // Second run finds nothing left to do.
    expect(migrateLegacyStatePaths(newDir, oldDir)).toEqual({ rewritten: 0, dropped: 0 })
  })
})
