import { create } from 'zustand'
import { parseFrontmatter, serializeFrontmatter } from '@shared/frontmatter'
import { onIpcEvent } from '../lib/events'
import { useProjectStore } from './project'
import { useChatStore } from './chat'
import { useDraftStore } from './draft'

/** A document with suggestions waiting. Bodies are fetched per document, on demand. */
export interface PendingDoc {
  path: string
  action: 'create' | 'update'
  count: number
  /** Proposal titles, for tooltips and aria-labels. */
  sources: string[]
  /** How many of `count` could not be folded in with the others. */
  blocked: number
  /** Display name for a document that does not exist yet. */
  label?: string
}

/**
 * Tracked-changes review session: the editor shows the PROPOSED body with
 * suggestions against the on-disk content; frontmatter is chosen wholesale
 * (proposed vs current) alongside.
 */
export interface InlineReview {
  path: string
  /** The proposals this review folded — the only ones Apply decides. */
  proposalIds: string[]
  /** Current on-disk file content (raw, incl. frontmatter). */
  originalRaw: string
  /** Proposed file content: every pending proposal for this path, folded. */
  proposedRaw: string
  /** Live body markdown — starts as the proposal's body, tracks edits/rejects. */
  bodyBuffer: string
  fmChoice: 'proposed' | 'current'
  rationale: string
  sourceTitle: string
}

interface ProposalsStore {
  /** Every document with something pending, path-ascending. */
  pendingDocs: PendingDoc[]
  pendingTotal: number
  /** True while any pipeline run is in flight (manual or chat-deferred). */
  running: boolean
  /** A manual run (Update Codex / Outline / Review buttons) is awaiting its invoke. */
  manualRunning: boolean
  /** Chat-deferred generation batches currently executing in main. */
  agentRuns: number
  /** Live phase text while a pipeline run is in flight. */
  runningStatus: string | null
  lastRunStatus: string | null
  error: string | null
  review: InlineReview | null

  init: () => void
  enterReview: (path: string) => Promise<void>
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
  /** Accepts or rejects everything pending for one document. */
  resolveDoc: (path: string, resolution: 'accept' | 'reject') => Promise<boolean>
  /** …and for the whole novel. */
  resolveNovel: (resolution: 'accept' | 'reject') => Promise<{ applied: number; skipped: number }>
}

/** Accepting into the chapter an AI draft is streaming into would race the
 *  draft's writer — the author stops the draft first. */
function draftBlocks(path: string): boolean {
  const draft = useDraftStore.getState()
  return draft.drafting && draft.draftFile === path
}

let subscribed = false

