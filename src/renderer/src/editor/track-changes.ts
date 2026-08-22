import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { StepMap, Transform } from '@tiptap/pm/transform'
import type { Node as PMNode } from '@tiptap/pm/model'
import { diffArrays } from 'diff'
import { Change, ChangeSet, simplifyChanges, type TokenEncoder } from 'prosemirror-changeset'
import { markdownToDoc, docToMarkdown } from './markdown'

/**
 * Suggestions inside the WYSIWYG editor. The document being edited is the
 * ORIGINAL FILE PLUS every pending suggestion; the extension holds the
 * original and renders the difference — insertions highlighted, deletions as
 * struck-through inline widgets — each chunk with ✓/✕ controls.
 *
 * Two documents come back out, and the distinction is the whole design:
 *
 * - `savableDoc` — the doc with every still-pending suggestion reverted. This
 *   is what autosave writes, so an undecided suggestion never reaches disk.
 * - the live doc — everything accepted. This is what is still proposed.
 *
 * Mechanics (prosemirror-changeset):
 * - Spans carry their source: a proposal id, or AUTHOR for the writer's own
 *   typing. That is what keeps "keep writing while you decide" honest — your
 *   own words never render as a suggestion, and never get reverted by a save.
 * - User edits stream through addSteps, so a change is mapped through them.
 * - REJECT replaces the chunk with the original's slice; the re-diff sees
 *   identical content and the change evaporates. Undo brings it back.
 * - ACCEPT records the range as resolved (remapped through later edits); the
 *   content is already in the doc, so accepting only clears the badges. It is
 *   metadata-only, so prosemirror-history never records it — accepting is not
 *   undoable, and "Reject all" plus the pre-decision commit are the way back.
 */

/** Span source for text the writer typed themselves. */
export const AUTHOR = '\u0000author'

/** One proposal folded onto everything before it. */
export interface ChainLink {
  proposalId: string
  /** The document with this proposal, and every earlier one, applied. */
  content: string
}

export interface AttachSpec {
  /** Markdown of the on-disk document the suggestions are diffed against. */
  original: string
  /** Oldest first. The last link's content is what the editor doc shows. */
  chain: ChainLink[]
}

interface TrackState {
  original: PMNode
  set: ChangeSet<string>
  /** Ranges (in current-doc coordinates) the author explicitly accepted. */
  accepted: { from: number; to: number }[]
  decos: DecorationSet
  /** The chunks `decos` was built from, and the doc they belong to. */
  chunks: Chunk[]
  chunkDoc: PMNode | null
}

interface TrackMeta {
  accept?: { from: number; to: number }
  acceptAll?: boolean
  attach?: AttachSpec
  detach?: true
}

export const trackChangesKey = new PluginKey<TrackState>('trackChanges')

/**
 * The default changeset encoder compares node tokens by TYPE only, so a
 * styled block's alignment change or an image swap (same node type, new
 * attrs) diffed as "no change" — invisible in review and immune to reject.
 * Attrs are folded into the start tokens instead. Character tokens keep the
 * default mark-blind encoding: surfacing every bold/italic toggle as a
 * reviewable change is a separate (pre-existing) question.
 */
const attrsAwareEncoder: TokenEncoder<string | number> = {
  encodeCharacter: (char) => char,
  encodeNodeStart: (node) => {
    for (const key in node.attrs) {
      if (node.attrs[key] !== null) return node.type.name + JSON.stringify(node.attrs)
    }
    return node.type.name
  },
  encodeNodeEnd: (node) => `/${node.type.name}`,
  compareTokens: (a, b) => a === b
}

/* ------------------------------------------------------------------ */
/* Block-aligned diffing                                               */
/* ------------------------------------------------------------------ */

/**
 * prosemirror-changeset gives up past MAX_DIFF_SIZE (5000) of edit distance
 * and returns ONE change spanning everything that differs — which for a heavy
 * copy-edit of a long chapter meant the entire original struck through, the
 * entire proposal inserted, and a single all-or-nothing ✓/✕.
 *
 * `addSteps` runs its diff once per changed range, so the fix is to hand it
 * one range per changed block instead of one range for the whole document:
 * each paragraph then gets its own 5000-character budget.
 *
 * The subtlety is the range boundaries. `Change.merge` treats *touching*
 * ranges as overlapping, so whole-node ranges on consecutive changed blocks
 * fuse straight back into one chunk and the collapse returns. Paired blocks
 * are therefore mapped by their INNER content range, which leaves the two
 * boundary tokens unchanged between them.
 */
