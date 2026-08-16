import { create } from 'zustand'
import { MODEL_ROLES, type ModelRole, type ModelRoleMap } from '@shared/llm/catalog'

export type SnapshotInterval = 0 | 5 | 10 | 15 | 20
/** 0 = automatic. */
export type ContextTarget = 0 | 8192 | 16384 | 32768
export type ThemePref = 'dark' | 'light' | 'system'

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
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const result = await window.pandora.invoke('prefs:get', undefined)
    if (result.ok) set({ ...result.data, loaded: true })
  },

  update: async (patch) => {
    // Optimistic update; the response replaces it with the canonical state.
    set((s) => ({
      ...patch,
      modelRoles: { ...s.modelRoles, ...patch.modelRoles }
    }))
    const result = await window.pandora.invoke('prefs:set', patch)
    if (result.ok) set(result.data)
  }
}))
