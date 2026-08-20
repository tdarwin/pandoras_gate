import { create } from 'zustand'
import { MODEL_ROLES, type ModelRole, type ModelRoleMap } from '@shared/llm/catalog'
import type { SnapshotInterval, ContextTarget, ThemePref } from '@shared/prefs'
import { useProjectStore } from './project'

export type { SnapshotInterval, ContextTarget, ThemePref }
export type { ModelRole, ModelRoleMap }

const NO_ROLES = Object.fromEntries(MODEL_ROLES.map((r) => [r, null])) as ModelRoleMap

interface PrefsStore {
  autoCodex: boolean
  snapshotOnBlur: boolean
  snapshotIntervalMinutes: number
  contextTargetTokens: number
  theme: ThemePref
  modelRoles: ModelRoleMap
  showUnfilteredModels: boolean
  /** Appearance overrides on top of the active theme; null = theme's value. */
  editorFontFamily: string | null
  editorFontSize: number | null
  editorLineHeight: number | null
  editorMeasure: number | null
  loaded: boolean
  init: () => Promise<void>
  update: (patch: {
    autoCodex?: boolean
    snapshotOnBlur?: boolean
    snapshotIntervalMinutes?: SnapshotInterval
    contextTargetTokens?: ContextTarget
    theme?: ThemePref
    modelRoles?: Partial<ModelRoleMap>
    showUnfilteredModels?: boolean
    editorFontFamily?: string | null
    editorFontSize?: number | null
    editorLineHeight?: number | null
    editorMeasure?: number | null
  }) => Promise<void>
}

export const usePrefsStore = create<PrefsStore>((set, get) => ({
  autoCodex: true,
  snapshotOnBlur: true,
  snapshotIntervalMinutes: 0,
  contextTargetTokens: 0,
  theme: 'dark',
  modelRoles: NO_ROLES,
  showUnfilteredModels: false,
  editorFontFamily: null,
  editorFontSize: null,
  editorLineHeight: null,
  editorMeasure: null,
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const result = await window.pandora.invoke('prefs:get', undefined)
    if (result.ok) set({ ...result.data, loaded: true })
  },

  update: async (patch) => {
    // Optimistic update; the response replaces it with the canonical state.
    // A failed write rolls back — otherwise the UI shows a value that was
    // never persisted and silently reverts on the next launch.
    const s = get()
    const before = {
      autoCodex: s.autoCodex,
      snapshotOnBlur: s.snapshotOnBlur,
      snapshotIntervalMinutes: s.snapshotIntervalMinutes,
      contextTargetTokens: s.contextTargetTokens,
      theme: s.theme,
      modelRoles: s.modelRoles,
      showUnfilteredModels: s.showUnfilteredModels,
      editorFontFamily: s.editorFontFamily,
      editorFontSize: s.editorFontSize,
      editorLineHeight: s.editorLineHeight,
      editorMeasure: s.editorMeasure
    }
    set((cur) => ({
      ...patch,
      modelRoles: { ...cur.modelRoles, ...patch.modelRoles }
    }))
    const fail = (message: string): void => {
      set(before)
      useProjectStore.getState().setError(`Couldn't save that preference — ${message}`)
    }
    try {
      const result = await window.pandora.invoke('prefs:set', patch)
      if (result.ok) set(result.data)
      else fail(result.error.message)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }
}))