const MAX_ALIGN_DEPTH = 4

/** Cheap identity for alignment: same type, same attrs, same text. */
function blockKey(node: PMNode): string {
  return `${node.type.name}${JSON.stringify(node.attrs)}\u0000${node.textContent}`
}

type Range = { fromA: number; toA: number; fromB: number; toB: number }

function alignRanges(a: PMNode, b: PMNode, offA: number, offB: number, depth: number): Range[] {
  const kidsA: PMNode[] = []
  const kidsB: PMNode[] = []
  a.forEach((n) => kidsA.push(n))
  b.forEach((n) => kidsB.push(n))

  // Start offsets of each child, in document coordinates.
  const startsA: number[] = []
  const startsB: number[] = []
  let p = offA
  for (const n of kidsA) {
    startsA.push(p)
    p += n.nodeSize
  }
  p = offB
  for (const n of kidsB) {
    startsB.push(p)
    p += n.nodeSize
  }

  const out: Range[] = []
  const emit = (ia: number, na: number, ib: number, nb: number): void => {
    // A 1:1 pair with identical markup diffs on its INSIDE, so consecutive
    // changed blocks keep a gap and stay separate chunks.
    if (na === 1 && nb === 1) {
      const nodeA = kidsA[ia]!
      const nodeB = kidsB[ib]!
      if (nodeA.sameMarkup(nodeB)) {
        if (nodeA.isTextblock || depth >= MAX_ALIGN_DEPTH || !nodeA.firstChild?.isBlock) {
          out.push({
            fromA: startsA[ia]! + 1,
            toA: startsA[ia]! + nodeA.nodeSize - 1,
            fromB: startsB[ib]! + 1,
            toB: startsB[ib]! + nodeB.nodeSize - 1
          })
          return
        }
        // A container (blockquote, styled block, table row): recurse so a
        // change lands on the cell or paragraph that actually moved.
        out.push(...alignRanges(nodeA, nodeB, startsA[ia]! + 1, startsB[ib]! + 1, depth + 1))
        return
      }
    }
    // Everything else — differing markup, or an uneven run — replaces whole
    // nodes, which is what keeps a styled-block wrap or an image swap intact.
    const fromA = na > 0 ? startsA[ia]! : startsA[ia] ?? offA + a.content.size
    const toA = na > 0 ? startsA[ia + na - 1]! + kidsA[ia + na - 1]!.nodeSize : fromA
    const fromB = nb > 0 ? startsB[ib]! : startsB[ib] ?? offB + b.content.size
    const toB = nb > 0 ? startsB[ib + nb - 1]! + kidsB[ib + nb - 1]!.nodeSize : fromB
    out.push({ fromA, toA, fromB, toB })
  }

  const parts = diffArrays(kidsA.map(blockKey), kidsB.map(blockKey))
  let ia = 0
  let ib = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const n = part.count ?? part.value.length
    if (!part.added && !part.removed) {
      ia += n
      ib += n
      continue
    }
    const next = parts[i + 1]
    if (part.removed && next?.added) {
      const m = next.count ?? next.value.length
      if (n === m) {
        // A copy-edit that touched every paragraph is one removed/added run —
        // splitting it 1:1 is what gives each paragraph its own diff budget.
        for (let k = 0; k < n; k++) emit(ia + k, 1, ib + k, 1)
      } else {
        emit(ia, n, ib, m)
      }
      ia += n
      ib += m
      i += 1
      continue
    }
    if (part.removed) {
      emit(ia, n, ib, 0)
      ia += n
    } else {
      emit(ia, 0, ib, n)
      ib += n
    }
  }
  return out
}

/**
 * StepMaps taking `a` to `b`, one single-range map per differing block,
 * DESCENDING by position.
 *
 * One multi-range map would be the obvious encoding, but changeset's
 * `addSteps` carries only the PREVIOUS range's size delta between ranges of
 * the same map, not the running total — so from the third range on, the
 * positions come out wrong. (ProseMirror's own steps never produce more than
 * two ranges, so nothing upstream exercises it.) Separate maps sidestep that:
 * each has one range and no accumulation. Descending order is what makes the
 * coordinates line up without any offsetting of our own — replacing a later
 * block never moves an earlier one, so every map's positions are still the
 * positions in `a`.
 */
