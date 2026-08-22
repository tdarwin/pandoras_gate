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
 * The top-level blocks of `original` paired with those of `doc`, in order and
 * covering both documents completely.
 *
 * This is the frame the structural merge works in. Earlier rounds derived a
 * wrap's two ranges from each other — a block range on one side plus
 * arithmetic on the other's margins, or growth until the two sides said the
 * same words — and every fix in that shape cured one direction and broke the
 * other, because a wrap gathers several blocks into one and an unwrap does the
 * reverse. Aligning both documents ONCE makes the pairing a fact rather than a
 * derivation: segments are ordered and disjoint on both sides, so two
 * restructured blocks side by side can no longer claim each other's text.
 */
interface Segment {
  aFrom: number
  aTo: number
  bFrom: number
  bTo: number
}

function alignTopLevel(a: PMNode, b: PMNode): Segment[] {
  const kidsA: PMNode[] = []
  const kidsB: PMNode[] = []
  a.forEach((n) => kidsA.push(n))
  b.forEach((n) => kidsB.push(n))

  const startsA: number[] = []
  let p = 0
  for (const n of kidsA) {
    startsA.push(p)
    p += n.nodeSize
  }
  const endA = p
  const startsB: number[] = []
  p = 0
  for (const n of kidsB) {
    startsB.push(p)
    p += n.nodeSize
  }
  const endB = p

  const out: Segment[] = []
  const push = (ia: number, na: number, ib: number, nb: number): void => {
    const aFrom = na > 0 ? startsA[ia]! : startsA[ia] ?? endA
    const aTo = na > 0 ? startsA[ia + na - 1]! + kidsA[ia + na - 1]!.nodeSize : aFrom
    const bFrom = nb > 0 ? startsB[ib]! : startsB[ib] ?? endB
    const bTo = nb > 0 ? startsB[ib + nb - 1]! + kidsB[ib + nb - 1]!.nodeSize : bFrom
    out.push({ aFrom, aTo, bFrom, bTo })
  }

  const parts = diffArrays(kidsA.map(blockKey), kidsB.map(blockKey))
  let ia = 0
  let ib = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const n = part.count ?? part.value.length
    if (!part.added && !part.removed) {
      for (let k = 0; k < n; k++) push(ia + k, 1, ib + k, 1)
      ia += n
      ib += n
      continue
    }
    const next = parts[i + 1]
    if (part.removed && next?.added) {
      const m = next.count ?? next.value.length
      // Same 1:1 split as the alignment used for diffing: a run of equal
      // length is a block-for-block rewrite, so each pair gets its own
      // segment and two adjacent wraps stay two chunks.
      if (n === m) for (let k = 0; k < n; k++) push(ia + k, 1, ib + k, 1)
      else push(ia, n, ib, m)
      ia += n
      ib += m
      i += 1
      continue
    }
    if (part.removed) {
      push(ia, n, ib, 0)
      ia += n
    } else {
      push(ia, 0, ib, n)
      ib += n
    }
  }
  return out
}

/** Spans totalling `length`, one per source, so a fused chunk keeps its attribution. */
function sourceSpans(length: number, sources: string[]): { length: number; data: string }[] {
  if (length <= 0) return []
  if (sources.length === 1 || length < sources.length) return [{ length, data: sources[0]! }]
  const each = Math.floor(length / sources.length)
  return sources.map((data, i) => ({
    length: i === sources.length - 1 ? length - each * (sources.length - 1) : each,
    data
  }))
}

/**
 * A wrap, unwrap, or attribute change surfaces as token-level changes carrying
 * no text — the open and close tokens themselves. Individually those are
 * unactionable: rejecting an open token alone splices half a wrap, which is
 * not a document. So every structural change belonging to one restructured
 * block is merged into a single change spanning the whole block, which then
 * displays, accepts, and reverts as a unit.
 *
 * A group that cannot be merged DROPS its members rather than leaving them
 * behind. An unmergeable wrap is not revertible at all, and the two ways of
 * leaving it were both worse than letting it stand: raw token spans splice
 * individually and corrupt the saved document (a duplicated paragraph, an
 * empty list item), and they render as ✓/✕ over no text at all — buttons that
 * do damage when clicked and nothing when read. Dropping degrades to the rule
 * author interference already follows: the block is the author's.
 */
