import { create } from 'zustand'

export type SnapshotInterval = 0 | 5 | 10 | 15 | 20
/** 0 = automatic. */
export type ContextTarget = 0 | 8192 | 16384 | 32768
export type ThemePref = 'dark' | 'light' | 'system'

/** AI task roles a model can be assigned to; null = use the chat model. */
export type ModelRole = 'drafting' | 'copyEdit' | 'developmental' | 'codex'
export type ModelRoleMap = Record<ModelRole, string | null>

const NO_ROLES: ModelRoleMap = {
  drafting: null,
  copyEdit: null,
  developmental: null,
  codex: null
}

interface PrefsStore {
  autoCodex: boolean
  snapshotOnBlur: boolean
  snapshotIntervalMinutes: number
  contextTargetTokens: number
  theme: ThemePref
  modelRoles: ModelRoleMap
  loaded: boolean
  init: () => Promise<void>
  update: (patch: {
    autoCodex?: boolean
    snapshotOnBlur?: boolean
    snapshotIntervalMinutes?: SnapshotInterval
    contextTargetTokens?: ContextTarget
    theme?: ThemePref
    modelRoles?: Partial<ModelRoleMap>
  }) => Promise<void>
}

export const usePrefsStore = create<PrefsStore>((set, get) => ({
  autoCodex: true,
  snapshotOnBlur: true,
  snapshotIntervalMinutes: 0,
  contextTargetTokens: 0,
  theme: 'dark',
  modelRoles: NO_ROLES,
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
