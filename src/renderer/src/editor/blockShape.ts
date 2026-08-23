import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Whether two documents have the same block structure — the same blocks, of
 * the same kinds, nested the same way. Only the words inside them may differ.
 *
 * This is the gate on inline review. Tracked changes decide a suggestion by
 * SPLICING the original back over the proposal's range, so a mis-paired block
 * is not a display glitch, it is prose lost from the saved document — and
 * pairing blocks between two documents that hold different numbers of them is
 * ambiguous in ways no amount of care resolves. A wrap gathers N blocks into
 * one, an unwrap splits one into N, an inserted paragraph shifts everything
 * after it, and the author is typing into the result the whole time.
 *
 * So a proposal that changes the shape of the document is not shown inline at
 * all; it is decided whole, against a word diff. This test is deliberately
 * strict — attribute changes count, a trailing empty paragraph counts — since
 * a false negative is the data loss and a false positive only costs the author
 * the finer-grained review of a document the AI restructured anyway.
 *
 * Shape is only half the gate. `splitInlineChain` (track-changes.ts) also
 * requires that a link actually PRODUCE chunks, because the changeset's
 * character encoder is mark-blind and a proposal that only adds emphasis has
 * the same shape and the same words while still changing the file.
 */
export function sameBlockShape(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) {
    const ca = a.child(i)
    const cb = b.child(i)
    if (!ca.sameMarkup(cb)) return false
    // Text blocks may say anything; containers must hold the same shape.
    if (ca.isTextblock) continue
    if (ca.isLeaf !== cb.isLeaf) return false
    if (!ca.isLeaf && !sameBlockShape(ca, cb)) return false
  }
  return true
}