function mergeBlockStructuralChanges(
  changes: Change<string>[],
  original: PMNode,
  doc: PMNode
): Change<string>[] {
  const structural = (c: Change<string>): boolean =>
    doc.textBetween(c.fromB, c.toB, ' ') === '' && original.textBetween(c.fromA, c.toA, ' ') === ''

  const members = changes.filter(structural)
  if (members.length === 0) return changes

  let segments: Segment[]
  try {
    segments = alignTopLevel(original, doc)
  } catch {
    segments = []
  }

  /**
   * The segment a change belongs to: the last one starting at or before it on
   * BOTH sides. An unwrap's closing token sits on the seam between the block
   * it closes and the next, and the document hands it to the following block —
   * but its deletion is still inside the previous block in the original, so
   * the A side pins it. The mirror case is the opening token of a second
   * restructured block, whose insertion is at that same seam and whose A
   * position is the start of the next original block: there the B side pins
   * it. Requiring both is what tells the two apart.
   */
  const indexOf = (c: Change<string>): number => {
    let found = -1
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!
      if (s.aFrom <= c.fromA && s.bFrom <= c.fromB) found = i
      else break
    }
    return found
  }

  // Segment spans, one per structural change, widened until the change fits.
  const spans: [number, number][] = []
  const unplaced = new Set<Change<string>>()
  for (const change of members) {
    const lo = indexOf(change)
    if (lo < 0) {
      unplaced.add(change)
      continue
    }
    let hi = lo
    while (
      hi + 1 < segments.length &&
      (change.toA > segments[hi]!.aTo || change.toB > segments[hi]!.bTo)
    )
      hi++
    if (change.toA > segments[hi]!.aTo || change.toB > segments[hi]!.bTo) {
      unplaced.add(change)
      continue
    }
    spans.push([lo, hi])
  }

  /**
   * The changes a replacement over these segments would swallow. A zero-width
   * change counts only when it is STRICTLY inside, so a deletion written at a
   * block boundary belongs to the block it was written against rather than to
   * both of them.
   */
  const covering = (lo: number, hi: number): Change<string>[] => {
    const aFrom = segments[lo]!.aFrom
    const aTo = segments[hi]!.aTo
    const bFrom = segments[lo]!.bFrom
    const bTo = segments[hi]!.bTo
    return changes.filter((c) => {
      const aHit =
        c.toA > c.fromA ? c.fromA < aTo && c.toA > aFrom : c.fromA > aFrom && c.fromA < aTo
      const bHit =
        c.toB > c.fromB ? c.fromB < bTo && c.toB > bFrom : c.fromB > bFrom && c.fromB < bTo
      return aHit || bHit
    })
  }
  const holds = (lo: number, hi: number, c: Change<string>): boolean =>
    c.fromA >= segments[lo]!.aFrom &&
    c.toA <= segments[hi]!.aTo &&
    c.fromB >= segments[lo]!.bFrom &&
    c.toB <= segments[hi]!.bTo

  // Overlapping spans are one restructuring seen from several tokens. Groups
  // then grow to hold every change they touch — a rewrite that crosses a block
  // boundary has to travel with the restructuring, not be spliced across it —
  // and growing can make two groups meet, so this settles rather than passes.
  const groups: [number, number][] = []
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  for (const [lo, hi] of spans) {
    const last = groups[groups.length - 1]
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else groups.push([lo, hi])
  }
  for (let pass = 0; pass < 8; pass++) {
    let grew = false
    for (const g of groups) {
      for (const c of covering(g[0], g[1])) {
        while (
          g[0] > 0 &&
          (c.fromA < segments[g[0]]!.aFrom || c.fromB < segments[g[0]]!.bFrom)
        ) {
          g[0]--
          grew = true
        }
        while (
          g[1] + 1 < segments.length &&
          (c.toA > segments[g[1]]!.aTo || c.toB > segments[g[1]]!.bTo)
        ) {
          g[1]++
          grew = true
        }
      }
    }
    if (!grew) break
    for (let i = groups.length - 1; i > 0; i--) {
      if (groups[i]![0] <= groups[i - 1]![1]) {
        groups[i - 1]![1] = Math.max(groups[i - 1]![1], groups[i]![1])
        groups.splice(i, 1)
      }
    }
  }

  const dropped = new Set<Change<string>>(unplaced)
  const replacements: Change<string>[] = []
  for (const [lo, hi] of groups) {
    const aFrom = segments[lo]!.aFrom
    const aTo = segments[hi]!.aTo
    const fromB = segments[lo]!.bFrom
    const toB = segments[hi]!.bTo
    const inside = covering(lo, hi)

    /**
     * The author typed in the block being restructured.
     *
     * Their keystroke fuses into the token change itself — the list-open
     * deletion and the first character arrive as one change — so there is no
     * separating the two, and the whole block becomes theirs, chunks and all.
     * That is the adjacent-typing rule at block scale, and it errs the same
     * way: a wrap they did not ask for is a smaller harm than a save that eats
     * the sentence they just wrote.
     *
     * Only a change carrying TEXT can be theirs. Changeset re-attributes spans
     * as it merges, so an author tag turns up on the closing token of a wrap
     * three blocks away from anything they touched; a token change is never
     * evidence of typing.
     */
    const authored = inside.some((c) => !structural(c) && sourcesOf(c).includes(AUTHOR))
    const sources: string[] = []
    for (const c of inside)
      for (const s of sourcesOf(c)) if (s !== AUTHOR && !sources.includes(s)) sources.push(s)

    // Nothing of a proposal left to propose, a change that still will not fit,
    // or a block the author has taken over: drop, never splice.
    if (authored || sources.length === 0 || inside.some((c) => !holds(lo, hi, c))) {
      for (const c of inside) dropped.add(c)
      continue
    }

    for (const c of inside) dropped.add(c)
    replacements.push(
      Change.fromJSON<string>({
        fromA: aFrom,
        toA: aTo,
        fromB,
        toB,
        deleted: sourceSpans(aTo - aFrom, sources),
        inserted: sourceSpans(toB - fromB, sources)
      })
    )
  }

  const out: Change<string>[] = []
  for (const change of changes) {
    if (dropped.has(change)) continue
    // Belt and braces: a change with nothing to insert and no original text to
    // show as deleted can only render as ✓/✕ over nothing.
    if (change.fromB === change.toB && original.textBetween(change.fromA, change.toA, ' ') === '')
      continue
    out.push(change)
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
