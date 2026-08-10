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
  start: (instructions?: string) => Promise<void>
  stop: () => Promise<void>
}

let initialized = false

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafting: false,
  requestId: null,
  draftFile: null,
  error: null,

  init: () => {
    if (initialized) return
    initialized = true
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

  start: async (instructions) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const { novel, activeFile } = project
    if (!novel || !activeFile?.startsWith('chapters/') || get().drafting) return
    const model = chat.models.find((m) => m.id === chat.selectedModelId)
    if (!model) {
      set({ error: 'Pick a model in the chat panel first.' })
      return
    }

    get().init()
    await project.saveActiveChapter()

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
