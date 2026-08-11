import { create } from 'zustand'
import type { IpcEventPayload } from '@shared/ipc'
import { useProjectStore } from './project'
import { useChatStore } from './chat'

/**
 * AI chapter drafting: streams model prose into the active chapter's editor
 * buffer. The buffer stays the source of truth — autosave persists it and the
 * main process brackets the draft with commits.
 */

interface DraftStore {
  drafting: boolean
  requestId: string | null
  draftFile: string | null
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

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafting: false,
  requestId: null,
  draftFile: null,
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
    window.pandora.on('draft:requested', (raw) => {
      pendingDraft = raw as { chapterFile: string; instructions: string }
      if (watching) return
      watching = true
      whenChatIdle(() => {
        watching = false
        const p = pendingDraft
        pendingDraft = null
        if (p) void get().start(p.instructions || undefined, p.chapterFile)
      })
    })
    window.pandora.on('chat:event', (raw) => {
      const { requestId, event } = raw as IpcEventPayload<'chat:event'>
      if (requestId !== get().requestId) return
      const project = useProjectStore.getState()
      switch (event.type) {
        case 'delta':
          project.appendContent(event.text)
          break
        case 'done': {
          set({ drafting: false, requestId: null })
          const { novel, activeFile } = project
          void project.saveActiveChapter().then(() => {
            if (novel && activeFile) {
              void window.pandora.invoke('draft:finish', {
                novelDir: novel.dir,
                chapterFile: activeFile
              })
            }
          })
          break
        }
        case 'error':
          set({ drafting: false, requestId: null, error: event.message })
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

    const model = chat.models.find((m) => m.id === chat.selectedModelId)
    if (!model) {
      set({ error: 'Pick a model in the chat panel first.' })
      return
    }

    get().init()
    await project.snapshotActiveChapter()

    const requestId = crypto.randomUUID()
    set({ drafting: true, requestId, draftFile: activeFile, error: null })

    const result = await window.pandora.invoke('draft:start', {
      requestId,
      novelDir: novel.dir,
      chapterFile: activeFile,
      provider: model.provider,
      modelId: model.id,
      contextTokens: model.contextLength,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {})
    })
    if (result.ok) {
      // Buffer now reflects the on-disk file (frontmatter has ai-draft status).
      project.applyNovelState(result.data.novel)
      project.setSavedContent(result.data.content)
    } else {
      set({ drafting: false, requestId: null, error: result.error.message })
    }
  },

  stop: async () => {
    const { requestId } = get()
    if (!requestId) return
    await window.pandora.invoke('chat:cancel', { requestId })
    set({ drafting: false, requestId: null })
    const project = useProjectStore.getState()
    const { novel, activeFile } = project
    await project.saveActiveChapter()
    if (novel && activeFile) {
      await window.pandora.invoke('draft:finish', { novelDir: novel.dir, chapterFile: activeFile })
    }
  }
}))
