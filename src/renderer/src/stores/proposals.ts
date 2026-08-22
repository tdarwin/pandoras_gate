import { create } from 'zustand'
import { parseFrontmatter, serializeFrontmatter } from '@shared/frontmatter'
import { remainingData } from '../lib/frontmatterEdit'
import { onIpcEvent } from '../lib/events'
import { useProjectStore, setSuggestionWriter, setCurrentSink, onNovelChange } from './project'
import { useChatStore } from './chat'
import { useDraftStore } from './draft'
import { getSchema } from '@tiptap/core'
import { baseExtensions } from '../editor/extensions'
import { splitInlineChain } from '../editor/track-changes'

/**
 * What the store needs from whatever is showing the document: the two
 * projections. `EditorHandle` satisfies it, and so does the timeline editor,
 * which has no ProseMirror doc at all.
 */
export interface SuggestionSource {
  /** What one proposal still proposes. */
  proposedBody: (proposalId: string) => string
  /** Decide every suggestion in the document at once. */
  acceptAllSuggestions: () => void
  rejectAllSuggestions: () => void
  /**
   * Whether the source is actually showing the suggestions. A count of zero
   * means either "everything decided" or "nothing attached", and only one of
   * those is a decision worth recording.
   */
  suggestionsAttached: () => boolean
}

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
  /**
   * Set aside because it changes the SHAPE of the document, not because it
   * would not re-anchor. Decided whole against a word diff rather than shown
   * inline — see `editor/blockShape.ts`.
   */
  structural?: boolean
  /** What it proposes, whole. Only structural entries carry it. */
  content?: string
}

/**
 * The suggestions for the document the author currently has open, folded and
 * ready to overlay. Exactly one at a time — the editor shows one document.
 */
