import { create } from 'zustand'
import type { NovelState } from '@shared/schemas/project'

interface ProjectStore {
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
  /** Append streamed text to the buffer (dirty; autosave picks it up). */
  appendContent: (text: string) => void
  closeNovel: () => void
  openChapter: (file: string) => Promise<void>
  setContent: (content: string) => void
  saveActiveChapter: () => Promise<void>
  createChapter: (title: string) => Promise<void>
  renameChapter: (file: string, newTitle: string) => Promise<void>
  moveChapter: (file: string, direction: -1 | 1) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  novel: null,
  activeFile: null,
  content: '',
  dirty: false,
  lastError: null,

  setError: (message) => set({ lastError: message }),

  setNovel: (novel) => set({ novel, activeFile: null, content: '', dirty: false }),

  applyNovelState: (novel) => set({ novel }),

  setSavedContent: (content) => set({ content, dirty: false }),

  appendContent: (text) => set((s) => ({ content: s.content + text, dirty: true })),

  closeNovel: () => set({ novel: null, activeFile: null, content: '', dirty: false }),

  openChapter: async (file) => {
    const { novel, dirty, activeFile } = get()
    if (!novel) return
    if (dirty && activeFile) await get().saveActiveChapter()
    const result = await window.pandora.invoke('chapter:read', { novelDir: novel.dir, file })
    if (result.ok) {
      set({ activeFile: file, content: result.data.content, dirty: false })
    } else {
      set({ lastError: result.error.message })
    }
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
      set({ novel: result.data })
      if (activeFile === file) {
        const renamed = result.data.manifest.chapters.find((c) => c.title === newTitle)
        if (renamed && renamed.file !== file) set({ activeFile: renamed.file })
      }
    } else {
      set({ lastError: result.error.message })
    }
  },

  moveChapter: async (file, direction) => {
    const { novel } = get()
    if (!novel) return
    const files = novel.manifest.chapters.map((c) => c.file)
    const idx = files.indexOf(file)
    const target = idx + direction
    if (idx < 0 || target < 0 || target >= files.length) return
    ;[files[idx], files[target]] = [files[target]!, files[idx]!]
    const result = await window.pandora.invoke('chapter:reorder', {
      novelDir: novel.dir,
      orderedFiles: files
    })
    if (result.ok) set({ novel: result.data })
    else set({ lastError: result.error.message })
  }
}))
