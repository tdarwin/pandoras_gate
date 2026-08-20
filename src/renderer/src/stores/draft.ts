import { create } from 'zustand'
import { onIpcEvent } from '../lib/events'
import { useProjectStore } from './project'
import { useChatStore } from './chat'

/**
 * AI chapter drafting. The draft store OWNS the streamed text (`draftContent`)
 * and writes it to the draft's own chapter file — the editor buffer merely
 * mirrors it while that chapter is open. This keeps navigation free during a
 * draft: switching chapters can never splice AI prose into the wrong file.
 */

interface DraftStore {
  drafting: boolean
  requestId: string | null
  /** The chapter the draft streams into — fixed for the draft's lifetime. */
  draftFile: string | null
  /** The full text of the draft chapter, including streamed prose so far. */
  draftContent: string
  /** Transient progress line (e.g. queued behind another generation). */
  status: string | null
  error: string | null

  init: () => void
  start: (instructions?: string, chapterFile?: string) => Promise<void>
  stop: () => Promise<void>
}

let initialized = false

/** Runs `fn` once the chat stream is idle (immediately if it already is). */
function whenChatIdle(fn: () => void): void {
  if (!useChatStore.getState().streaming) {
    fn()
    return
  }
  const unsubscribe = useChatStore.subscribe((state) => {
    if (!state.streaming) {
      unsubscribe()
      fn()
    }
  })
}

/* Throttled quiet persistence of the draft to ITS file (crash safety). */
let writeTimer: number | null = null

async function writeDraftToDisk(): Promise<void> {
  const { draftFile, draftContent } = useDraftStore.getState()
  const novel = useProjectStore.getState().novel
  if (!novel || !draftFile) return
  await window.pandora.invoke('chapter:write', {
    novelDir: novel.dir,
    file: draftFile,
    content: draftContent
  })
}

function scheduleDraftWrite(): void {
  if (writeTimer !== null) return
  writeTimer = window.setTimeout(() => {
    writeTimer = null
    void writeDraftToDisk()
  }, 800)
}

function cancelDraftWrite(): void {
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer)
    writeTimer = null
  }
}

/**
 * Final bookkeeping against the DRAFT's file, wherever the author is now:
 * flush the text, optionally commit it as the ai-draft milestone, and clear.
 */
async function finalizeDraft(commit: boolean): Promise<void> {
  cancelDraftWrite()
  const { draftFile, draftContent } = useDraftStore.getState()
  const project = useProjectStore.getState()
  const novel = project.novel
  if (!novel || !draftFile) return
  await writeDraftToDisk()
  if (commit) {
    await window.pandora.invoke('draft:finish', { novelDir: novel.dir, chapterFile: draftFile })
  }
  if (project.activeFile === draftFile) project.setSavedContent(draftContent)
  useDraftStore.setState({ draftFile: null, draftContent: '' })
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafting: false,
  requestId: null,
  draftFile: null,
  draftContent: '',
  status: null,
  error: null,

  init: () => {
    if (initialized) return
    initialized = true
    // The chat agent's draft_chapter tool: begin once its reply finishes.
    // Only ONE pending request is kept (latest wins) and only one idle-watcher
    // runs — a runaway agent calling draft_chapter repeatedly must not queue
    // a stampede of drafts that all fire when the chat stops.
    let pendingDraft: { chapterFile: string; instructions: string } | null = null
    let watching = false
    onIpcEvent('draft:requested', (payload) => {
      pendingDraft = payload
      if (watching) return
      watching = true
      whenChatIdle(() => {
        watching = false
        const p = pendingDraft
        pendingDraft = null
        if (p) void get().start(p.instructions || undefined, p.chapterFile)
      })
    })
    // Returning to the draft chapter mid-draft: the store is the source of
    // truth, so overwrite whatever (possibly ≤800 ms stale) disk read the
    // chapter switch just loaded into the buffer.
    useProjectStore.subscribe((state, prev) => {
      const { drafting, draftFile, draftContent } = get()
      if (!drafting || !draftFile) return
      if (state.activeFile === draftFile && prev.activeFile !== draftFile) {
        state.setSavedContent(draftContent)
      }
    })
    onIpcEvent('chat:event', ({ requestId, event }) => {
      if (requestId !== get().requestId) return
      switch (event.type) {
        case 'delta': {
          const { draftFile, draftContent } = get()
          if (!draftFile) return
          const next = draftContent + event.text
          set({ draftContent: next, status: null })
          // Mirror into the editor only when the draft's chapter is open.
          const project = useProjectStore.getState()
          if (project.activeFile === draftFile) project.setSavedContent(next)
          scheduleDraftWrite()
          break
        }
        case 'status':
          set({ status: event.text })
          break
        case 'done':
          set({ drafting: false, requestId: null, status: null })
          void finalizeDraft(true)
          break
        case 'error':
          set({ drafting: false, requestId: null, status: null, error: event.message })
          // Keep the partial prose on disk; the milestone commit can wait for
          // the author's next explicit save.
          void finalizeDraft(false)
          break
        case 'usage':
          break
      }
    })
  },

  start: async (instructions, chapterFile) => {
    let project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const { novel } = project
    if (!novel || get().drafting) return

    // Agent-initiated drafts may target a chapter that isn't open yet.
    if (chapterFile && chapterFile !== project.activeFile) {
      await project.openChapter(chapterFile)
      project = useProjectStore.getState()
    }
    const activeFile = project.activeFile
    if (!activeFile?.startsWith('chapters/')) return

    const model = chat.modelForRole('drafting')
    if (!model) {
      set({ error: 'Pick a model in the chat panel first.' })
      return
    }

    get().init()
    await project.snapshotActiveChapter()

    const requestId = crypto.randomUUID()
    set({ drafting: true, requestId, draftFile: activeFile, draftContent: '', error: null })

    const result = await window.pandora.invoke('draft:start', {
      requestId,
      novelDir: novel.dir,
      chapterFile: activeFile,
      provider: model.provider,
      modelId: model.id,
      contextTokens: model.contextLength,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      conversationId: chat.conversationId
    })
    if (result.ok) {
      // Draft text starts from the on-disk file (frontmatter has ai-draft status).
      set({ draftContent: result.data.content })
      project.applyNovelState(result.data.novel)
      project.setSavedContent(result.data.content)
    } else {
      set({ drafting: false, requestId: null, draftFile: null, error: result.error.message })
    }
  },

  stop: async () => {
    const { requestId } = get()
    if (!requestId) return
    await window.pandora.invoke('chat:cancel', { requestId })
    set({ drafting: false, requestId: null, status: null })
    await finalizeDraft(true)
  }
}))
