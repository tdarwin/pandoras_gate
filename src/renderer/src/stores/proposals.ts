import { create } from 'zustand'
import { useProjectStore } from './project'
import { useChatStore } from './chat'

export interface ReviewItem {
  path: string
  action: 'create' | 'update'
  newContent: string
  rationale: string
  baseHash: string
  currentContent: string
  conflict: boolean
}

export interface ReviewProposal {
  id: string
  chapterFile: string
  chapterTitle: string
  createdAt: number
  items: ReviewItem[]
}

interface ProposalsStore {
  proposals: ReviewProposal[]
  running: boolean
  lastRunStatus: string | null
  error: string | null

  init: () => void
  pendingCount: () => number
  refresh: () => Promise<void>
  runForActiveChapter: (opts?: { silent?: boolean }) => Promise<void>
  generateOutline: (scope: 'novel' | 'chapter', guidance?: string) => Promise<void>
  resolve: (
    proposalId: string,
    path: string,
    resolution: 'accept' | 'reject',
    editedContent?: string
  ) => Promise<void>
}

let subscribed = false

export const useProposalsStore = create<ProposalsStore>((set, get) => ({
  proposals: [],
  running: false,
  lastRunStatus: null,
  error: null,

  init: () => {
    if (subscribed) return
    subscribed = true
    // The chat agent's tools create proposals out-of-band; refresh on notify.
    window.pandora.on('proposals:changed', () => void get().refresh())
  },

  pendingCount: () => get().proposals.reduce((n, p) => n + p.items.length, 0),

  refresh: async () => {
    const novel = useProjectStore.getState().novel
    if (!novel) {
      set({ proposals: [] })
      return
    }
    const result = await window.pandora.invoke('proposals:review', { novelDir: novel.dir })
    if (result.ok) set({ proposals: result.data.proposals })
  },

  runForActiveChapter: async (opts) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    const file = project.activeFile
    if (!novel || !file || !file.startsWith('chapters/') || get().running) return
    const model = chat.models.find((m) => m.id === chat.selectedModelId)
    if (!model) {
      if (!opts?.silent) set({ error: 'Pick a model in the chat panel first.' })
      return
    }

    // Snapshot first so chapter edits and metadata changes stay separate commits.
    await project.snapshotActiveChapter()
    set({ running: true, error: null, lastRunStatus: null })
    const result = await window.pandora.invoke('proposals:run', {
      novelDir: novel.dir,
      chapterFile: file,
      provider: model.provider,
      modelId: model.id
    })
    if (result.ok) {
      set({
        running: false,
        lastRunStatus:
          result.data.status === 'ran'
            ? `${result.data.itemCount} suggestion${result.data.itemCount === 1 ? '' : 's'}`
            : result.data.status === 'no-changes'
              ? 'Codex already up to date'
              : null
      })
      await get().refresh()
    } else {
      set({ running: false, ...(opts?.silent ? {} : { error: result.error.message }) })
    }
  },

  generateOutline: async (scope, guidance) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    if (!novel || get().running) return
    const model = chat.models.find((m) => m.id === chat.selectedModelId)
    if (!model) {
      set({ error: 'Pick a model in the chat panel first.' })
      return
    }
    if (scope === 'chapter' && !project.activeFile?.startsWith('chapters/')) return

    await project.snapshotActiveChapter()
    set({ running: true, error: null, lastRunStatus: null })
    const result = await window.pandora.invoke('outlines:generate', {
      novelDir: novel.dir,
      scope,
      ...(scope === 'chapter' ? { chapterFile: project.activeFile! } : {}),
      ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
      provider: model.provider,
      modelId: model.id
    })
    if (result.ok) {
      set({
        running: false,
        lastRunStatus:
          result.data.status === 'ran' ? 'Outline ready for review' : 'No outline changes suggested'
      })
      await get().refresh()
    } else {
      set({ running: false, error: result.error.message })
    }
  },

  resolve: async (proposalId, path, resolution, editedContent) => {
    const novel = useProjectStore.getState().novel
    if (!novel) return
    const result = await window.pandora.invoke('proposals:resolve', {
      novelDir: novel.dir,
      proposalId,
      path,
      resolution,
      ...(editedContent !== undefined ? { editedContent } : {})
    })
    if (result.ok) await get().refresh()
    else set({ error: result.error.message })
  }
}))