function blockStepMaps(a: PMNode, b: PMNode): StepMap[] {
  let ranges: Range[]
  try {
    ranges = alignRanges(a, b, 0, 0, 0).filter((r) => r.toA > r.fromA || r.toB > r.fromB)
  } catch {
    ranges = []
  }
  const ok =
    ranges.length > 0 &&
    ranges.every((r, i) => (i === 0 || r.fromA >= ranges[i - 1]!.toA) && r.toA >= r.fromA)
  if (!ok) {
    // Nothing aligned (or the alignment came out inconsistent): fall back to
    // the whole-document replace this used to do exclusively.
    return [new StepMap([0, a.content.size, b.content.size])]
  }
  return ranges
    .slice()
    .sort((x, y) => y.fromA - x.fromA)
    .map((r) => new StepMap([r.fromA, r.toA - r.fromA, r.toB - r.fromB]))
}

function foldChain(original: PMNode, chain: { proposalId: string; doc: PMNode }[]): ChangeSet<string> {
  let set = ChangeSet.create<string>(original, undefined, attrsAwareEncoder)
  let prev = original
  for (const link of chain) {
    set = set.addSteps(link.doc, blockStepMaps(prev, link.doc), link.proposalId)
    prev = link.doc
  }
  return set
}

/* ------------------------------------------------------------------ */
/* Reading the change set                                              */
/* ------------------------------------------------------------------ */

/** The sources a change carries, across both sides. */
function sourcesOf(change: Change<string>): string[] {
  const out: string[] = []
  for (const span of [...change.deleted, ...change.inserted]) {
    if (span.data != null && !out.includes(span.data)) out.push(span.data)
  }
  return out
}

/** A change narrowed to the part that is genuinely still a suggestion. */
export interface Chunk {
  fromA: number
  toA: number
  fromB: number
  toB: number
  sources: string[]
}

/**
 * Narrows a change to the part the author has NOT taken over.
 *
 * `Change.merge` fuses touching ranges, so one keystroke immediately before or
 * after a suggested span lands inside that change. Treating the whole change
 * as the author's then made the ✓/✕ vanish and let unaccepted AI text through
 * to disk — and continuing a sentence right after a suggested word is the most
 * ordinary way there is to interact with one.
 *
 * So: leading and trailing author INSERTIONS are trimmed off — adjacent typing
 * is not a decision — while an insertion in the interior means they typed into
 * the suggestion, and that chunk is theirs. An author DELETION anywhere in the
 * change is likewise a takeover, and an insertion that leaves no proposal text
 * behind (they selected the suggestion and typed over it) is too.
 *
 * Every rule errs the same way: when in doubt the chunk becomes the author's,
 * because the alternative is a save that eats what they wrote. Returns null
 * when nothing of the suggestion is left.
 */
function narrow(change: Change<string>): Chunk | null {
  // --- B side: what the change puts in the document.
  const ins = change.inserted
  let fromB = change.fromB
  let i = 0
  while (i < ins.length && ins[i]!.data === AUTHOR) {
    fromB += ins[i]!.length
    i += 1
  }
  let toB = change.toB
  let j = ins.length
  while (j > i && ins[j - 1]!.data === AUTHOR) {
    toB -= ins[j - 1]!.length
    j -= 1
  }
  for (let k = i; k < j; k++) {
    if (ins[k]!.data === AUTHOR) return null
  }
  const proposalInserted = j > i

  // --- A side: what it takes out.
  //
  // An author deletion anywhere in the change is a takeover, full stop. The
  // two sides do not trim symmetrically — a character the author removed can
  // sit between two spans a proposal deleted, so narrowing the A-range alone
  // makes the revert restore less than it replaces, and prose disappears from
  // the saved document. Adopting the chunk instead is the safe direction: the
  // author edited across it, and their words are never touched.
  const del = change.deleted
  if (del.some((span) => span.data === AUTHOR)) return null
  const proposalDeleted = change.toA > change.fromA

  // The author replaced the suggested text with their own: the proposal's
  // insertion is gone, only its deletion remains. Restoring that deletion
  // would put the original back *alongside* what they just wrote.
  if (!proposalInserted && proposalDeleted && ins.length > 0) return null

  // Nothing of a proposal left on either side.
  if (fromB === toB && change.fromA === change.toA) return null
  const sources = sourcesOf(change).filter((sc) => sc !== AUTHOR)
  if (sources.length === 0) return null
  return { fromA: change.fromA, toA: change.toA, fromB, toB, sources }
}

