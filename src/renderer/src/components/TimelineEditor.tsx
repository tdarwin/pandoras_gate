import { useEffect, useMemo } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import PlainEditor from '../editor/PlainEditor'
import {
  useProposalsStore,
  setSuggestionHandle,
  type ActiveSuggestions
} from '../stores/proposals'
import WordDiff from './WordDiff'
import {
  parseEntries,
  serializeEntries,
  diffEntries,
  applyChange,
  entryKey,
  entryLabel,
  type Entry,
  type EntryChange
} from '../lib/timelineEntries'

/**
 * `metadata/timeline.yaml` without the YAML: one card per event, with
 * suggestions decided entry by entry.
 *
 * The tracked-changes overlay needs a ProseMirror document, and the timeline
 * is a list of records — so this answers the same question the prose editor
 * does (`proposedBody`: what does this proposal still propose?) by other
 * means, and the save path does not know the difference.
 *
 * A file that is not a list of records is left to `PlainEditor` with a notice:
 * authors are invited to hand-edit these, and a structured view that refuses
 * to show what is actually there would be worse than the raw text.
 */

export default function TimelineEditor({
  value,
  onChange,
  onSave,
  active
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  /** Pending suggestions for the timeline, or null. */
  active: ActiveSuggestions | null
}): React.JSX.Element {
  const rejectField = useProposalsStore((s) => s.rejectField)
  const entries = useMemo(() => parseEntries(value), [value])

  const proposals = useMemo(() => {
    // Same rule as the prose overlay: nothing is offered until it is shown,
    // because a decision taken before that is not recorded anywhere.
    if (!active?.shown || entries === null) return []
    return active.chain
      .map((link) => ({ link, entries: parseEntries(link.content) }))
      .filter((p): p is { link: (typeof active.chain)[number]; entries: Entry[] } => p.entries !== null)
      .map((p) => ({
        link: p.link,
        changes: diffEntries(entries, p.entries).filter(
          (c) => !active.rejectedFields.includes(c.key)
        )
      }))
  }, [active, entries])

  // The save path asks for the same two documents it asks the prose editor for.
  useEffect(() => {
    if (entries === null) return
    setSuggestionHandle({
      proposedBody: (proposalId) => {
        const p = proposals.find((x) => x.link.proposalId === proposalId)
        // A proposal this view cannot represent (its own YAML is not a list of
        // records) keeps its stored content, so it stays pending instead of
        // reading as "proposes exactly what the file already says".
        if (!p) {
          return active?.chain.find((l) => l.proposalId === proposalId)?.content ?? value
        }
        return serializeEntries(p.changes.reduce(applyChange, entries))
      },
      acceptAllSuggestions: () => {
        let next = entries
        for (const p of proposals) next = p.changes.reduce(applyChange, next)
        onChange(serializeEntries(next))
      },
      rejectAllSuggestions: () => {
        for (const p of proposals) for (const c of p.changes) rejectField(c.key)
      }
    })
    return () => setSuggestionHandle(null)
  }, [entries, proposals, onChange, rejectField, active, value])

  if (entries === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p className="shrink-0 border-b border-line px-4 py-2 text-xs text-amber-300">
          This timeline isn&rsquo;t a list of events, so it can&rsquo;t be shown as cards. Editing
          it here keeps the file exactly as you wrote it.
        </p>
        <div className="min-h-0 flex-1">
          <PlainEditor value={value} onChange={onChange} onSave={onSave} />
        </div>
      </div>
    )
  }

  const changes = proposals.flatMap((p) => p.changes.map((c) => ({ ...c, link: p.link })))

  const accept = (change: EntryChange): void => onChange(serializeEntries(applyChange(entries, change)))

  const fields = (entry: Entry): [string, unknown][] => Object.entries(entry)

  return (
    <div className="h-full min-h-0 space-y-2 overflow-y-auto px-6 py-4">
      {entries.length === 0 && changes.length === 0 && (
        <p className="text-sm text-ink-faint">
          No events yet — the AI adds them here as you save chapters.
        </p>
      )}
      {changes.map((change) => (
        <div
          key={`s:${change.key}`}
          className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3"
        >
          <div className="mb-1.5 flex items-start justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-ink">
              <span className="mr-1.5 rounded bg-emerald-950 px-1 text-[10px] uppercase text-emerald-300">
                {change.kind}
              </span>
              {entryLabel(change.proposed ?? change.current)}
            </span>
            <span className="tc-ctrl shrink-0" title={`${change.link.sourceTitle} — ${change.link.rationale}`}>
              <button type="button" title="Accept this change" onClick={() => accept(change)}>
                ✓
              </button>
              <button type="button" title="Reject this change" onClick={() => rejectField(change.key)}>
                ✕
              </button>
            </span>
          </div>
          {change.kind === 'changed' ? (
            <WordDiff
              oldText={stringifyYaml(change.current).trimEnd()}
              newText={stringifyYaml(change.proposed).trimEnd()}
            />
          ) : (
            <pre
              className={`max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-2 text-xs ${
                change.kind === 'removed' ? 'text-red-400 line-through' : 'text-emerald-300'
              }`}
            >
              {stringifyYaml(change.proposed ?? change.current).trimEnd()}
            </pre>
          )}
        </div>
      ))}
      {entries.map((entry, i) => (
        <div key={entryKey(entry, i)} className="rounded-lg border border-line bg-panel/40 p-3">
          <div className="mb-1 text-sm text-ink">{entryLabel(entry)}</div>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-xs">
            {fields(entry).map(([key, v]) => (
              <div key={key} className="contents">
                <dt className="truncate text-ink-faint">{key}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-ink-muted">
                  {typeof v === 'object' && v !== null
                    ? stringifyYaml(v).trimEnd()
                    : String(v ?? '')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}
