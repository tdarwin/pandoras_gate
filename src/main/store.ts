import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, sep } from 'node:path'
import { logInfo } from './log'
import { MODEL_ROLES, type ModelRoleMap } from '../shared/llm/catalog'
import {
  SNAPSHOT_INTERVALS,
  CONTEXT_TARGETS,
  ThemePrefSchema,
  EditorFontFamilySchema,
  EditorFontSizeSchema,
  EditorLineHeightSchema,
  EditorMeasureSchema,
  type ThemePref
} from '../shared/prefs'

// Roles are declared with the catalog vocabulary they share; re-exported here
// because this module is where the rest of main reaches for prefs types.
export { MODEL_ROLES }
export type { ModelRole, ModelRoleMap } from '../shared/llm/catalog'
export { SNAPSHOT_INTERVALS, CONTEXT_TARGETS }
export type { ThemePref }

interface AppState {
  recentNovels: string[]
  localModels?: {
    path: string
    name: string
    /** Effective window for this machine, refreshed when the worker sizes it. */
    contextLength: number
    /** Absent on entries written before 0.5; backfillModelMetadata() fills it in. */
    trainContextLength?: number
    sizeBytes: number
  }[]
  /** Last-used model per novel dir, restored when the novel opens. */
  novelModels?: Record<string, string>
  prefs?: {
    autoCodex?: boolean
    snapshotOnBlur?: boolean
    snapshotIntervalMinutes?: number
    contextTargetTokens?: number
    theme?: string
    /** Only assigned roles are stored; missing = use the chat model. */
    modelRoles?: Record<string, string>
    showUnfilteredModels?: boolean
    editorFontFamily?: string | null
    editorFontSize?: number | null
    editorLineHeight?: number | null
    editorMeasure?: number | null
  }
}

const DEFAULT_STATE: AppState = { recentNovels: [] }

export interface Prefs {
  autoCodex: boolean
  snapshotOnBlur: boolean
  snapshotIntervalMinutes: number
  contextTargetTokens: number
  theme: ThemePref
  modelRoles: ModelRoleMap
  /** Opt-in to seeing models that write explicit content without refusing. */
  showUnfilteredModels: boolean
  /** Appearance overrides on top of the active theme; null = theme's value. */
  editorFontFamily: string | null
  editorFontSize: number | null
  editorLineHeight: number | null
  editorMeasure: number | null
}

export async function readPrefs(): Promise<Prefs> {
  const state = await readAppState()
  const interval = state.prefs?.snapshotIntervalMinutes ?? 0
  const contextTarget = state.prefs?.contextTargetTokens ?? 0
  const theme = state.prefs?.theme
  const storedRoles = state.prefs?.modelRoles ?? {}
  return {
    autoCodex: state.prefs?.autoCodex ?? true,
    snapshotOnBlur: state.prefs?.snapshotOnBlur ?? true,
    snapshotIntervalMinutes: (SNAPSHOT_INTERVALS as readonly number[]).includes(interval)
      ? interval
      : 0,
    contextTargetTokens: (CONTEXT_TARGETS as readonly number[]).includes(contextTarget)
      ? contextTarget
      : 0,
    theme: ThemePrefSchema.safeParse(theme).success ? (theme as ThemePref) : 'dark',
    modelRoles: Object.fromEntries(
      MODEL_ROLES.map((role) => [role, storedRoles[role] ?? null])
    ) as ModelRoleMap,
    showUnfilteredModels: state.prefs?.showUnfilteredModels ?? false,
    editorFontFamily: coerce(EditorFontFamilySchema, state.prefs?.editorFontFamily),
    editorFontSize: coerce(EditorFontSizeSchema, state.prefs?.editorFontSize),
    editorLineHeight: coerce(EditorLineHeightSchema, state.prefs?.editorLineHeight),
    editorMeasure: coerce(EditorMeasureSchema, state.prefs?.editorMeasure)
  }
}

