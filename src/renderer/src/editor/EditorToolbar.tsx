import { useEffect, useReducer } from 'react'
import type { EditorHandle } from './MarkdownEditor'

/**
 * The formatting bar: a dedicated strip between the chapter details and the
 * prose editor. It drives the editor through EditorHandle (never the editor
 * library directly) and re-reads active states on every editor transaction,
 * so buttons and the style dropdown highlight the selection's formatting.
 */
export default function EditorToolbar({
  handle
}: {
  handle: EditorHandle | null
}): React.JSX.Element {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!handle) return
    return handle.subscribe(bump)
  }, [handle])

  const active = (name: string, attrs?: Record<string, unknown>): boolean =>
    handle !== null && handle.isActive(name, attrs)

  const btn = (on: boolean): string =>
    `rounded px-1.5 py-0.5 text-xs transition-colors disabled:opacity-40 ${
      on ? 'bg-raised text-ink' : 'text-ink-faint hover:bg-raised hover:text-ink'
    }`

  const headingValue = active('heading', { level: 1 })
    ? '1'
    : active('heading', { level: 2 })
      ? '2'
      : active('heading', { level: 3 })
        ? '3'
        : '0'

  const disabled = handle === null
  const divider = <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-3">
      <select
        value={headingValue}
        disabled={disabled}
        onChange={(e) => handle?.setHeading(Number(e.target.value) as 0 | 1 | 2 | 3)}
        title="Paragraph style"
        className="shrink-0 rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink-muted outline-none disabled:opacity-40"
      >
        <option value="0">Body text</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>

      {divider}

      <button onClick={() => handle?.toggleBold()} disabled={disabled} title="Bold (⌘B)" className={`${btn(active('bold'))} font-bold`}>
        B
      </button>
      <button onClick={() => handle?.toggleItalic()} disabled={disabled} title="Italic (⌘I)" className={`${btn(active('italic'))} italic`}>
        I
      </button>
      <button onClick={() => handle?.toggleUnderline()} disabled={disabled} title="Underline (⌘U)" className={`${btn(active('underline'))} underline underline-offset-2`}>
        U
      </button>
      <button onClick={() => handle?.toggleStrike()} disabled={disabled} title="Strikethrough (⇧⌘S)" className={`${btn(active('strike'))} line-through`}>
        S
      </button>
      <button onClick={() => handle?.toggleCode()} disabled={disabled} title="Inline code (⌘E)" className={`${btn(active('code'))} font-mono`}>
        {'<>'}
      </button>

      {divider}

      <button onClick={() => handle?.toggleBlockquote()} disabled={disabled} title="Quote (⇧⌘B)" className={btn(active('blockquote'))}>
        ❝
      </button>
      <button onClick={() => handle?.toggleBulletList()} disabled={disabled} title="Bullet list (⇧⌘8)" className={btn(active('bulletList'))}>
        •
      </button>
      <button onClick={() => handle?.toggleOrderedList()} disabled={disabled} title="Numbered list (⇧⌘7)" className={btn(active('orderedList'))}>
        1.
      </button>
      <button onClick={() => handle?.toggleCodeBlock()} disabled={disabled} title="Code block — preformatted monospace text (⌥⌘C)" className={`${btn(active('codeBlock'))} font-mono`}>
        {'{ }'}
      </button>

      {divider}

      <button onClick={() => handle?.insertHorizontalRule()} disabled={disabled} title="Horizontal rule (scene break)" className={btn(false)}>
        —
      </button>
      <button onClick={() => handle?.insertTable()} disabled={disabled} title="Insert table (3×3, header row)" className={btn(active('table'))}>
        ⊞
      </button>

      {active('table') && (
        <span className="flex items-center gap-0.5 pl-1">
          <button onClick={() => handle?.addRowAfter()} title="Add a row below" className={btn(false)}>
            +Row
          </button>
          <button onClick={() => handle?.addColumnAfter()} title="Add a column to the right" className={btn(false)}>
            +Col
          </button>
          <button onClick={() => handle?.deleteRow()} title="Delete this row" className={btn(false)}>
            −Row
          </button>
          <button onClick={() => handle?.deleteColumn()} title="Delete this column" className={btn(false)}>
            −Col
          </button>
          <button
            onClick={() => handle?.deleteTable()}
            title="Delete the whole table"
            className="rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-red-400"
          >
            ✕ Table
          </button>
        </span>
      )}
    </div>
  )
}
