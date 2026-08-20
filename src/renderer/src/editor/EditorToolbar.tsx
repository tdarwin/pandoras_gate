import { useEffect, useReducer, useRef, useState } from 'react'
import { NAMED_TINTS, isNamedTint, type NamedTint } from '@shared/markdownAttrs'
import { FONT_SUGGESTIONS } from '../lib/fonts'
import type { EditorHandle } from './MarkdownEditor'

const TINT_LABELS: Record<NamedTint, string> = {
  note: 'Note',
  success: 'Success',
  warning: 'Warning',
  danger: 'Danger',
  neutral: 'Neutral'
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Commit-on-Enter/blur text input for a font name; empty clears. */
function FontField({
  label,
  value,
  onCommit
}: {
  label: string
  value: string
  onCommit: (font: string | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string): void => {
    const font = raw.trim()
    onCommit(font === '' ? null : font)
    setDraft(null)
  }
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-ink-muted">
      {label}
      <input
        list="pandora-toolbar-fonts"
        value={draft ?? value}
        placeholder="Theme font"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
        }}
        className="w-40 rounded border border-line-strong bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-indigo-500"
      />
    </label>
  )
}

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

  // Styled-block state for the align buttons and tint select.
  const blockAttrs = handle?.getAttributes('styledBlock') ?? {}
  const bg = typeof blockAttrs['bg'] === 'string' ? blockAttrs['bg'] : null
  const blockFont = typeof blockAttrs['font'] === 'string' ? blockAttrs['font'] : ''
  const [customTint, setCustomTint] = useState(false)
  const tintValue = customTint ? 'custom' : bg === null ? '' : isNamedTint(bg) ? bg : 'custom'

  // The "Aa" format menu renders position:fixed — the toolbar scrolls
  // horizontally, and an absolute child would be clipped by the overflow.
  const [fontsOpen, setFontsOpen] = useState(false)
  const [fontsPos, setFontsPos] = useState<{ left: number; top: number } | null>(null)
  const fontsBtnRef = useRef<HTMLButtonElement | null>(null)
  const toggleFonts = (): void => {
    if (!fontsOpen && fontsBtnRef.current) {
      const r = fontsBtnRef.current.getBoundingClientRect()
      setFontsPos({ left: Math.max(8, r.right - 224), top: r.bottom + 4 })
    }
    setFontsOpen((v) => !v)
  }

  const spanFontAttrs = handle?.getAttributes('font') ?? {}
  const spanFont = typeof spanFontAttrs['family'] === 'string' ? spanFontAttrs['family'] : ''
  const imageAlt =
    active('image') && typeof handle?.getAttributes('image')['alt'] === 'string'
      ? (handle.getAttributes('image')['alt'] as string)
      : ''

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
      <button onClick={() => handle?.insertImage()} disabled={disabled} title="Insert image — copied into the novel's assets folder" className={btn(active('image'))}>
        🖼
      </button>

      {divider}

      <button
        onClick={() => handle?.setBlockAlign(active('styledBlock', { align: 'center' }) ? null : 'center')}
        disabled={disabled}
        title="Center this block (an epigraph, a sign-off)"
        className={btn(active('styledBlock', { align: 'center' }))}
      >
        ↔
      </button>
      <button
        onClick={() => handle?.setBlockAlign(active('styledBlock', { align: 'right' }) ? null : 'right')}
        disabled={disabled}
        title="Right-align this block"
        className={btn(active('styledBlock', { align: 'right' }))}
      >
        →
      </button>
      <select
        value={tintValue}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'custom') {
            setCustomTint(true)
            return
          }
          setCustomTint(false)
          if (v === '') handle?.setBlockBg(null)
          else handle?.setBlockBg(v)
        }}
        title="Highlight this block with a tint — named tints follow the theme"
        className="shrink-0 rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink-muted outline-none disabled:opacity-40"
      >
        <option value="">No tint</option>
        {NAMED_TINTS.map((t) => (
          <option key={t} value={t}>
            {TINT_LABELS[t]}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {tintValue === 'custom' && (
        <input
          defaultValue={bg?.startsWith('#') ? bg : ''}
          placeholder="#rrggbb"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const v = e.currentTarget.value.trim().toLowerCase()
            if (HEX_RE.test(v)) {
              handle?.setBlockBg(v)
              setCustomTint(false)
            }
          }}
          title="A hex color, applied on Enter"
          className="w-20 shrink-0 rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs text-ink outline-none focus:border-indigo-500"
        />
      )}
      <button
        ref={fontsBtnRef}
        onClick={toggleFonts}
        disabled={disabled}
        title="Fonts — for the selected text or the current block"
        className={btn(fontsOpen || active('font') || blockFont !== '')}
      >
        Aa
      </button>

      {active('image') && (
        <span className="flex items-center gap-1 pl-1">
          <input
            key={imageAlt}
            defaultValue={imageAlt}
            placeholder="Alt text…"
            onBlur={(e) => handle?.setImageAlt(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handle?.setImageAlt(e.currentTarget.value.trim())
            }}
            title="A short description of the image (saved into the markdown)"
            className="w-36 shrink-0 rounded border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-ink outline-none focus:border-indigo-500"
          />
        </span>
      )}

      {fontsOpen && fontsPos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFontsOpen(false)} />
          <div
            className="fixed z-50 flex w-56 flex-col gap-2 rounded-lg border border-line bg-panel p-3 shadow-xl"
            style={{ left: fontsPos.left, top: fontsPos.top }}
          >
            <FontField
              label="Selection"
              value={spanFont}
              onCommit={(font) => handle?.setSpanFont(font)}
            />
            <FontField
              label="Block"
              value={blockFont}
              onCommit={(font) => handle?.setBlockFont(font)}
            />
            <p className="text-[10px] leading-snug text-ink-faint">
              Any installed font, by name. Empty returns to the theme font.
            </p>
            <datalist id="pandora-toolbar-fonts">
              {FONT_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
        </>
      )}

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