/** Stored values are whatever the file says; invalid ones fall back to null. */
function coerce<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown): T | null {
  const result = schema.safeParse(value ?? null)
  return result.success ? (result.data as T) : null
}

export async function writePrefs(
  update: Partial<Omit<Prefs, 'modelRoles'>> & { modelRoles?: Partial<ModelRoleMap> }
): Promise<Prefs> {
  const state = await readAppState()
  const current = await readPrefs()
  const next: Prefs = {
    ...current,
    ...update,
    modelRoles: { ...current.modelRoles, ...update.modelRoles }
  }
  // Store compactly: only roles that are actually assigned.
  const storedRoles: Record<string, string> = {}
  for (const role of MODEL_ROLES) {
    const id = next.modelRoles[role]
    if (id) storedRoles[role] = id
  }
  await writeAppState({ ...state, prefs: { ...next, modelRoles: storedRoles } })
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

function statePath(dir: string = app.getPath('userData')): string {
  return join(dir, 'app-state.json')
}

/** userData dir under the app's original name; may linger from before the rename. */
export function legacyUserDataDir(): string {
  return join(dirname(app.getPath('userData')), 'pandoras-box')
}

/**
 * Absolute model paths in app-state.json can still point into the legacy
 * "pandoras-box" userData dir after migrateLegacyUserData() moves the files,
 * because the state file predates the rename. Rewrites localModels paths and
 * novelModels ids whose file now lives under the new userData dir, keeps ones
 * whose file never moved, and drops ones whose file is gone entirely so a
 * stale registry cannot fail model listings or pipeline runs. Synchronous so
 * it finishes during startup before any IPC handler reads state; a no-op once
 * nothing references the legacy dir.
 */
export function migrateLegacyStatePaths(
  newDir: string = app.getPath('userData'),
  oldDir: string = legacyUserDataDir()
): { rewritten: number; dropped: number } {
  const result = { rewritten: 0, dropped: 0 }
  const file = statePath(newDir)
  let state: Partial<AppState>
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppState>
  } catch {
    return result
  }

  const oldPrefix = oldDir + sep
  type Verdict = { action: 'keep' } | { action: 'rewrite'; path: string } | { action: 'drop' }
  const inspect = (path: string): Verdict => {
    if (!path.startsWith(oldPrefix)) return { action: 'keep' }
    const candidate = join(newDir, path.slice(oldPrefix.length))
    if (existsSync(candidate)) return { action: 'rewrite', path: candidate }
    // The file move is skipped when the destination already exists, so the
    // old location can still be the live one.
    if (existsSync(path)) return { action: 'keep' }
    return { action: 'drop' }
  }

  let changed = false

  if (Array.isArray(state.localModels)) {
    const kept: NonNullable<AppState['localModels']> = []
    for (const model of state.localModels) {
      const verdict = inspect(model.path)
      if (verdict.action === 'drop') {
        result.dropped++
        changed = true
        continue
      }
      const path = verdict.action === 'rewrite' ? verdict.path : model.path
      if (kept.some((m) => m.path === path)) {
        // The model was re-imported at the new location after the rename, so
        // the rewritten entry is a duplicate.
        result.dropped++
        changed = true
        continue
      }
      if (verdict.action === 'rewrite') {
        result.rewritten++
        changed = true
      }
      kept.push({ ...model, path })
    }
    state.localModels = kept
  }

  if (state.novelModels && typeof state.novelModels === 'object') {
    for (const [novelDir, modelId] of Object.entries(state.novelModels)) {
      const verdict = inspect(modelId)
      if (verdict.action === 'rewrite') {
        state.novelModels[novelDir] = verdict.path
        result.rewritten++
        changed = true
      } else if (verdict.action === 'drop') {
        delete state.novelModels[novelDir]
        result.dropped++
        changed = true
      }
    }
  }

  if (changed) {
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
    logInfo(
      'app',
      `migrated legacy model paths in app-state.json (rewrote ${result.rewritten}, dropped ${result.dropped})`
    )
  }
  return result
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
