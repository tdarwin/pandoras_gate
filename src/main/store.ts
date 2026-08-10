import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

interface AppState {
  recentNovels: string[]
  localModels?: {
    path: string
    name: string
    contextLength: number
    sizeBytes: number
  }[]
}

const DEFAULT_STATE: AppState = { recentNovels: [] }

function statePath(): string {
  return join(app.getPath('userData'), 'app-state.json')
}

export async function readAppState(): Promise<AppState> {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppState>
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export async function writeAppState(state: AppState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true })
  await writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8')
}

/** Moves (or inserts) a novel dir to the front of the recents list. */
export async function touchRecentNovel(dir: string): Promise<void> {
  const state = await readAppState()
  state.recentNovels = [dir, ...state.recentNovels.filter((d) => d !== dir)].slice(0, 10)
  await writeAppState(state)
}
