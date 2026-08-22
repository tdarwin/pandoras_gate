import { create } from 'zustand'
import { parseFrontmatter, serializeFrontmatter } from '@shared/frontmatter'
import { onIpcEvent } from '../lib/events'
import { useProjectStore, setSuggestionWriter, setCurrentSink, onNovelChange } from './project'
import { useChatStore } from './chat'
import { useDraftStore } from './draft'
import type { EditorHandle } from '../editor/MarkdownEditor'

/** A document with suggestions waiting. Bodies are fetched per document, on demand. */
export interface PendingMark {
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

export interface FoldLink {
  proposalId: string
  sourceTitle: string
  rationale: string
  /** The document with this proposal, and every earlier one, applied. */
  content: string
}

export interface BlockedProposal {
  proposalId: string
  sourceTitle: string
  rationale: string
  reason: string
}

/**
 * The suggestions for the document the author currently has open, folded and
 * ready to overlay. Exactly one at a time — the editor shows one document.
 */
export interface ActiveSuggestions {
  path: string
  /** The file as main last confirmed it; echoed back so a moved file is refused. */
  current: string
  chain: FoldLink[]
  blocked: BlockedProposal[]
  /** Whole-block frontmatter choice, until per-field decisions land. */
  fmChoice: 'proposed' | 'current'
  /** True once the overlay is actually on the editor. */
  shown: boolean
}

interface ProposalsStore {
  /** Every document with something pending, keyed by path. */
  pendingByPath: ReadonlyMap<string, PendingMark>
  pendingTotal: number
  /** Folded suggestions for the open document, or null. */
  active: ActiveSuggestions | null
  /** True while any pipeline run is in flight (manual or chat-deferred). */
  running: boolean
  /** A manual run (Update Codex / Outline / Review buttons) is awaiting its invoke. */
  manualRunning: boolean
  /** Chat-deferred generation batches currently executing in main. */
  agentRuns: number
  /** Live phase text while a pipeline run is in flight. */
  runningStatus: string | null
  lastRunStatus: string | null

  init: () => void
  /** Clears everything that belongs to one novel (close / switch). */
  reset: () => void
  refresh: () => Promise<void>
  /** Folds the pending suggestions for a document so the editor can show them. */
  loadFor: (path: string | null) => Promise<void>
  /** The editor is now showing them (or the author dismissed the offer). */
  setShown: (shown: boolean) => void
  setFmChoice: (choice: 'proposed' | 'current') => void
  /** Steps to a proposal that would not fold in with the others. */
  showOnly: (proposalId: string) => Promise<void>
  /**
   * Records decisions that left the text unchanged — a reject reverts to what
   * the buffer already said, so nothing goes dirty and autosave never runs.
   */
  persistDecisions: () => Promise<void>
  /**
   * Tells the overlay what the file says now, after something else wrote it —
   * the fallback save, a restore, a status change. Without this the next
   * decision is refused against a `current` that no longer matches disk.
   */
  setCurrent: (path: string, content: string) => void
  /** Accepts or rejects everything pending for one document. */
  resolveDoc: (path: string, resolution: 'accept' | 'reject') => Promise<boolean>
  /** Accepts or rejects everything pending in the novel. */
  resolveNovel: (resolution: 'accept' | 'reject') => Promise<boolean>

