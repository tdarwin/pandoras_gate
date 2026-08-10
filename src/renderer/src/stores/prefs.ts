import { create } from 'zustand'

interface PrefsStore {
  autoStoryBible: boolean
  snapshotOnBlur: boolean
  loaded: boolean
  init: () => Promise<void>
  update: (patch: { autoStoryBible?: boolean; snapshotOnBlur?: boolean }) => Promise<void>
}

export const usePrefsStore = create<PrefsStore>((set, get) => ({
  autoStoryBible: true,
  snapshotOnBlur: true,
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
