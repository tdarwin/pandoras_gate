import { useMemo } from 'react'
import { diffWords } from 'diff'

/**
 * Word-level diff of two texts. Used where a tracked-changes overlay cannot
 * go: frontmatter fields, YAML entries.
 *
 * The memo is load-bearing, not tidiness — a whole-document diff runs into
 * hundreds of milliseconds on a long chapter, and React will re-render this
 * for reasons that have nothing to do with the text.
 */
export default function WordDiff({
  oldText,
  newText
}: {
  oldText: string
  newText: string
}): React.JSX.Element {
  const parts = useMemo(() => diffWords(oldText, newText), [oldText, newText])
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-2 text-xs leading-relaxed">
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.added
              ? 'bg-emerald-950 text-emerald-300'
              : part.removed
                ? 'bg-red-950 text-red-400 line-through'
                : 'text-ink-faint'
          }
        >
          {part.value}
        </span>
      ))}
    </pre>
  )
}
