import { useEffect, useMemo, useState } from 'react'
import { diffWords } from 'diff'
import { useProposalsStore, type PendingDoc } from '../stores/proposals'
import { useProjectStore } from '../stores/project'

/** Word-level diff of two documents. */
export function WordDiff({
  oldText,
  newText
}: {
  oldText: string
  newText: string
}): React.JSX.Element {
  // Whole-document diffs run into hundreds of milliseconds on a long chapter;
  // recomputing one per render (and once per remaining card after every
  // accept) is what made this panel stall.
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

/**
 * One card per document with suggestions waiting. The diff is fetched only
 * when the card is expanded: the fold needs whole document bodies, and a
 * whole-novel copy edit queues one per chapter.
 */
function DocCard({ doc, onClose }: { doc: PendingDoc; onClose: () => void }): React.JSX.Element {
  const novelDir = useProjectStore((s) => s.novel?.dir)
  const resolveDoc = useProposalsStore((s) => s.resolveDoc)
  const enterReview = useProposalsStore((s) => s.enterReview)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ current: string; proposed: string } | null>(null)

  useEffect(() => {
    if (!open || preview || !novelDir) return
    let live = true
    void window.pandora
      .invoke('proposals:forPath', { novelDir, path: doc.path })
      .then((r) => {
        if (!live || !r.ok) return
        const last = r.data.chain[r.data.chain.length - 1]
        setPreview({ current: r.data.current, proposed: last?.content ?? r.data.current })
      })
    return () => {
      live = false
    }
  }, [open, preview, novelDir, doc.path])

  const act = async (resolution: 'accept' | 'reject'): Promise<void> => {
    setBusy(true)
    await resolveDoc(doc.path, resolution)
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-line bg-panel/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 text-left">
          <span className="block truncate font-mono text-xs text-ink">{doc.path}</span>
          <span className="block truncate text-xs text-ink-faint">
            {doc.count} suggestion{doc.count === 1 ? '' : 's'} · {doc.sources.join(', ')}
            {doc.blocked > 0 ? ` · ${doc.blocked} needs review` : ''}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-2">
          {doc.action === 'create' && (
            <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs text-emerald-300">
              New
            </span>
          )}
          <button
            onClick={() => void act('reject')}
            disabled={busy}
            className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:bg-raised disabled:opacity-60"
          >
            Reject
          </button>
          {doc.path.endsWith('.md') && (
            <button
              onClick={() => {
                void enterReview(doc.path)
                // Review takes over the editor column; leaving the queue on
                // top of it just hides what the author came to look at.
                onClose()
              }}
              disabled={busy}
              className="rounded border border-line-strong px-2 py-1 text-xs text-ink-muted hover:bg-raised disabled:opacity-60"
            >
              Review in editor
            </button>
          )}
          <button
            onClick={() => void act('accept')}
            disabled={busy}
            className="rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
          >
            Accept
          </button>
        </span>
      </div>
      {open && (
        <div className="mt-2">
          {preview ? (
            <WordDiff oldText={preview.current} newText={preview.proposed} />
          ) : (
            <p className="text-xs text-ink-faint">Loading…</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function ProposalsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const docs = useProposalsStore((s) => s.pendingDocs)
  const total = useProposalsStore((s) => s.pendingTotal)
  const refresh = useProposalsStore((s) => s.refresh)
  const error = useProposalsStore((s) => s.error)
  const resolveNovel = useProposalsStore((s) => s.resolveNovel)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const acceptAll = async (): Promise<void> => {
    setBusy(true)
    // Through the store, not a bare invoke: it saves the open chapter first and
    // re-reads it after, without which an autosave overwrites what was applied.
    const { applied, skipped } = await resolveNovel('accept')
    setBusy(false)
    setReport(
      skipped > 0 ? `Applied ${applied}; skipped ${skipped} that need review.` : `Applied ${applied}.`
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-ink">Codex suggestions</h2>
          <span className="flex items-center gap-2">
            {total > 1 && (
              <button
                onClick={() => void acceptAll()}
                disabled={busy}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
              >
                Accept all ({total})
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-sm text-ink-faint hover:bg-raised hover:text-ink"
            >
              ✕
            </button>
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {report && <p className="text-xs text-ink-muted">{report}</p>}
          {error && (
            <p className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
              {error}
            </p>
          )}
          {docs.length === 0 && <p className="text-sm text-ink-faint">Nothing waiting.</p>}
          {docs.map((doc) => (
            <DocCard key={doc.path} doc={doc} onClose={onClose} />
          ))}
        </div>
      </div>
    </div>
  )
}
