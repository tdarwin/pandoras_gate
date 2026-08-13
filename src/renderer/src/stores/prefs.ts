import { create } from 'zustand'

export type SnapshotInterval = 0 | 5 | 10 | 15 | 20
/** 0 = automatic. */
export type ContextTarget = 0 | 8192 | 16384 | 32768
export type ThemePref = 'dark' | 'light' | 'system'

interface PrefsStore {
  autoStoryBible: boolean
  snapshotOnBlur: boolean
  snapshotIntervalMinutes: number
  contextTargetTokens: number
  theme: ThemePref
  loaded: boolean
  init: () => Promise<void>
  update: (patch: {
    autoStoryBible?: boolean
    snapshotOnBlur?: boolean
    snapshotIntervalMinutes?: SnapshotInterval
    contextTargetTokens?: ContextTarget
    theme?: ThemePref
  }) => Promise<void>
}

export const usePrefsStore = create<PrefsStore>((set, get) => ({
  autoStoryBible: true,
  snapshotOnBlur: true,
  snapshotIntervalMinutes: 0,
  contextTargetTokens: 0,
  theme: 'dark',
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const result = await window.pandora.invoke('prefs:get', undefined)
    if (result.ok) set({ ...result.data, loaded: true })
  },

  update: async (patch) => {
    set(patch)
    const result = await window.pandora.invoke('prefs:set', patch)
    if (result.ok) set(result.data)
  }
}))
