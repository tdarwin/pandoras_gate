import { useState } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Frontmatter without the YAML: a collapsible details strip above the editor.
 * Scalar fields edit as plain inputs; structured fields (lists, maps) edit as
 * YAML in a textarea with validation. The document on disk keeps its
 * frontmatter — writers just never have to look at fences.
 */

const isScalar = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

const scalarToText = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** "3" → 3, "true" → true, prose stays prose. */
function textToScalar(text: string): unknown {
  const t = text.trim()
  if (!t) return ''
  try {
    const parsed: unknown = parseYaml(t)
    return isScalar(parsed) ? parsed : text
  } catch {
    return text
  }
}

function ScalarField({
  value,
  locked,
  onCommit
}: {
  value: unknown
  locked: boolean
  onCommit: (v: unknown) => void
}): React.JSX.Element {
  const [text, setText] = useState(scalarToText(value))
  return (
    <input
      value={text}
      disabled={locked}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => !locked && onCommit(textToScalar(text))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(scalarToText(value))
      }}
      className="w-full rounded border border-transparent bg-transparent px-2 py-1 text-sm text-ink outline-none hover:border-line focus:border-indigo-500 disabled:text-ink-muted"
    />
  )
}

function YamlField({
  value,
  onCommit
}: {
  value: unknown
  onCommit: (v: unknown) => void
}): React.JSX.Element {
  const [text, setText] = useState(stringifyYaml(value).trimEnd())
  const [invalid, setInvalid] = useState(false)
  return (
    <textarea
      value={text}
      rows={Math.min(8, Math.max(2, text.split('\n').length))}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        try {
          onCommit(parseYaml(text))
          setInvalid(false)
        } catch {
          setInvalid(true)
        }
      }}
      className={`w-full resize-y rounded border bg-surface px-2 py-1 font-mono text-xs leading-relaxed text-ink outline-none ${
        invalid ? 'border-red-700' : 'border-line focus:border-indigo-500'
      }`}
    />
  )
}

export default function ChapterDetails({
  data,
  lockedKeys = [],
  onChange
}: {
  data: Record<string, unknown>
  lockedKeys?: string[]
  onChange: (data: Record<string, unknown>) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [newKey, setNewKey] = useState('')
  const keys = Object.keys(data)

  const commit = (key: string, value: unknown): void => onChange({ ...data, [key]: value })
  const remove = (key: string): void => {
    const next = { ...data }
    delete next[key]
    onChange(next)
  }
  const addField = (): void => {
    const key = newKey.trim()
    if (key && !(key in data)) onChange({ ...data, [key]: '' })
    setNewKey('')
  }

  const summary = keys
    .filter((k) => isScalar(data[k]) && scalarToText(data[k]))
    .slice(0, 4)
    .map((k) => `${k}: ${scalarToText(data[k])}`)
    .join('  ·  ')

  return (
    <div className="shrink-0 border-b border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-1.5 text-left"
        title={open ? 'Hide chapter details' : 'Show chapter details'}
      >
        <span className="min-w-0 truncate text-xs text-ink-faint">
          {summary || (keys.length > 0 ? 'Details' : 'No details yet — add fields like POV or location')}
        </span>
        <span className="shrink-0 pl-2 text-xs text-ink-faint">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-4 py-2">
          {keys.map((key) => (
            <div key={key} className="flex items-start gap-2 py-0.5">
              <span
                className="w-28 shrink-0 truncate pt-1.5 text-xs text-ink-faint"
                title={key}
              >
                {key}
              </span>
              <div className="min-w-0 flex-1">
                {isScalar(data[key]) ? (
                  <ScalarField
                    key={`${key}:${scalarToText(data[key])}`}
                    value={data[key]}
                    locked={lockedKeys.includes(key)}
                    onCommit={(v) => commit(key, v)}
                  />
                ) : (
                  <YamlField value={data[key]} onCommit={(v) => commit(key, v)} />
                )}
              </div>
              {!lockedKeys.includes(key) && (
                <button
                  onClick={() => remove(key)}
                  title={`Remove ${key}`}
                  className="shrink-0 rounded px-1.5 py-1 text-xs text-ink-faint hover:bg-raised hover:text-red-300"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2 py-1">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addField()
              }}
              placeholder="Add a field (pov, location, …)"
              className="w-52 rounded border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none focus:border-indigo-500"
            />
            {newKey.trim() && (
              <button
                onClick={addField}
                className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:bg-raised"
              >
                Add
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
