import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'

/**
 * Markdown formatting commands for the style toolbar — so authors don't need
 * to know the syntax. All operate on the current selection/line and keep the
 * cursor sensible.
 */

/** Wraps (or unwraps) the selection with an inline marker like ** or *. */
export function toggleInline(view: EditorView, marker: string): void {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to)
    const before = view.state.sliceDoc(Math.max(0, range.from - marker.length), range.from)
    const after = view.state.sliceDoc(range.to, range.to + marker.length)

    if (before === marker && after === marker) {
      // Unwrap.
      return {
        changes: [
          { from: range.from - marker.length, to: range.from, insert: '' },
          { from: range.to, to: range.to + marker.length, insert: '' }
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length)
      }
    }
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
      return {
        changes: { from: range.from, to: range.to, insert: text.slice(marker.length, -marker.length) },
        range: EditorSelection.range(range.from, range.to - marker.length * 2)
      }
    }
    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
      range: EditorSelection.range(range.from + marker.length, range.to + marker.length)
    }
  })
  view.dispatch(changes)
  view.focus()
}

/** Sets (or clears, with level 0) the heading level of each selected line. */
export function setHeading(view: EditorView, level: number): void {
  const { state } = view
  const changes: { from: number; to: number; insert: string }[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    let pos = range.from
    for (;;) {
      const line = state.doc.lineAt(pos)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        const current = /^(#{1,6})\s/.exec(line.text)
        const stripped = current ? line.text.slice(current[0].length) : line.text
        const prefix = level > 0 ? `${'#'.repeat(level)} ` : ''
        changes.push({ from: line.from, to: line.to, insert: prefix + stripped })
      }
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  view.dispatch({ changes })
  view.focus()
}

/** Toggles a line prefix (e.g. "> " or "- ") on each selected line. */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view
  const changes: { from: number; to: number; insert: string }[] = []
  const seen = new Set<number>()
  let allPrefixed = true
  const lines: { from: number; to: number; text: string }[] = []
  for (const range of state.selection.ranges) {
    let pos = range.from
    for (;;) {
      const line = state.doc.lineAt(pos)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        lines.push({ from: line.from, to: line.to, text: line.text })
        if (!line.text.startsWith(prefix)) allPrefixed = false
      }
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  for (const line of lines) {
    if (allPrefixed) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else if (!line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from, insert: prefix })
    }
  }
  view.dispatch({ changes })
  view.focus()
}