export interface ActiveSuggestions {
  path: string
  /** 'create' when no file exists yet — not the same as a file that is empty. */
  action: 'create' | 'update'
  /** The file as main last confirmed it; echoed back so a moved file is refused. */
  current: string
  chain: FoldLink[]
  blocked: BlockedProposal[]
  /**
   * Frontmatter fields the author turned down. Accepting a field is an
   * ordinary edit to the buffer; rejecting has to be recorded, or "proposed
   * still differs from current" would keep offering it forever.
   */
  rejectedFields: string[]
  /** True once the overlay is actually on the editor. */
  shown: boolean
  /**
   * The structural proposal being decided whole, folded ON ITS OWN.
   *
   * Not the entry from `blocked`, whose content is the CUMULATIVE fold and so
   * carries the undecided inline links before it: accepting that would put
   * their text on disk under this proposal's name, and leave them pending
   * against a file that already contains them.
   */
  review: {
    proposalId: string
    sourceTitle: string
    rationale: string
    /** The file this fold is anchored to. */
    base: string
    /** The file with this proposal alone applied. */
    content: string
  } | null
  /**
   * True when these were folded because the author opened the document — they
   * went there to look. False when they arrived into a document already open,
   * where the strip offers "Show" instead of putting AI text under the caret.
   */
  loadedByNavigation: boolean
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
  loadFor: (path: string | null, opts?: { byNavigation?: boolean }) => Promise<void>
  /** The editor is now showing them (or the author dismissed the offer). */
  setShown: (shown: boolean) => void
  /** Records a frontmatter field the author turned down. */
  rejectField: (key: string) => void
  /** Steps to a proposal that would not fold in with the others. */
  showOnly: (proposalId: string) => Promise<void>
  /** Opens the whole-document diff for a proposal that changes the shape. */
  reviewStructural: (proposalId: string) => void
  closeStructuralReview: () => void
  /** Accepts or refuses a structural proposal, whole. */
  decideStructural: (proposalId: string, resolution: 'accept' | 'reject') => Promise<boolean>
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

/**
 * Splits a fold into what can be reviewed inline and what cannot.
 *
 * Per-chunk ✓/✕ decides a suggestion by splicing the original back over the
 * proposal's range, which is only unambiguous when the two documents hold the
 * same blocks. A proposal that changes the shape of the document is set aside
 * like one that will not re-anchor, and decided whole against a word diff.
 */
let cachedSchema: ReturnType<typeof getSchema> | null = null

/** The documents the tracked-changes editor never opens. */
export function isYamlPath(path: string): boolean {
  return /\.ya?ml$/.test(path)
}

function partitionChain(
  path: string,
  current: string,
  chain: FoldLink[],
  blocked: BlockedProposal[]
): { chain: FoldLink[]; blocked: BlockedProposal[] } {
  // The gate exists because SPLICING the original back over a proposal's range
  // is ambiguous when the two documents hold different blocks. A YAML document
  // is not reviewed that way at all — it is decided entry by entry, and
  // nothing is spliced — so the gate does not apply, and applying it anyway
  // sent the commonest timeline proposal (a new event) to a raw markdown word
  // diff of YAML text.
  if (isYamlPath(path)) return { chain, blocked }
  const schema = (cachedSchema ??= getSchema(baseExtensions()))
  const bodies = chain.map((link) => parseFrontmatter(link.content).body)
  const { inline } = splitInlineChain(
    schema,
    parseFrontmatter(current).body,
    bodies.map((content) => ({ content }))
  )
  if (inline.length === chain.length) return { chain, blocked }
  return {
    chain: chain.slice(0, inline.length),
    blocked: [
      ...blocked,
      ...chain.slice(inline.length).map((link) => ({
        proposalId: link.proposalId,
        sourceTitle: link.sourceTitle,
        rationale: link.rationale,
        reason: 'has to be decided as a whole',
        structural: true,
        content: link.content
      }))
    ]
  }
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
let activeHandle: SuggestionSource | null = null
export function setSuggestionHandle(handle: SuggestionSource | null): void {
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

  loadFor: async (path, opts) => {
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
        // An existing zero-byte file is not a create, and treating it as one
        // ignored the author's frontmatter choice and skipped their saves.
        action: get().pendingByPath.get(path)?.action ?? 'update',
        current: result.data.current,
        ...partitionChain(path, result.data.current, result.data.chain, result.data.blocked),
        rejectedFields: [],
        shown: false,
        review: null,
        // Never downgraded: a refresh triggered by the save that navigation
        // itself performs can land either side of the navigation's own load,
        // and losing the flag left the author staring at a document whose
        // suggestions were folded but never shown.
        loadedByNavigation:
          opts?.byNavigation ??
          (get().active?.path === path ? get().active!.loadedByNavigation : false)
      }
    })
  },

  setShown: (shown) => set((s) => (s.active ? { active: { ...s.active, shown } } : {})),

  rejectField: (key) => {
    const { active } = get()
    if (!active || active.rejectedFields.includes(key)) return
    set({ active: { ...active, rejectedFields: [...active.rejectedFields, key] } })
    // Nothing in the document changed, so nothing goes dirty and autosave
    // never runs — without this the refusal lived in memory until the next
    // snapshot, and a quit lost it while the badge still said pending.
    void get().persistDecisions()
  },

  showOnly: async (proposalId) => {
    const novel = useProjectStore.getState().novel
    const { active } = get()
    if (!novel || !active) return
    // One that changes the document's shape is never shown inline. It gets
    // the whole-document diff instead.
    if (active.blocked.some((b) => b.proposalId === proposalId && b.structural)) {
      await get().reviewStructural(proposalId)
      return
    }
    const result = await window.pandora.invoke('proposals:forPath', {
      novelDir: novel.dir,
      path: active.path,
      only: proposalId
    })
    if (!result.ok || result.data.chain.length === 0) return
    // Carry forward the ones NOT being stepped to. Seeding with [] dropped
    // them from the strip entirely — no button, no rationale — until the
    // author switched documents and back.
    const next = partitionChain(
      active.path,
      result.data.current,
      result.data.chain,
      active.blocked.filter((b) => b.proposalId !== proposalId)
    )
    set({
      active: {
        ...active,
        current: result.data.current,
        ...next,
        // Deliberately NOT turning the overlay off first. The attach effect is
        // keyed on the chain, so a new chain re-attaches directly; setting
        // `shown` false and letting the auto-show effect turn it back on left
        // a render in between where the overlay DETACHED — which dropped the
        // chunk count to zero, and the save that followed read that as the
        // author having decided everything, deleting the very suggestion this
        // was about to show.
        shown: active.shown,
        // Stepping to a proposal is an explicit request to look at it.
        loadedByNavigation: true
      }
    })
  },

  reviewStructural: async (proposalId) => {
    const novel = useProjectStore.getState().novel
    const { active } = get()
    if (!novel || !active) return
    const item = active.blocked.find((b) => b.proposalId === proposalId && b.structural)
    if (!item) return
    // Folded ON ITS OWN, against the file as it stands. The entry in `blocked`
    // carries the CUMULATIVE fold, so accepting that would put the undecided
    // inline links before it on disk under this proposal's name — and leave
    // them pending against a file that already contains them.
    const result = await window.pandora.invoke('proposals:forPath', {
      novelDir: novel.dir,
      path: active.path,
      only: proposalId
    })
    if (!result.ok) {
      fail(result.error.message)
      return
    }
    const alone = result.data.chain[0]
    if (!alone) {
      fail(
        'That suggestion no longer lines up with the document — it will be folded again on the next run.'
      )
      return
    }
    set({
      active: {
        ...get().active!,
        review: {
          proposalId,
          sourceTitle: item.sourceTitle,
          rationale: item.rationale,
          base: result.data.current,
          content: alone.content
        }
      }
    })
  },

  closeStructuralReview: () => {
    const { active } = get()
    if (active) set({ active: { ...active, review: null } })
  },

  decideStructural: async (proposalId, resolution) => {
    const project = useProjectStore.getState()
    const novel = project.novel
    const { active } = get()
    if (!novel || !active || active.review?.proposalId !== proposalId) return false
    if (resolution === 'accept' && draftBlocks(active.path)) {
      fail('The AI is drafting into this chapter — stop the draft first.')
      return false
    }
    // Only when there is something of theirs to save. An unconditional
    // snapshot on a clean buffer fell through the suggestion writer's
    // "nothing to record" branch into a plain, unchecked whole-buffer write —
    // putting the stale buffer over an edit made outside the app before the
    // staleness check could ever see it.
    if (project.dirty) {
      await project.snapshotActiveChapter()
      await get().reviewStructural(proposalId)
    }
    const fresh = get().active
    const target = fresh?.review
    if (!fresh || !target || target.proposalId !== proposalId) {
      get().closeStructuralReview()
      return false
    }

    // Frontmatter is decided the same way it is everywhere else: the author's
    // own data, with this proposal's field suggestions applied except the ones
    // they have already turned down. Writing the proposal's file verbatim
    // replaced fields no diff had shown and walked straight over a refusal.
    const base = parseFrontmatter(target.base)
    const proposed = parseFrontmatter(target.content)
    const content = serializeFrontmatter({
      data:
        resolution === 'accept'
          ? remainingData(base.data, proposed.data, fresh.rejectedFields)
          : base.data,
      body: proposed.body,
      rawFrontmatter: base.rawFrontmatter
    })

    const result = await window.pandora.invoke('proposals:apply', {
      novelDir: novel.dir,
      path: fresh.path,
      expectedCurrent: target.base,
      write: resolution === 'accept' ? content : null,
      // Either way the proposal is done: accepted, its content becomes the
      // file and nothing is left to suggest; refused, what it proposes is
      // what the file already says. Main records the refusal on the
      // write-less branch, so it stays refused.
      decisions: [{ proposalId, newContent: resolution === 'accept' ? content : target.base }]
    })
    if (!result.ok) {
      fail(result.error.message)
      await get().loadFor(fresh.path)
      return false
    }
    if (result.data.content !== null && useProjectStore.getState().activeFile === fresh.path) {
      useProjectStore.getState().setSavedContent(result.data.content)
    }
    // `refresh` alone re-folds only a path that CHANGED, so `current` stayed
    // at the pre-accept text, the resolved proposal kept being offered, and
    // the next ordinary save was refused as stale — an error the author got
    // for doing exactly what the panel told them to.
    await get().loadFor(fresh.path)
    await get().refresh()
    return true
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
    /*
     * "Accept all" / "Reject all" means EVERYTHING pending on this document,
     * whichever way each piece has to be decided. Two things could go wrong
     * with a narrower reading, and both did:
     *
     * - Gated only on `shown && activeHandle`, a document whose one proposal
     *   is structural took the editor branch, decided an overlay that was
     *   never attached, and returned true. No error, nothing changed, and a
     *   fresh empty commit in the novel's history for every click.
     * - And whether a structural proposal got decided at all depended on
     *   whether the overlay happened to be showing, because the other branch
     *   goes to main, which has no notion of "structural".
     */
    const { active } = get()
    if (path === project.activeFile && active) {
      // The inline chain, through the editor — which holds the author's
      // typing and their per-chunk decisions — when it is actually showing.
      if (active.shown && active.chain.length > 0 && activeHandle?.suggestionsAttached()) {
        if (resolution === 'accept') activeHandle.acceptAllSuggestions()
        else activeHandle.rejectAllSuggestions()
        await project.snapshotActiveChapter()
        await get().loadFor(path)
      }
      // Each structural one the way the panel decides it — folded on its own,
      // so accepting one does not put the others on disk. Deciding one can
      // turn the next into an inline one, so this runs until nothing is set
      // aside rather than for a fixed count.
      const decided = new Set<string>()
      for (;;) {
        // One attempt per proposal: a fold that keeps offering something just
        // decided is main disagreeing with us, and that goes to main below.
        const next = get().active?.blocked.find((b) => b.structural && !decided.has(b.proposalId))
        if (!next) break
        decided.add(next.proposalId)
        await get().reviewStructural(next.proposalId)
        if (get().active?.review?.proposalId !== next.proposalId) break
        if (!(await get().decideStructural(next.proposalId, resolution))) break
      }
      // Done only when nothing is left. Anything else — a chain the editor
      // could not speak for because the overlay is deferred, a link the
      // structural decisions freed, a proposal main set aside — goes to main,
      // which is idempotent over what is already decided and reports what it
      // had to skip. Returning early here left suggestions pending behind a
      // success, and the author clicking the same button twice.
      const left = get().active
      if (!left || left.chain.length + left.blocked.length === 0) {
        await get().refresh()
        return true
      }
    }
    // The open document's buffer may hold typing main has not seen. Main folds
    // against DISK, and the reload afterwards replaces the buffer with what it
    // wrote — so without this, "Reject all" beside the strip's "Show" button
    // silently discarded the author's unsaved sentence and reported success.
    if (path === project.activeFile) await useProjectStore.getState().snapshotActiveChapter()
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
  // The buffer already holds the decided document: the body with undecided
  // suggestions reverted, and whatever frontmatter fields the author accepted
  // (accepting a field is an ordinary edit).
  const savable = parseFrontmatter(content)
  // The buffer already holds the decided document: the body with undecided
  // suggestions reverted, and whatever frontmatter fields the author accepted
  // (accepting a field is an ordinary edit).
  //
  // A document that does not exist yet is the exception: there is no author
  // frontmatter to protect, and using the empty buffer's would strip the
  // proposal's own details the first time the row was opened.
  const isCreate = active.action === 'create'
  const proposedFm = parseFrontmatter(active.chain[active.chain.length - 1]?.content ?? content)
  const write = isCreate
    ? serializeFrontmatter({
        data: proposedFm.data,
        body: savable.body,
        rawFrontmatter: savable.rawFrontmatter
      })
    : content

  const handle = activeHandle
  /**
   * Only what the author can actually see is decided here.
   *
   * While the overlay is deferred (the strip is offering "Show") the plugin
   * has nothing attached, so the editor would report every proposal as
   * "proposes exactly what the file already says" — and main would resolve the
   * lot. Proposals the fold set aside, and any that arrived after it, are
   * likewise not on screen. A source that cannot represent a proposal at all
   * (the plain-text fallback for a timeline that is not a list of records) is
   * in the same position.
   */
  const decisions =
    // `suggestionsAttached` and not just a handle: a count of zero means
    // either "everything decided" or "no overlay on the document", and
    // reading a DETACH as a decision resolved suggestions from a source that
    // was not showing them — deleting the one the author was about to look at
    // and recording it as refused.
    active.shown && handle?.suggestionsAttached()
      ? active.chain.map((link) => {
          const linkFm = parseFrontmatter(link.content)
          return {
            proposalId: link.proposalId,
            // What this proposal STILL proposes: everything already decided,
            // plus its own fields the author has neither accepted nor turned
            // down. Storing the decided data alone erased the frontmatter
            // suggestion on the first save.
            newContent: serializeFrontmatter({
              data: remainingData(
                parseFrontmatter(write).data,
                linkFm.data,
                // A chapter's title and status belong to the manifest, so they
                // are never offered — and must not keep the item pending.
                active.path.startsWith('chapters/')
                  ? [...active.rejectedFields, 'title', 'status']
                  : active.rejectedFields
              ),
              body: handle.proposedBody(link.proposalId),
              rawFrontmatter: savable.rawFrontmatter
            })
          }
        })
      : []

  // Nothing to record and nothing to change: the interval snapshot fires on
  // every document with suggestions pending, and this would otherwise rewrite
  // the file, every proposal, and a commit for a document nobody touched.
  //
  // Reported as HANDLED, not declined: declining sends the caller to a plain
  // write of the whole buffer. An explicit ⌘S still gets its history entry —
  // written with `expectedCurrent`, so main checks disk rather than this
  // store's belief about it, and a buffer that went stale behind an outside
  // edit is refused readably instead of landing on top of it. Nothing of the
  // author's is in that buffer, so refusing costs them nothing; re-reading
  // shows them the file as it now is. Never for a document that does not
  // exist yet.
  if (write === active.current && decisions.length === 0) {
    if (snapshot && !isCreate) {
      const result = await window.pandora.invoke('chapter:write', {
        novelDir: novel.dir,
        file: active.path,
        content: write,
        snapshot: true,
        expectedCurrent: active.current
      })
      if (!result.ok) {
        useProjectStore.getState().setError(result.error.message)
        const stale = useProjectStore.getState()
        if (stale.activeFile === active.path && stale.content === content) {
          await stale.reloadActiveChapter()
        }
        if (useProposalsStore.getState().active?.path === active.path) {
          await useProposalsStore.getState().loadFor(active.path)
        }
      }
    }
    return true
  }

  // A document that does not exist yet stays that way until the author accepts
  // something. Merely opening a proposed character profile and navigating away
  // used to write a frontmatter-only stub — which took the NEW marker off the
  // row, turned the create into an update, and left a bodyless profile behind
  // if the author later rejected it.
  const untouched = isCreate && savable.body.trim() === ''

  // An emptied existing document is not a decision — main would refuse the
  // apply as an "Empty document" and the author would get a toast for having
  // selected all and pressed delete. Fall through to the ordinary write, which
  // saves what they did; the decisions catch up on the next non-empty save.
  if (!isCreate && write.trim() === '') return false

  // A save that changes nothing writes nothing — and a write-less apply is
  // what lets main remember a clean reject. A document nobody has decided on
  // is in the same position: it stays a document that does not exist.
  const writeArg = untouched || write === active.current ? null : write

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
  // A document that had no file has one now. The flag that keeps saves from
  // materialising a rejected phantom must not outlive the accept that created
  // it, or an author who selects all and deletes gets their deletion swallowed
  // and genuine read errors stay hidden for the rest of the session.
  if (result.data.content !== null) useProjectStore.getState().notePathWritten(active.path)
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
  // `chapter:write` writes unconditionally, so following a write-less apply
  // with the computed content re-created exactly the stub the null write
  // existed to avoid — leaving a phantom undecided still made the file, took
  // its NEW marker off, and turned the create into an update of a bodyless
  // document. An existing document still gets its history entry, written
  // byte-identically; one that does not exist gets nothing at all.
  if (snapshot && (writeArg !== null || !isCreate)) {
    await window.pandora.invoke('chapter:write', {
      novelDir: novel.dir,
      file: active.path,
      content: writeArg ?? active.current,
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
  // Including a create that was just ACCEPTED: main has made the file, and
  // skipping the reload left the editor holding the empty buffer it started
  // with — which the next save then wrote back over the new profile.
  // `reloadActiveChapter` already stays quiet about the ENOENT that is the
  // expected answer for a document with no file, so a rejected create needs no
  // special case here.
  if (reloadOpenDoc) await useProjectStore.getState().reloadActiveChapter()
  return result.data.applied > 0
}