/** The proposal a chunk belongs to, or null when it fused several. */
export function changeSource(chunk: Chunk): string | null {
  return chunk.sources.length === 1 ? chunk.sources[0]! : null
}

/**
 * The block a structural change belongs to, as [from, to]: the styled block
 * that encloses it, or failing that the top-level block.
 *
 * Top-level is the fallback rather than the nearest ancestor because these
 * ranges have to splice: a wrap (paragraph → blockquote, paragraphs → list)
 * has endpoints at different depths, and only a whole-block replacement is
 * guaranteed to fit.
 */
function structuralBlockRangeAt(doc: PMNode, pos: number): [number, number] | null {
  const clamped = Math.min(pos, doc.content.size)
  const $pos = doc.resolve(clamped)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'styledBlock') return [$pos.before(d), $pos.after(d)]
  }
  const node = clamped < doc.content.size ? doc.nodeAt(clamped) : null
  if (node?.type.name === 'styledBlock') return [clamped, clamped + node.nodeSize]
  if ($pos.depth > 0) return [$pos.before(1), $pos.after(1)]
  if (node?.isBlock) return [clamped, clamped + node.nodeSize]
  // At the very end of the document depth is 0 and there is no node here —
  // an unwrap's closing token landed exactly there and stayed an unactionable
  // zero-width chunk of its own. Look at the block that ends here instead.
  if (clamped > 0) {
    const $before = doc.resolve(clamped - 1)
    if ($before.depth > 0) return [$before.before(1), $before.after(1)]
  }
  return null
}

/**
 * A styled-block wrap, unwrap, or attribute change surfaces as token-level
 * changes carrying no text (the open/close tokens themselves). Individually
 * those are unactionable — rejecting just an open token would splice half a
 * wrap — so all structural changes belonging to one styled block merge into
 * a single change spanning the whole block, which then displays, accepts,
 * and rejects as a unit. Blocks that also contain text changes are left
 * alone; their chunks already carry the story.
 */
