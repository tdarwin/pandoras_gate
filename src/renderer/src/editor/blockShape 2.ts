import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { markdownToDoc } from './markdown'

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

/**
 * The links of a chain that may be reviewed inline, and the first one that
 * may not.
 *
 * A structural link takes everything after it with it: later links were folded
 * ON TOP of it, so their content assumes it. Once the earlier ones are
 * decided, the fold re-anchors and the structural one comes back as the first.
 */
export function splitChainAtStructural<T extends { content: string }>(
  schema: Schema,
  original: string,
  chain: T[]
): { inline: T[]; structural: T[] } {
  let previous: PMNode
  try {
    previous = markdownToDoc(schema, original)
  } catch {
    // A document we cannot even parse is not one to overlay.
    return { inline: [], structural: chain }
  }
  for (let i = 0; i < chain.length; i++) {
    let next: PMNode
    try {
      next = markdownToDoc(schema, chain[i]!.content)
    } catch {
      return { inline: chain.slice(0, i), structural: chain.slice(i) }
    }
    if (!sameBlockShape(previous, next)) {
      return { inline: chain.slice(0, i), structural: chain.slice(i) }
    }
    previous = next
  }
  return { inline: chain, structural: [] }
}
