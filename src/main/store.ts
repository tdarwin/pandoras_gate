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
  /** Last-used model per novel dir, restored when the novel opens. */
  novelModels?: Record<string, string>
  prefs?: {
    autoStoryBible?: boolean
    snapshotOnBlur?: boolean
    snapshotIntervalMinutes?: number
    contextTargetTokens?: number
    theme?: string
  }
}

const DEFAULT_STATE: AppState = { recentNovels: [] }

/** 0 = no interval (snapshot only on save/blur/switch). */
export const SNAPSHOT_INTERVALS = [0, 5, 10, 15, 20] as const

/** 0 = automatic (lean target that scales gently with the model window). */
export const CONTEXT_TARGETS = [0, 8192, 16384, 32768] as const

export type ThemePref = 'dark' | 'light' | 'system'

export interface Prefs {
  autoStoryBible: boolean
  snapshotOnBlur: boolean
  snapshotIntervalMinutes: number
  contextTargetTokens: number
  theme: ThemePref
}

export async function readPrefs(): Promise<Prefs> {
  const state = await readAppState()
  const interval = state.prefs?.snapshotIntervalMinutes ?? 0
  const contextTarget = state.prefs?.contextTargetTokens ?? 0
  const theme = state.prefs?.theme
  return {
    autoStoryBible: state.prefs?.autoStoryBible ?? true,
    snapshotOnBlur: state.prefs?.snapshotOnBlur ?? true,
    snapshotIntervalMinutes: (SNAPSHOT_INTERVALS as readonly number[]).includes(interval)
      ? interval
      : 0,
    contextTargetTokens: (CONTEXT_TARGETS as readonly number[]).includes(contextTarget)
      ? contextTarget
      : 0,
    theme: theme === 'light' || theme === 'system' ? theme : 'dark'
  }
}

export async function writePrefs(update: Partial<Prefs>): Promise<Prefs> {
  const state = await readAppState()
  const current = await readPrefs()
  const next = { ...current, ...update }
  await writeAppState({ ...state, prefs: next })
  return next
}

export async function getNovelModel(novelDir: string): Promise<string | null> {
  const state = await readAppState()
  return state.novelModels?.[novelDir] ?? null
}

export async function setNovelModel(novelDir: string, modelId: string): Promise<void> {
  const state = await readAppState()
  await writeAppState({
    ...state,
    novelModels: { ...state.novelModels, [novelDir]: modelId }
  })
}

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