function mergeBlockStructuralChanges(
  changes: Change<string>[],
  original: PMNode,
  doc: PMNode
): Change<string>[] {
  const structural = (c: Change<string>): boolean =>
    doc.textBetween(c.fromB, c.toB, ' ') === '' && original.textBetween(c.fromA, c.toA, ' ') === ''

  /**
   * Structural members grouped by the block being restructured.
   *
   * Keyed on the current document, because a wrap turns several blocks into
   * one and only the B side holds them together. The exception is a member
   * sitting exactly on a block boundary — an unwrap's closing token is at the
   * seam between the block it closes and the next one — which the document
   * hands to the FOLLOWING block. Left there, the merge spliced the unwrapped
   * block over whatever came after it.
   */
  const groups: { range: [number, number]; members: Change<string>[] }[] = []
  for (const change of changes) {
    if (!structural(change)) continue
    const range = structuralBlockRangeAt(doc, change.fromB)
    if (!range) continue
    const previous = groups[groups.length - 1]
    const sameBlock = previous?.range[0] === range[0]
    // A member reported against the FOLLOWING block because it sits on the
    // seam, or against the block that merely ends here (a closing token at the
    // very end of the document).
    const onSeam =
      previous !== undefined &&
      (previous.range[1] === change.fromB || range[1] <= previous.range[1])
    if (previous && (sameBlock || onSeam)) {
      previous.members.push(change)
      continue
    }
    groups.push({ range, members: [change] })
  }

  const out: Change<string>[] = []
  const merged = new Set<Change<string>>()
  const replacements: Change<string>[] = []
  /** No two replacements may claim the same original text. */
  const claimedA: [number, number][] = []
  for (const { range, members } of groups) {
    const interfering = changes.filter(
      (c) => !structural(c) && c.fromB < range[1] && c.toB > range[0]
    )
    // The author typed inside the wrapped block, and nothing else changed in
    // it: they have taken the wrap over with everything else. Dropping the
    // structural members leaves no chunk at all, which is right — what stayed
    // behind before was a pair of zero-width token chunks with ✓/✕ that did
    // nothing when clicked, over a wrap the save then wrote anyway.
    if (interfering.length > 0 && interfering.every((c) => narrow(c) === null)) {
      for (const m of members) merged.add(m)
      continue
    }
    if (interfering.length > 0) continue

    const first = members[0]!
    const fromB = range[0]
    const aStart =
      structuralBlockRangeAt(original, first.fromA) ??
      structuralBlockRangeAt(original, Math.max(0, first.fromA - 1))
    if (!aStart) continue
    const fromA = aStart[0]

    // Restructuring is not rewriting: whatever else moved, both sides say the
    // same words. Grow whichever end is behind until they agree — a wrap
    // gathers several original blocks into one, an unwrap does the reverse —
    // and give up rather than splice ranges that were paired wrong. Deriving
    // either end by arithmetic on the other's margins is what dropped a
    // paragraph when an author keystroke stretched a change.
    let toA = aStart[1]
    let toB = range[1]
    for (let guard = 0; guard < 16; guard++) {
      const aText = original.textBetween(fromA, toA, ' ')
      const bText = doc.textBetween(fromB, toB, ' ')
      if (aText === bText) break
      if (aText.length < bText.length && toA < original.content.size) {
        const next = structuralBlockRangeAt(original, toA)
        if (!next || next[1] <= toA) break
        toA = next[1]
      } else if (bText.length < aText.length && toB < doc.content.size) {
        const next = structuralBlockRangeAt(doc, toB)
        if (!next || next[1] <= toB) break
        toB = next[1]
      } else break
    }
    if (original.textBetween(fromA, toA, ' ') !== doc.textBetween(fromB, toB, ' ')) continue
    if (claimedA.some(([f, t]) => fromA < t && toA > f)) continue
    claimedA.push([fromA, toA])

    const data = first.inserted[0]?.data ?? first.deleted[0]?.data ?? null
    for (const m of members) merged.add(m)
    replacements.push(
      Change.fromJSON<string>({
        fromA,
        toA,
        fromB,
        toB,
        deleted: toA > fromA ? [{ length: toA - fromA, data }] : [],
        inserted: toB > fromB ? [{ length: toB - fromB, data }] : []
      })
    )
  }
  // `merged` can be non-empty with no replacements — an adopted wrap drops its
  // members and puts nothing back. Returning early on replacements alone left
  // them in the list.
  if (replacements.length === 0 && merged.size === 0) return changes
  for (const change of changes) {
    if (!merged.has(change)) out.push(change)
  }
  out.push(...replacements)
  return out.sort((a, b) => a.fromB - b.fromB)
}

function isAccepted(track: TrackState, c: { fromB: number; toB: number }): boolean {
  return track.accepted.some((a) => c.fromB >= a.from && c.toB <= a.to)
}

function undecided(changes: Change<string>[], track: TrackState): Chunk[] {
  const out: Chunk[] = []
  for (const change of changes) {
    const chunk = narrow(change)
    if (chunk && !isAccepted(track, chunk)) out.push(chunk)
  }
  return out
}

/**
 * Undecided suggestions, as display chunks. Author edits are not suggestions.
 *
 * Memoized on the document it was computed for: simplifyChanges plus the
 * structural merge is O(chunks), and the same list is wanted three times per
 * keystroke — by the decorations, by the savable projection, and by the count.
 */
function visibleChanges(state: TrackState, doc: PMNode): Chunk[] {
  if (state.chunkDoc === doc) return state.chunks
  const chunks = undecided(
    mergeBlockStructuralChanges(
      [...simplifyChanges(state.set.changes, doc)],
      state.original,
      doc
    ),
    state
  )
  state.chunks = chunks
  state.chunkDoc = doc
  return chunks
}

/**
 * The chunks a save reverts. Deliberately the same list the editor displays:
 * reverting raw token spans instead meant a wrap's open and close tokens were
 * spliced separately, at mismatched depths, which does not fit any document.
 */
function pendingRaw(track: TrackState, doc: PMNode): Chunk[] {
  return visibleChanges(track, doc)
}

/**
 * Applies `original`'s text back over the given chunks, descending so that
 * earlier positions stay valid.
 *
 * Through a Transform rather than `Node.replace`: a suggestion that wraps
 * content (a blockquote, a bullet list) produces chunks whose endpoints sit at
 * different depths, and `Node.replace` rejects those outright — which threw
 * inside `onUpdate` and silently stopped autosave for the rest of the session.
 * `Transform.replace` goes through replaceStep's fitting, which is also what
 * `rejectChangeAt` has always relied on for the same slices.
 */
