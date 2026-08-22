import { create } from 'zustand'
import type { NovelState } from '@shared/schemas/project'
import { onIpcEvent } from '../lib/events'

let subscribed = false

/**
 * Set by the proposals store. A document with suggestions pending must be
 * saved by RECORDING decisions, not by writing the buffer over the stored
 * proposals — but every save path (autosave, blur, the interval snapshot, ⌘S,
 * switching chapters, closing the novel) goes through the two functions below,
 * so the choice belongs here rather than at each call site.
 *
 * Injected rather than imported to keep the dependency one-way: the proposals
 * store already reads this one.
 *
 * Returns false when it did not handle the write — fall back to the ordinary
 * path, because a refused decision must never cost the author their typing.
 */
type SuggestionWriter = (file: string, content: string, snapshot: boolean) => Promise<boolean>
let suggestionWriter: SuggestionWriter | null = null
export function setSuggestionWriter(fn: SuggestionWriter): void {
  suggestionWriter = fn
}

/**
 * Told what the file says after an ordinary write, so a suggestion overlay
 * that just refused a decision is re-anchored to what actually landed rather
 * than to what was there before the fallback.
 */
type CurrentSink = (file: string, content: string) => void
let currentSink: CurrentSink | null = null
export function setCurrentSink(fn: CurrentSink): void {
  currentSink = fn
}

/** Called on close/switch so nothing from one novel leaks into the next. */
type NovelReset = () => void
const novelResets: NovelReset[] = []
export function onNovelChange(fn: NovelReset): void {
  novelResets.push(fn)
}
function resetForNovelChange(): void {
  for (const fn of novelResets) fn()
}

/**
 * Marks the buffer saved — but only the buffer that was actually written.
 *
 * A save is asynchronous, and anything typed while it was in flight is still
 * unsaved. Clearing the flag regardless left those keystrokes behind a "saved"
 * indicator with no autosave scheduled, since the quiet 5 s write only runs on
 * a dirty buffer: exactly the crash window autosave exists to close.
 */
function settle(
  set: (partial: Partial<ProjectStore>) => void,
  get: () => ProjectStore,
  written: string
): void {
  if (get().content === written) set({ dirty: false })
}

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
    onIpcEvent('novel:updated', (novel) => {
      // Only adopt updates for the novel that's actually open.
      if (get().novel?.dir === novel.dir) set({ novel })
    })
  },

  setError: (message) => set({ lastError: message }),

  setNovel: (novel) => {
    // Chat transcripts, drafting state, and pending-suggestion overlays belong
    // to the novel they came from. Workspace stays mounted across
    // File → Open Recent, so without this, novel A's conversation gets sent as
    // history for novel B and A's suggestions render over B's documents.
    resetForNovelChange()
    set({ novel, activeFile: null, content: '', dirty: false })
  },

  applyNovelState: (novel) => set({ novel }),

  setSavedContent: (content) => set({ content, dirty: false }),


  closeNovel: async () => {
    // Every caller must get the snapshot — the sidebar ✕ used to skip it and
    // dropped up to 5 s of typing.
    await get().snapshotActiveChapter()
    resetForNovelChange()
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

  // A write that changes nothing is not an edit. The editor emits its
  // serialized document once at creation, and treating that as a change made
  // every file dirty the moment it was opened — so merely LOOKING at a chapter
  // queued an autosave that rewrote it.
  setContent: (content) =>
    set((s) => (s.content === content ? {} : { content, dirty: true })),

  saveActiveChapter: async () => {
    const { novel, activeFile, content, dirty } = get()
    if (!novel || !activeFile || !dirty) return
    if (await suggestionWriter?.(activeFile, content, false)) {
      settle(set, get, content)
      return
    }
    const result = await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: activeFile,
      content
    })
    if (result.ok) {
      settle(set, get, content)
      currentSink?.(activeFile, content)
    } else set({ lastError: result.error.message })
  },

  snapshotActiveChapter: async () => {
    const { novel, activeFile, content } = get()
    if (!novel || !activeFile) return
    if (await suggestionWriter?.(activeFile, content, true)) {
      settle(set, get, content)
      return
    }
    // Always write+snapshot: commits are no-ops when nothing changed, and
    // this also sweeps up earlier quiet writes into a history entry.
    const result = await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: activeFile,
      content,
      snapshot: true
    })
    if (result.ok) {
      settle(set, get, content)
      currentSink?.(activeFile, content)
    } else set({ lastError: result.error.message })
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
