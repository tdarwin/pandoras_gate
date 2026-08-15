import { create } from 'zustand'
import { parseFrontmatter, serializeFrontmatter } from '@shared/frontmatter'
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

/**
 * Tracked-changes review session: the editor shows the PROPOSED body with
 * suggestions against the on-disk content; frontmatter is chosen wholesale
 * (proposed vs current) alongside.
 */
export interface InlineReview {
  proposalId: string
  path: string
  /** Current on-disk file content (raw, incl. frontmatter). */
  originalRaw: string
  /** Proposed file content (raw, incl. frontmatter). */
  proposedRaw: string
  /** Live body markdown — starts as the proposal's body, tracks edits/rejects. */
  bodyBuffer: string
  fmChoice: 'proposed' | 'current'
  rationale: string
  sourceTitle: string
}

interface ProposalsStore {
  proposals: ReviewProposal[]
  running: boolean
  /** Live phase text while a pipeline run is in flight. */
  runningStatus: string | null
  lastRunStatus: string | null
  error: string | null
  review: InlineReview | null

  init: () => void
  pendingCount: () => number
  enterReview: (proposalId: string, path: string) => void
  updateReviewBody: (body: string) => void
  setReviewFmChoice: (choice: 'proposed' | 'current') => void
  applyReview: () => Promise<void>
  rejectReview: () => Promise<void>
  exitReview: () => void
  refresh: () => Promise<void>
  runForActiveChapter: (opts?: { silent?: boolean }) => Promise<void>
  generateOutline: (scope: 'novel' | 'chapter', guidance?: string) => Promise<void>
  /** Editing pass over the active chapter or the whole novel. */
  runReview: (
    reviewType: 'proofread' | 'copy-edit' | 'developmental' | 'fact-check',
    scope: 'chapter' | 'novel',
    guidance?: string
  ) => Promise<void>
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
  runningStatus: null,
  lastRunStatus: null,
  error: null,
  review: null,

  init: () => {
    if (subscribed) return
    subscribed = true
    // The chat agent's tools create proposals out-of-band; refresh on notify.
    window.pandora.on('proposals:changed', () => void get().refresh())
    window.pandora.on('pipeline:status', (raw) => {
      const { text } = raw as { text: string }
      set({ runningStatus: text })
    })
  },

  enterReview: (proposalId, path) => {
    const proposal = get().proposals.find((p) => p.id === proposalId)
    const item = proposal?.items.find((i) => i.path === path)
    if (!proposal || !item) return
    set({
      review: {
        proposalId,
        path,
        originalRaw: item.currentContent,
        proposedRaw: item.newContent,
        bodyBuffer: parseFrontmatter(item.newContent).body,
        fmChoice: 'proposed',
        rationale: item.rationale,
        sourceTitle: proposal.chapterTitle
      }
    })
  },

  updateReviewBody: (body) =>
    set((s) => (s.review ? { review: { ...s.review, bodyBuffer: body } } : {})),

  setReviewFmChoice: (choice) =>
    set((s) => (s.review ? { review: { ...s.review, fmChoice: choice } } : {})),

  applyReview: async () => {
    const { review } = get()
    if (!review) return
    // The body buffer already reflects per-chunk rejections and edits.
    const data =
      review.fmChoice === 'current'
        ? parseFrontmatter(review.originalRaw).data
        : parseFrontmatter(review.proposedRaw).data
    const content = serializeFrontmatter({ data, body: review.bodyBuffer })
    await get().resolve(review.proposalId, review.path, 'accept', content)
    set({ review: null })
    const project = useProjectStore.getState()
    if (/^(chapters|metadata|outlines)\//.test(review.path)) {
      await project.openChapter(review.path)
    }
  },

  rejectReview: async () => {
    const { review } = get()
    if (!review) return
    await get().resolve(review.proposalId, review.path, 'reject')
    set({ review: null })
  },

  exitReview: () => set({ review: null }),

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
    const model = chat.modelForRole('codex')
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
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran'
            ? `${result.data.itemCount} suggestion${result.data.itemCount === 1 ? '' : 's'}`
            : result.data.status === 'no-changes'
              ? 'Codex already up to date'
              : null
      })
      await get().refresh()
    } else {
      set({ running: false, runningStatus: null, ...(opts?.silent ? {} : { error: result.error.message }) })
    }
  },

  generateOutline: async (scope, guidance) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    if (!novel || get().running) return
    const model = chat.modelForRole('drafting')
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
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran' ? 'Outline ready for review' : 'No outline changes suggested'
      })
      await get().refresh()
    } else {
      set({ running: false, runningStatus: null, error: result.error.message })
    }
  },

  runReview: async (reviewType, scope, guidance) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    if (!novel || get().running) return
    if (scope === 'chapter' && !project.activeFile?.startsWith('chapters/')) return
    // Line edits use the copy-editing model; reports the developmental one.
    const role =
      reviewType === 'proofread' || reviewType === 'copy-edit' ? 'copyEdit' : 'developmental'
    const model = chat.modelForRole(role)
    if (!model) {
      set({ error: 'Pick a model in the chat panel first.' })
      return
    }

    await project.snapshotActiveChapter()
    set({ running: true, error: null, lastRunStatus: null })
    const result = await window.pandora.invoke('review:run', {
      novelDir: novel.dir,
      scope,
      ...(scope === 'chapter' ? { chapterFile: project.activeFile! } : {}),
      reviewType,
      ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
      provider: model.provider,
      modelId: model.id
    })
    if (result.ok) {
      const isReport = reviewType === 'developmental' || reviewType === 'fact-check'
      set({
        running: false,
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran'
            ? isReport
              ? 'Report ready for review'
              : `${result.data.itemCount} chapter${result.data.itemCount === 1 ? '' : 's'} with edits`
            : 'Nothing to change'
      })
      await get().refresh()
    } else {
      set({ running: false, runningStatus: null, error: result.error.message })
    }
  },

  resolve: async (proposalId, path, resolution, editedContent) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return
    const result = await window.pandora.invoke('proposals:resolve', {
      novelDir: novel.dir,
      proposalId,
      path,
      resolution,
      ...(editedContent !== undefined ? { editedContent } : {})
    })
    if (result.ok) {
      // Accepting an edit to the open document must refresh the editor buffer.
      if (resolution === 'accept' && path === project.activeFile) {
        const read = await window.pandora.invoke('chapter:read', { novelDir: novel.dir, file: path })
        if (read.ok) project.setSavedContent(read.data.content)
      }
      await get().refresh()
    } else {
      set({ error: result.error.message })
    }
  }
}))