function revert(doc: PMNode, original: PMNode, chunks: Chunk[]): PMNode {
  const tr = new Transform(doc)
  for (const c of [...chunks].sort((a, b) => b.fromB - a.fromB)) {
    if (c.fromB > tr.doc.content.size || c.toB > tr.doc.content.size) continue
    try {
      tr.replace(c.fromB, c.toB, original.slice(c.fromA, c.toA))
    } catch {
      // A chunk that will not splice back is left as it is rather than
      // taking the whole save down with it.
    }
  }
  return tr.doc
}

/**
 * The document as it should be SAVED: every undecided suggestion reverted,
 * everything accepted and everything the author typed kept. Autosave writes
 * this, so nothing the author has not agreed to reaches disk.
 */
export function savableDoc(state: EditorState): PMNode {
  const track = trackChangesKey.getState(state)
  if (!track) return state.doc
  return revert(state.doc, track.original, pendingRaw(track, state.doc))
}

/**
 * The document as one proposal still proposes it: everything decided, plus
 * only that proposal's undecided suggestions.
 */
export function proposedDoc(state: EditorState, proposalId: string): PMNode {
  const track = trackChangesKey.getState(state)
  if (!track) return state.doc
  const others = pendingRaw(track, state.doc).filter((c) => !c.sources.includes(proposalId))
  return revert(state.doc, track.original, others)
}

/** Unresolved suggested changes, simplified to display chunks. */
export function pendingChanges(state: EditorState): Chunk[] {
  const track = trackChangesKey.getState(state)
  return track ? visibleChanges(track, state.doc) : []
}

/** Number of unresolved suggested changes (for badges/tests). */
export function pendingChangeCount(state: EditorState): number {
  return pendingChanges(state).length
}

/* ------------------------------------------------------------------ */
/* Decorations                                                         */
/* ------------------------------------------------------------------ */

function deletionWidget(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'tc-del'
  span.setAttribute('contenteditable', 'false')
  span.textContent = text
  return span
}

function controlsWidget(
  accept: (pos: number) => void,
  reject: (pos: number) => void,
  pos: number,
  title: string
): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'tc-ctrl'
  wrap.setAttribute('contenteditable', 'false')
  if (title) wrap.title = title
  const mk = (label: string, hint: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = hint
    // mousedown would steal the selection; act without focusing.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      onClick()
    })
    return b
  }
  wrap.appendChild(mk('✓', 'Accept this change', () => accept(pos)))
  wrap.appendChild(mk('✕', 'Reject this change', () => reject(pos)))
  return wrap
}

function buildDecorations(
  track: TrackState,
  doc: PMNode,
  accept: (pos: number) => void,
  reject: (pos: number) => void,
  titles: Map<string, string>
): DecorationSet {
  const decos: Decoration[] = []
  for (const change of visibleChanges(track, doc)) {
    const { fromA, toA, fromB, toB } = change
    const insText = fromB < toB ? doc.textBetween(fromB, toB, ' ¶ ') : ''
    const delText = fromA < toA ? track.original.textBetween(fromA, toA, ' ¶ ') : ''
    // Identical text on both sides means the chunk is structural — a
    // styled-block attribute, a wrap/unwrap. Struck-through "deleted" text
    // identical to the highlighted text would read as nonsense, so mark the
    // range as a formatting change.
    const formattingOnly = insText !== '' && insText === delText
    const source = changeSource(change)
    const title = (source !== null ? titles.get(source) : undefined) ?? ''
    if (fromB < toB) {
      decos.push(
        Decoration.inline(
          fromB,
          toB,
          formattingOnly
            ? { class: 'tc-attr', title: title || 'Formatting change' }
            : { class: 'tc-ins', ...(title ? { title } : {}) }
        )
      )
    }
    if (!formattingOnly && delText) {
      decos.push(
        Decoration.widget(fromB, () => deletionWidget(delText), {
          side: -1,
          // A stable key stops ProseMirror recreating the DOM for every
          // widget on every transaction, including plain cursor moves.
          key: `tc-del:${fromA}:${toA}:${fromB}`
        })
      )
    }
    decos.push(
      Decoration.widget(
        Math.max(toB, fromB),
        () => controlsWidget(accept, reject, fromB, title),
        { side: 1, key: `tc-ctrl:${fromB}:${toB}` }
      )
    )
  }
  return DecorationSet.create(doc, decos)
}