  runForActiveChapter: (opts?: { silent?: boolean }) => Promise<void>
  generateOutline: (scope: 'novel' | 'chapter', guidance?: string) => Promise<void>
  /** Editing pass over the active chapter or the whole novel. */
  runReview: (
    reviewType: 'proofread' | 'copy-edit' | 'developmental' | 'fact-check',
    scope: 'chapter' | 'novel',
    guidance?: string
  ) => Promise<void>
}

/** Accepting into the chapter an AI draft is streaming into would race the
 *  draft's writer — the author stops the draft first. */
function draftBlocks(path: string): boolean {
  const draft = useDraftStore.getState()
  return draft.drafting && draft.draftFile === path
}

let subscribed = false

/**
 * The editor handle for the open document. The store needs it at save time to
 * ask what each proposal still proposes; deliberately not state, because
 * nothing renders from it.
 */
let activeHandle: EditorHandle | null = null
export function setSuggestionHandle(handle: EditorHandle | null): void {
  activeHandle = handle
}

/**
 * Errors used to surface inside the proposals modal. With the modal gone there
 * is nowhere for them to live, so they go to the app's toast — a refused
 * accept must never be silent.
 */
function fail(message: string): void {
  useProjectStore.getState().setError(message)
}

export const useProposalsStore = create<ProposalsStore>((set, get) => ({
  pendingByPath: new Map(),
  pendingTotal: 0,
  active: null,
  running: false,
  manualRunning: false,
  agentRuns: 0,
  runningStatus: null,
  lastRunStatus: null,

  init: () => {
    if (subscribed) return
    subscribed = true
    onNovelChange(() => get().reset())
    // Saving a document that has suggestions must RECORD decisions, not write
    // the buffer over them — so the project store's writes route through here.
    setCurrentSink((file, content) => get().setCurrent(file, content))
    setSuggestionWriter(async (file, content, snapshot) => {
      const { active } = get()
      if (!active || active.path !== file) return false
      return writeDecisions(active, content, snapshot)
    })
    // The chat agent's tools create proposals out-of-band; refresh on notify.
    onIpcEvent('proposals:changed', () => {
      void get().refresh()
    })
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
            lastRunStatus: payload.result ?? s.lastRunStatus
          }
        })
        if (payload.error !== undefined) fail(payload.error)
        void get().refresh()
      }
    })
  },

  reset: () =>
    set({
      pendingByPath: new Map(),
      pendingTotal: 0,
      active: null,
      lastRunStatus: null,
      runningStatus: null
    }),

  refresh: async () => {
    const novel = useProjectStore.getState().novel
    if (!novel) {
      get().reset()
      return
    }
    const result = await window.pandora.invoke('proposals:pending', { novelDir: novel.dir })
    if (!result.ok) return
    const byPath = new Map(result.data.docs.map((d) => [d.path, d]))
    set({ pendingByPath: byPath, pendingTotal: result.data.docs.reduce((n, d) => n + d.count, 0) })
    // Keep the open document's overlay in step with what main now holds.
    const file = useProjectStore.getState().activeFile
    const { active } = get()
    if (file && byPath.has(file)) {
      if (!active || active.path !== file) await get().loadFor(file)
    } else if (active) {
      set({ active: null })
    }
  },

  loadFor: async (path) => {
    const novel = useProjectStore.getState().novel
    if (!novel || !path || !get().pendingByPath.has(path)) {
      set({ active: null })
      return
    }
    const result = await window.pandora.invoke('proposals:forPath', { novelDir: novel.dir, path })
    if (!result.ok || result.data.chain.length + result.data.blocked.length === 0) {
      set({ active: null })
      return
    }
    set({
      active: {
        path,
        current: result.data.current,
        chain: result.data.chain,
        blocked: result.data.blocked,
        fmChoice: 'current',
        shown: false
      }
    })
  },

  setShown: (shown) => set((s) => (s.active ? { active: { ...s.active, shown } } : {})),

  setFmChoice: (fmChoice) => set((s) => (s.active ? { active: { ...s.active, fmChoice } } : {})),

  showOnly: async (proposalId) => {
    const novel = useProjectStore.getState().novel
    const { active } = get()
    if (!novel || !active) return
    const result = await window.pandora.invoke('proposals:forPath', {
      novelDir: novel.dir,
      path: active.path,
      only: proposalId
    })
    if (!result.ok || result.data.chain.length === 0) return
    set({
      active: {
        ...active,
        current: result.data.current,
        chain: result.data.chain,
        blocked: [],
        shown: false
      }
    })
  },

  setCurrent: (path, content) =>
    set((s) => (s.active?.path === path ? { active: { ...s.active, current: content } } : {})),

  persistDecisions: async () => {
    const { active } = get()
    const project = useProjectStore.getState()
    // Only for the document actually on screen. The chunk count also falls to
    // zero when the editor is recreated for a DIFFERENT document, and
    // persisting then paired the outgoing document with the incoming one's
    // buffer — an empty write that main refused, leaving every later save
    // refused too.
    if (!active || active.path !== project.activeFile) return
    // Only for a decision that changed nothing. An accept leaves the buffer
    // dirty, and the ordinary save carries it — persisting here as well
    // resolved the proposals from the pre-accept buffer, so by the time that
    // save ran there was no overlay left and it wrote the buffer raw.
    //
    // A reject taken with unsaved typing therefore rides the next autosave
    // rather than landing at once. That save does carry it.
    if (project.dirty) return
    await writeDecisions(active, project.content, false)
  },

  resolveDoc: async (path, resolution) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return false
    if (resolution === 'accept' && draftBlocks(path)) {
      fail('The AI is drafting into this chapter — stop the draft first.')
      return false
    }
    // When it is the OPEN document, decide from the editor: it holds the
    // author's typing and their per-chunk decisions. The save that follows
    // records them.
    const { active } = get()
    if (path === project.activeFile && active?.shown && activeHandle) {
      if (resolution === 'accept') activeHandle.acceptAllSuggestions()
      else activeHandle.rejectAllSuggestions()
      await project.snapshotActiveChapter()
      return true
    }
    const result = await window.pandora.invoke('proposals:resolveAll', {
      novelDir: novel.dir,
      paths: [path],
      resolution
    })
    return finishBulk(get, result, path === project.activeFile)
  },

  resolveNovel: async (resolution) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return false
    // The open document's buffer may hold typing main has not seen.
    await project.snapshotActiveChapter()
    const result = await window.pandora.invoke('proposals:resolveAll', {
      novelDir: novel.dir,
      resolution
    })
    return finishBulk(get, result, true)
  },

  runForActiveChapter: async (opts) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    const file = project.activeFile
    if (!novel || !file || !file.startsWith('chapters/') || get().running) return
    const model = chat.modelForRole('codex')
    if (!model) {
      if (!opts?.silent) fail('Pick a model in the chat panel first.')
      return
    }

    // Snapshot first so chapter edits and metadata changes stay separate commits.
    await project.snapshotActiveChapter()
    set({ manualRunning: true, running: true, lastRunStatus: null })
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

      }))
      if (dropped.length > 0 && !opts?.silent) {
        fail(
          `The model suggested ${dropped.length} change${dropped.length === 1 ? '' : 's'} this app can't apply — ${dropped[0]!.path}: ${dropped[0]!.reason}. Try again, or use a stronger model for Codex upkeep.`
        )
      }
      await get().refresh()
    } else {
      set((s) => ({ manualRunning: false, running: s.agentRuns > 0, runningStatus: null }))
      if (!opts?.silent) fail(result.error.message)
    }
  },

  generateOutline: async (scope, guidance) => {
    const project = useProjectStore.getState()
    const chat = useChatStore.getState()
    const novel = project.novel
    if (!novel || get().running) return
    const model = chat.modelForRole('drafting')
    if (!model) {
      fail('Pick a model in the chat panel first.')
      return
    }
    if (scope === 'chapter' && !project.activeFile?.startsWith('chapters/')) return

    await project.snapshotActiveChapter()
    set({ manualRunning: true, running: true, lastRunStatus: null })
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
      set((s) => ({
        manualRunning: false,
        running: s.agentRuns > 0,
        runningStatus: null
      }))
      fail(result.error.message)
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
      fail('Pick a model in the chat panel first.')
      return
    }

    await project.snapshotActiveChapter()
    set({ manualRunning: true, running: true, lastRunStatus: null })
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
      set((s) => ({
        manualRunning: false,
        running: s.agentRuns > 0,
        runningStatus: null
      }))
      fail(result.error.message)
    }
  }
}))

