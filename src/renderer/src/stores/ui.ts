import { create } from 'zustand'

/**
 * App-chrome state shared between the native menu (via menu:action events),
 * the titlebar buttons, and deep components. Signals are counters: a
 * consumer effect runs on every increment, no reset handshake needed.
 */
export type PublishPlatform = 'royalroad' | 'patreon'

interface UiStore {
  showAbout: boolean
  showPrefs: boolean
  /** Bump → ChapterSidebar opens its new-chapter input (mounted receiver). */
  newChapterSignal: number
  /**
   * Consume-once intent for the Welcome screen: 'create' opens the
   * create-novel form; Welcome clears it after acting. An intent (not a
   * counter) because Welcome mounts as a *result* of the menu action.
   */
  welcomeIntent: 'create' | null
  /** Set → Workspace copies the active chapter for the platform. */
  copyForRequest: { seq: number; platform: PublishPlatform } | null
  setShowAbout: (v: boolean) => void
  setShowPrefs: (v: boolean) => void
  signalNewChapter: () => void
  setWelcomeIntent: (v: 'create' | null) => void
  signalCopyFor: (platform: PublishPlatform) => void
}

export const useUiStore = create<UiStore>((set) => ({
  showAbout: false,
  showPrefs: false,
  newChapterSignal: 0,
  welcomeIntent: null,
  copyForRequest: null,
  setShowAbout: (v) => set({ showAbout: v }),
  setShowPrefs: (v) => set({ showPrefs: v }),
  signalNewChapter: () => set((s) => ({ newChapterSignal: s.newChapterSignal + 1 })),
  setWelcomeIntent: (v) => set({ welcomeIntent: v }),
  signalCopyFor: (platform) =>
    set((s) => ({ copyForRequest: { seq: (s.copyForRequest?.seq ?? 0) + 1, platform } }))
}))