/* ------------------------------------------------------------------ */
/* The extension                                                       */
/* ------------------------------------------------------------------ */

export interface TrackChangesOptions {
  /**
   * Attached at editor creation — no transaction, so opening a document that
   * already has suggestions never disturbs the caret. Null starts inert;
   * `attachSuggestions` turns it on later without recreating the editor.
   */
  suggestion: AttachSpec | null
  /** proposalId → human label, for per-chunk attribution on hover. */
  titles?: Record<string, string>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      /** Accept the suggested change containing the given position. */
      acceptChangeAt: (pos: number) => ReturnType
      /** Reject the suggested change containing the given position. */
      rejectChangeAt: (pos: number) => ReturnType
      acceptAllChanges: () => ReturnType
      rejectAllChanges: () => ReturnType
      /** Replaces the doc with the folded suggestions and shows them. */
      attachSuggestions: (spec: AttachSpec) => ReturnType
      /** Drops the overlay, leaving the savable document behind. */
      detachSuggestions: () => ReturnType
      /** Moves the caret to the next suggestion after it, wrapping. */
      goToNextSuggestion: () => ReturnType
    }
  }
}

function attachedState(schema: PMNode['type']['schema'], doc: PMNode, spec: AttachSpec): TrackState {
  const original = markdownToDoc(schema, spec.original)
  const chain = spec.chain.map((link, i) => ({
    proposalId: link.proposalId,
    // The last link IS the editor document; re-parsing it would risk a
    // mismatch with what the editor actually holds.
    doc: i === spec.chain.length - 1 ? doc : markdownToDoc(schema, link.content)
  }))
  return {
    original,
    set: chain.length > 0 ? foldChain(original, chain) : ChangeSet.create<string>(original, undefined, attrsAwareEncoder),
    accepted: [],
    decos: DecorationSet.empty,
    chunks: [],
    chunkDoc: null
  }
}