/* ------------------------------------------------------------------ */
/* Saving a document that has suggestions                              */
/* ------------------------------------------------------------------ */

/**
 * Records the author's decisions instead of writing the buffer over them.
 *
 * `content` is the SAVABLE document — the editor already reverted every
 * undecided suggestion — so it is safe to put on disk. What each proposal
 * still proposes comes from the editor too, recomputed rather than patched, so
 * a crash mid-review leaves nothing to reconcile.
 *
 * Returns false to fall back to an ordinary write: a refused decision must
 * never cost the author their typing.
 */
async function writeDecisions(
  active: ActiveSuggestions,
  content: string,
  snapshot: boolean
): Promise<boolean> {
  const novel = useProjectStore.getState().novel
  if (!novel) return false
  const savable = parseFrontmatter(content)
  const proposedFm = parseFrontmatter(active.chain[active.chain.length - 1]?.content ?? content)
  // Frontmatter is decided as a block until the details strip does it per
  // field, and the default is the author's OWN data. Defaulting to the
  // proposal meant every autosave wrote AI frontmatter nobody had agreed to —
  // and threw away whatever the author had just changed in the details panel.
  const data = active.fmChoice === 'proposed' ? proposedFm.data : savable.data
  const write = serializeFrontmatter({
    data,
    body: savable.body,
    rawFrontmatter: savable.rawFrontmatter
  })

  const handle = activeHandle
  /**
   * Only what the author can actually see is decided here.
   *
   * While the overlay is deferred (the strip is offering "Show") the plugin
   * has nothing attached, so the editor would report every proposal as
   * "proposes exactly what the file already says" — and main would resolve the
   * lot. Proposals the fold set aside, and any that arrived after it, are
   * likewise not on screen.
   */
  const decisions =
    active.shown && handle
      ? active.chain.map((link) => ({
          proposalId: link.proposalId,
          newContent: serializeFrontmatter({
            // What this proposal STILL proposes keeps its own frontmatter
            // until the author picks a side. Storing the author's data here
            // meant the first save with the overlay up erased the frontmatter
            // suggestion — the "Proposed" radio had nothing left to offer.
            data: parseFrontmatter(link.content).data,
            body: handle.proposedBody(link.proposalId),
            rawFrontmatter: savable.rawFrontmatter
          })
        }))
      : []

  // Nothing to record and nothing to change: the interval snapshot fires on
  // every document with suggestions pending, and this would otherwise rewrite
  // the file, every proposal, and a commit for a document nobody touched.
  if (write === active.current && decisions.length === 0) return false

  // An emptied existing document is not a decision — main would refuse the
  // apply as an "Empty document" and the author would get a toast for having
  // selected all and pressed delete. Fall through to the ordinary write, which
  // saves what they did; the decisions catch up on the next non-empty save.
  if (active.current !== '' && write.trim() === '') return false

  // A save that changes nothing writes nothing — and a write-less apply is
  // what lets main remember a clean reject.
  const writeArg = write === active.current ? null : write

  const result = await window.pandora.invoke('proposals:apply', {
    novelDir: novel.dir,
    path: active.path,
    expectedCurrent: active.current,
    write: writeArg,
    decisions
  })
  if (!result.ok) {
    useProjectStore.getState().setError(result.error.message)
    // A refusal that HAS a fallback coming re-anchors from it: re-folding here
    // would describe the file as it was before that write, and the next save
    // would be refused all over again. `setCurrent` is called once the plain
    // write lands. Falling back is right there and only there — the buffer
    // holds typing, and losing that is worse than overwriting the change main
    // objected to.
    //
    // A write-less refusal is the opposite case. `writeArg` is null only when
    // the savable document already equals the anchor, so there is no typing to
    // protect and the fallback write has nothing to offer but damage: it puts
    // the pre-change text back over whatever main just said had changed. This
    // is where "Reject all" quietly reverted an edit made outside the app.
    // Report handled, so the caller writes nothing.
    if (writeArg === null && useProposalsStore.getState().active?.path === active.path) {
      // The buffer is a copy of `current`, which main has just told us is out
      // of date — so the buffer is out of date too, and the next save would
      // put it back over whatever changed the file. Re-reading is safe HERE
      // precisely because nothing was typed over it; if something was, that
      // typing wins and rides the next save instead.
      const stale = useProjectStore.getState()
      if (stale.activeFile === active.path && stale.content === content) {
        await stale.reloadActiveChapter()
      }
      await useProposalsStore.getState().loadFor(active.path)
      return true
    }
    return false
  }
  useProposalsStore.setState((s) =>
    s.active && s.active.path === active.path
      ? // Only what main actually wrote. Advancing this on a write-less apply
        // left `expectedCurrent` describing a file that was never written, and
        // every save after it was refused as stale.
        { active: { ...s.active, current: result.data.content ?? s.active.current } }
      : {}
  )
  // What went to disk can differ from the buffer. Left unsynced, the next
  // plain save — once the suggestions resolve and this writer stops running —
  // put the buffer straight back over it.
  const project = useProjectStore.getState()
  if (
    result.data.content !== null &&
    result.data.content !== content &&
    project.activeFile === active.path &&
    // Only when the buffer is still what was sent. Replacing it wholesale
    // dropped anything typed during the round trip — and the editor's next
    // unfocused sync made those keystrokes visibly disappear.
    project.content === content
  ) {
    project.setSavedContent(result.data.content)
  }
  if (snapshot) {
    await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: active.path,
      content: write,
      snapshot: true
    })
  }
  await useProposalsStore.getState().refresh()
  return true
}

type BulkResult = Awaited<ReturnType<typeof window.pandora.invoke<'proposals:resolveAll'>>>

async function finishBulk(
  get: () => ProposalsStore,
  result: BulkResult,
  reloadOpenDoc: boolean
): Promise<boolean> {
  await get().refresh()
  if (!result.ok) {
    fail(result.error.message)
    return false
  }
  const { skipped, conflicts } = result.data
  if (skipped > 0) {
    fail(
      `${skipped} suggestion${skipped === 1 ? '' : 's'} needs a look first — ${
        conflicts[0]?.reason ?? 'it no longer lines up with the document'
      }.`
    )
  }
  if (reloadOpenDoc) await useProjectStore.getState().reloadActiveChapter()
  return result.data.applied > 0
}