export const useProposalsStore = create<ProposalsStore>((set, get) => ({
  pendingDocs: [],
  pendingTotal: 0,
  running: false,
  manualRunning: false,
  agentRuns: 0,
  runningStatus: null,
  lastRunStatus: null,
  error: null,
  review: null,

  init: () => {
    if (subscribed) return
    subscribed = true
    // The chat agent's tools create proposals out-of-band; refresh on notify.
    onIpcEvent('proposals:changed', () => void get().refresh())
    onIpcEvent('pipeline:status', ({ text }) => {
      set({ runningStatus: text })
    })
    // Chat-deferred generations (update_codex etc. run after the reply).
    onIpcEvent('pipeline:run', (payload) => {
      if (payload.phase === 'started') {
        set((s) => ({
          agentRuns: s.agentRuns + 1,
          running: true,
          runningStatus: payload.label,
          lastRunStatus: null
        }))
      } else {
        set((s) => {
          const agentRuns = Math.max(0, s.agentRuns - 1)
          const running = agentRuns > 0 || s.manualRunning
          return {
            agentRuns,
            running,
            runningStatus: running ? s.runningStatus : null,
            lastRunStatus: payload.result ?? s.lastRunStatus,
            ...(payload.error !== undefined ? { error: payload.error } : {})
          }
        })
        void get().refresh()
      }
    })
  },

  enterReview: async (path) => {
    if (draftBlocks(path)) {
      set({ error: 'The AI is drafting into this chapter — stop the draft first.' })
      return
    }
    const novel = useProjectStore.getState().novel
    if (!novel) return
    // Flush the buffer first so the fold happens against what is actually on
    // disk, not a stale read.
    await useProjectStore.getState().saveActiveChapter()
    const folded = await window.pandora.invoke('proposals:forPath', {
      novelDir: novel.dir,
      path
    })
    if (!folded.ok) {
      set({ error: folded.error.message })
      return
    }
    const last = folded.data.chain[folded.data.chain.length - 1]
    if (!last) {
      set({ error: 'These suggestions no longer apply to this document.' })
      await get().refresh()
      return
    }
    set({
      review: {
        path,
        proposalIds: folded.data.chain.map((l) => l.proposalId),
        originalRaw: folded.data.current,
        proposedRaw: last.content,
        bodyBuffer: parseFrontmatter(last.content).body,
        fmChoice: 'proposed',
        rationale: folded.data.chain.map((l) => l.rationale).join(' · '),
        sourceTitle: [...new Set(folded.data.chain.map((l) => l.sourceTitle))].join(', ')
      }
    })
  },

  updateReviewBody: (body) =>
    set((s) => (s.review ? { review: { ...s.review, bodyBuffer: body } } : {})),

  setReviewFmChoice: (choice) =>
    set((s) => (s.review ? { review: { ...s.review, fmChoice: choice } } : {})),

  applyReview: async () => {
    const { review } = get()
    const novel = useProjectStore.getState().novel
    if (!review || !novel) return
    if (draftBlocks(review.path)) {
      set({ error: 'The AI is drafting into this chapter — stop the draft first.' })
      return
    }
    // The body buffer already reflects per-chunk rejections and edits.
    const source = review.fmChoice === 'current' ? review.originalRaw : review.proposedRaw
    const { data, rawFrontmatter } = parseFrontmatter(source)
    const content = serializeFrontmatter({ data, body: review.bodyBuffer, rawFrontmatter })
    const result = await window.pandora.invoke('proposals:apply', {
      novelDir: novel.dir,
      path: review.path,
      expectedCurrent: review.originalRaw,
      write: content,
      // Apply decides exactly the proposals this review folded — anything the
      // fold set aside is still waiting for a look and must survive.
      decisions: review.proposalIds.map((proposalId) => ({ proposalId, newContent: content }))
    })
    if (!result.ok) {
      set({ error: result.error.message })
      await get().refresh()
      return
    }
    set({ review: null })
    const project = useProjectStore.getState()
    if (result.data.content !== null && review.path === project.activeFile) {
      project.setSavedContent(result.data.content)
    } else if (/^(chapters|metadata|outlines)\//.test(review.path)) {
      await project.openChapter(review.path)
    }
    await get().refresh()
  },

  rejectReview: async () => {
    const { review } = get()
    if (!review) return
    await get().resolveDoc(review.path, 'reject')
    set({ review: null })
  },

  exitReview: () => set({ review: null }),

  refresh: async () => {
    const novel = useProjectStore.getState().novel
    if (!novel) {
      set({ pendingDocs: [], pendingTotal: 0 })
      return
    }
    const result = await window.pandora.invoke('proposals:pending', { novelDir: novel.dir })
    if (!result.ok) return
    const docs = result.data.docs
    set({ pendingDocs: docs, pendingTotal: docs.reduce((n, d) => n + d.count, 0) })
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
    set({ manualRunning: true, running: true, error: null, lastRunStatus: null })
    const result = await window.pandora.invoke('proposals:run', {
      novelDir: novel.dir,
      chapterFile: file,
      provider: model.provider,
      modelId: model.id
    })
    if (result.ok) {
      const dropped = result.data.dropped ?? []
      set((s) => ({
        manualRunning: false,
        running: s.agentRuns > 0,
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran'
            ? `${result.data.itemCount} suggestion${result.data.itemCount === 1 ? '' : 's'}`
            : result.data.status === 'no-changes'
              ? // A run whose every suggestion was refused is NOT "up to date" —
                // saying so buries the chapter and gives the author nothing to act on.
                dropped.length > 0
                ? `${dropped.length} suggestion${dropped.length === 1 ? '' : 's'} couldn't be used`
                : 'Codex already up to date'
              : null,
        ...(dropped.length > 0 && !opts?.silent
          ? {
              error: `The model suggested ${dropped.length} change${
                dropped.length === 1 ? '' : 's'
              } this app can't apply — ${dropped[0]!.path}: ${dropped[0]!.reason}. Try again, or use a stronger model for Codex upkeep.`
            }
          : {})
      }))
      await get().refresh()
    } else {
      set((s) => ({ manualRunning: false, running: s.agentRuns > 0, runningStatus: null, ...(opts?.silent ? {} : { error: result.error.message }) }))
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
    set({ manualRunning: true, running: true, error: null, lastRunStatus: null })
    const result = await window.pandora.invoke('outlines:generate', {
      novelDir: novel.dir,
      scope,
      ...(scope === 'chapter' ? { chapterFile: project.activeFile! } : {}),
      ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
      provider: model.provider,
      modelId: model.id
    })
    if (result.ok) {
      set((s) => ({
        manualRunning: false,
        running: s.agentRuns > 0,
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran' ? 'Outline ready for review' : 'No outline changes suggested'
      }))
      await get().refresh()
    } else {
      set((s) => ({ manualRunning: false, running: s.agentRuns > 0, runningStatus: null, error: result.error.message }))
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
    set({ manualRunning: true, running: true, error: null, lastRunStatus: null })
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
      set((s) => ({
        manualRunning: false,
        running: s.agentRuns > 0,
        runningStatus: null,
        lastRunStatus:
          result.data.status === 'ran'
            ? isReport
              ? 'Report ready for review'
              : `${result.data.itemCount} chapter${result.data.itemCount === 1 ? '' : 's'} with edits`
            : 'Nothing to change'
      }))
      await get().refresh()
    } else {
      set((s) => ({ manualRunning: false, running: s.agentRuns > 0, runningStatus: null, error: result.error.message }))
    }
  },

  resolveDoc: async (path, resolution) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return false
    if (resolution === 'accept' && draftBlocks(path)) {
      set({ error: 'The AI is drafting into this chapter — stop the draft first.' })
      return false
    }
    // Unsaved typing must reach disk before main folds against the file.
    if (resolution === 'accept') await project.saveActiveChapter()
    const result = await window.pandora.invoke('proposals:resolveAll', {
      novelDir: novel.dir,
      paths: [path],
      resolution
    })
    await get().refresh()
    if (!result.ok) {
      set({ error: result.error.message })
      return false
    }
    const { skipped, conflicts } = result.data
    if (skipped > 0) {
      set({
        error: `${skipped} suggestion${skipped === 1 ? '' : 's'} needs a look first — ${
          conflicts[0]?.reason ?? 'it no longer lines up with the document'
        }.`
      })
    }
    // Accepting into the open document must refresh the editor buffer.
    if (resolution === 'accept' && path === project.activeFile) {
      await useProjectStore.getState().reloadActiveChapter()
    }
    return result.data.applied > 0
  },

  resolveNovel: async (resolution) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return { applied: 0, skipped: 0 }
    // The open chapter's buffer may hold typing main has not seen: without
    // this the fold runs against stale disk content, and the 5 s autosave then
    // writes the buffer back over whatever was just accepted.
    await project.saveActiveChapter()
    const result = await window.pandora.invoke('proposals:resolveAll', {
      novelDir: novel.dir,
      resolution
    })
    await get().refresh()
    if (!result.ok) {
      set({ error: result.error.message })
      return { applied: 0, skipped: 0 }
    }
    // …and the editor keeps the old text unless it is re-read, so the next
    // keystroke would revert the accepted suggestion.
    if (resolution === 'accept') await useProjectStore.getState().reloadActiveChapter()
    return { applied: result.data.applied, skipped: result.data.skipped }
  }
}))