export const TrackChanges = Extension.create<TrackChangesOptions>({
  name: 'trackChanges',

  addOptions() {
    return { suggestion: null }
  },

  addCommands() {
    const findChange = (
      state: { doc: PMNode },
      pos: number
    ): { change: Chunk; track: TrackState } | null => {
      const track = trackChangesKey.getState(state as never)
      if (!track) return null
      const change = visibleChanges(track, state.doc).find(
        (c) => pos >= c.fromB && pos <= Math.max(c.toB, c.fromB)
      )
      return change ? { change, track } : null
    }

    return {
      acceptChangeAt:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const found = findChange(state, pos)
          if (!found) return false
          if (dispatch) {
            const { fromB, toB } = found.change
            tr.setMeta(trackChangesKey, {
              accept: { from: fromB, to: Math.max(toB, fromB) }
            } satisfies TrackMeta)
            dispatch(tr)
          }
          return true
        },
      rejectChangeAt:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const found = findChange(state, pos)
          if (!found) return false
          if (dispatch) {
            const { fromA, toA, fromB, toB } = found.change
            tr.replace(fromB, toB, found.track.original.slice(fromA, toA))
            dispatch(tr)
          }
          return true
        },
      acceptAllChanges:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(trackChangesKey, { acceptAll: true } satisfies TrackMeta)
            dispatch(tr)
          }
          return true
        },
      rejectAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const track = trackChangesKey.getState(state)
          if (!track) return false
          if (dispatch) {
            // Descending order keeps earlier positions valid within one tr.
            const changes = [...visibleChanges(track, state.doc)].sort((a, b) => b.fromB - a.fromB)
            for (const c of changes) {
              tr.replace(c.fromB, c.toB, track.original.slice(c.fromA, c.toA))
            }
            dispatch(tr)
          }
          return true
        },
      attachSuggestions:
        (spec) =>
        ({ state, tr, dispatch }) => {
          if (dispatch) {
            const next = markdownToDoc(state.schema, spec.chain[spec.chain.length - 1]?.content ?? '')
            tr.replace(0, state.doc.content.size, next.slice(0, next.content.size))
            tr.setMeta(trackChangesKey, { attach: spec } satisfies TrackMeta)
            // Suggestions ARRIVING is not an edit the author can undo — and
            // undoing it would leave the plugin diffing against an original
            // the document no longer matches.
            tr.setMeta('addToHistory', false)
            dispatch(tr)
          }
          return true
        },
      detachSuggestions:
        () =>
        ({ state, tr, dispatch }) => {
          const track = trackChangesKey.getState(state)
          if (!track) return false
          if (dispatch) {
            const savable = revert(state.doc, track.original, pendingRaw(track, state.doc))
            tr.replace(0, state.doc.content.size, savable.slice(0, savable.content.size))
            tr.setMeta(trackChangesKey, { detach: true } satisfies TrackMeta)
            tr.setMeta('addToHistory', false)
            dispatch(tr)
          }
          return true
        },
      goToNextSuggestion:
        () =>
        ({ state, tr, dispatch }) => {
          const track = trackChangesKey.getState(state)
          if (!track) return false
          const changes = visibleChanges(track, state.doc)
          if (changes.length === 0) return false
          const after = state.selection.to
          const next = changes.find((c) => c.fromB > after) ?? changes[0]!
          if (dispatch) {
            // A whole-block insertion's chunk starts at a depth-0 position,
            // where TextSelection.create yields an invalid caret.
            tr.setSelection(
              TextSelection.near(tr.doc.resolve(Math.min(next.fromB, tr.doc.content.size)), 1)
            )
            tr.scrollIntoView()
            tr.setMeta('addToHistory', false)
            dispatch(tr)
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const options = this.options
    const accept = (pos: number): void => {
      editor.chain().acceptChangeAt(pos).focus().run()
    }
    const reject = (pos: number): void => {
      editor.chain().rejectChangeAt(pos).focus().run()
    }
    const titles = new Map(Object.entries(options.titles ?? {}))

    return [
      new Plugin<TrackState>({
        key: trackChangesKey,
        state: {
          init: (_config, state) => {
            const inert: TrackState = {
              original: state.doc,
              set: ChangeSet.create<string>(state.doc, undefined, attrsAwareEncoder),
              accepted: [],
              decos: DecorationSet.empty,
              chunks: [],
              chunkDoc: null
            }
            const track = options.suggestion
              ? attachedState(state.schema, state.doc, options.suggestion)
              : inert
            return {
              ...track,
              decos: buildDecorations(track, state.doc, accept, reject, titles)
            }
          },
          apply: (tr, value, _old, newState) => {
            const meta = tr.getMeta(trackChangesKey) as TrackMeta | undefined
            if (meta?.attach) {
              const track = attachedState(newState.schema, newState.doc, meta.attach)
              return { ...track, decos: buildDecorations(track, newState.doc, accept, reject, titles) }
            }
            if (meta?.detach) {
              return {
                original: newState.doc,
                set: ChangeSet.create<string>(newState.doc, undefined, attrsAwareEncoder),
                accepted: [],
                decos: DecorationSet.empty,
                chunks: [],
                chunkDoc: null
              }
            }

            let { set, accepted } = value
            if (tr.docChanged) {
              // The author's own edits carry AUTHOR, so they never render as
              // suggestions and a save keeps them.
              set = set.addSteps(newState.doc, tr.mapping.maps, AUTHOR)
              accepted = accepted.map((r) => ({
                from: tr.mapping.map(r.from, -1),
                to: tr.mapping.map(r.to, 1)
              }))
            }
            if (meta?.acceptAll) {
              accepted = [{ from: 0, to: newState.doc.content.size }]
            } else if (meta?.accept) {
              accepted = [...accepted, meta.accept]
            }

            const next: TrackState = {
              original: value.original,
              set,
              accepted,
              decos: value.decos,
              chunks: [],
              chunkDoc: null
            }
            // Rebuild only when something could have moved. ProseMirror asks
            // for decorations on EVERY transaction, arrow keys included, and
            // re-simplifying hundreds of chunks per keypress is visible.
            if (tr.docChanged || meta) {
              next.decos = buildDecorations(next, newState.doc, accept, reject, titles)
            }
            return next
          }
        },
        props: {
          decorations(state) {
            return trackChangesKey.getState(state)?.decos ?? DecorationSet.empty
          }
        }
      })
    ]
  }
})

/** Markdown of the document as it should be saved. */
export function savableMarkdown(state: EditorState): string {
  return docToMarkdown(savableDoc(state))
}

/** Markdown of what one proposal still proposes. */
export function proposedMarkdown(state: EditorState, proposalId: string): string {
  return docToMarkdown(proposedDoc(state, proposalId))
}
