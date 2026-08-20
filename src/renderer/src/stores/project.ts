import { create } from 'zustand'
import type { NovelState } from '@shared/schemas/project'

let subscribed = false

interface ProjectStore {
  /** One-time event subscriptions (manifest changes made in main). */
  init: () => void
  novel: NovelState | null
  activeFile: string | null
  /** Editor buffer for the active chapter. */
  content: string
  dirty: boolean
  lastError: string | null

  setError: (message: string | null) => void
  setNovel: (novel: NovelState) => void
  /** Replace manifest state without touching the open buffer. */
  applyNovelState: (novel: NovelState) => void
  /** Replace the buffer with on-disk content (not dirty). */
  setSavedContent: (content: string) => void
  /** Snapshots the open buffer, then clears the workspace. */
  closeNovel: () => Promise<void>
  openChapter: (file: string) => Promise<void>
  /**
   * Re-read the ACTIVE file after main rewrote it (restore, status change).
   * Unlike openChapter this never snapshots first — snapshotting would write
   * the stale buffer straight over main's change.
   */
  reloadActiveChapter: () => Promise<void>
  setContent: (content: string) => void
  /** Quiet write to disk (crash safety) — no history entry. */
  saveActiveChapter: () => Promise<void>
  /** Write AND take a history snapshot (⌘S / blur / chapter switch). */
  snapshotActiveChapter: () => Promise<void>
  createChapter: (title: string) => Promise<void>
  renameChapter: (file: string, newTitle: string) => Promise<void>
  reorderChapters: (orderedFiles: string[]) => Promise<void>
  archiveChapter: (file: string) => Promise<void>
  deleteChapter: (file: string) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  novel: null,
  activeFile: null,
  content: '',
  dirty: false,
  lastError: null,

  init: () => {
    if (subscribed) return
    subscribed = true
    window.pandora.on('novel:updated', (raw) => {
      const novel = raw as NovelState
      // Only adopt updates for the novel that's actually open.
      if (get().novel?.dir === novel.dir) set({ novel })
    })
  },

  setError: (message) => set({ lastError: message }),

  setNovel: (novel) => set({ novel, activeFile: null, content: '', dirty: false }),

  applyNovelState: (novel) => set({ novel }),

  setSavedContent: (content) => set({ content, dirty: false }),


  closeNovel: async () => {
    // Every caller must get the snapshot — the sidebar ✕ used to skip it and
    // dropped up to 5 s of typing.
    await get().snapshotActiveChapter()
    set({ novel: null, activeFile: null, content: '', dirty: false })
  },

  openChapter: async (file) => {
    const { novel, activeFile } = get()
    if (!novel) return
    // Leaving a document is a natural save point: snapshot it.
    if (activeFile) await get().snapshotActiveChapter()
    const result = await window.pandora.invoke('chapter:read', { novelDir: novel.dir, file })
    if (result.ok) {
      set({ activeFile: file, content: result.data.content, dirty: false })
    } else {
      set({ lastError: result.error.message })
    }
  },

  reloadActiveChapter: async () => {
    const { novel, activeFile } = get()
    if (!novel || !activeFile) return
    const result = await window.pandora.invoke('chapter:read', { novelDir: novel.dir, file: activeFile })
    if (result.ok) set({ content: result.data.content, dirty: false })
    else set({ lastError: result.error.message })
  },

  setContent: (content) => set({ content, dirty: true }),

  saveActiveChapter: async () => {
    const { novel, activeFile, content, dirty } = get()
    if (!novel || !activeFile || !dirty) return
    const result = await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: activeFile,
      content
    })
    if (result.ok) set({ dirty: false })
    else set({ lastError: result.error.message })
  },

  snapshotActiveChapter: async () => {
    const { novel, activeFile, content } = get()
    if (!novel || !activeFile) return
    // Always write+snapshot: commits are no-ops when nothing changed, and
    // this also sweeps up earlier quiet writes into a history entry.
    const result = await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: activeFile,
      content,
      snapshot: true
    })
    if (result.ok) set({ dirty: false })
    else set({ lastError: result.error.message })
  },

  createChapter: async (title) => {
    const { novel } = get()
    if (!novel) return
    const result = await window.pandora.invoke('chapter:create', { novelDir: novel.dir, title })
    if (result.ok) {
      set({ novel: result.data })
      const created = result.data.manifest.chapters.at(-1)
      if (created) await get().openChapter(created.file)
    } else {
      set({ lastError: result.error.message })
    }
  },

  renameChapter: async (file, newTitle) => {
    const { novel, activeFile } = get()
    if (!novel) return
    const result = await window.pandora.invoke('chapter:rename', {
      novelDir: novel.dir,
      file,
      newTitle
    })
    if (result.ok) {
      set({ novel: result.data.novel })
      // Re-point by the RETURNED path — matching on title used to grab the
      // first chapter with that title and overwrite it on the next save.
      if (activeFile === file && result.data.file !== file) {
        set({ activeFile: result.data.file })
      }
    } else {
      set({ lastError: result.error.message })
    }
  },

  reorderChapters: async (orderedFiles) => {
    const { novel } = get()
    if (!novel) return
    const result = await window.pandora.invoke('chapter:reorder', {
      novelDir: novel.dir,
      orderedFiles
    })
    if (result.ok) set({ novel: result.data })
    else set({ lastError: result.error.message })
  },

  archiveChapter: async (file) => {
    const { novel, activeFile } = get()
    if (!novel) return
    const result = await window.pandora.invoke('chapter:archive', { novelDir: novel.dir, file })
    if (result.ok) {
      set({
        novel: result.data,
        ...(activeFile === file ? { activeFile: null, content: '', dirty: false } : {})
      })
    } else {
      set({ lastError: result.error.message })
    }
  },

  deleteChapter: async (file) => {
    const { novel, activeFile } = get()
    if (!novel) return
    const result = await window.pandora.invoke('chapter:delete', { novelDir: novel.dir, file })
    if (result.ok) {
      set({
        novel: result.data,
        ...(activeFile === file ? { activeFile: null, content: '', dirty: false } : {})
      })
    } else {
      set({ lastError: result.error.message })
    }
  }
}))
