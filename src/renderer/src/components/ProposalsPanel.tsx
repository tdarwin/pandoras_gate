import { useEffect, useState } from 'react'
import { diffWords } from 'diff'
import { useProposalsStore, type ReviewItem } from '../stores/proposals'

function WordDiff({ oldText, newText }: { oldText: string; newText: string }): React.JSX.Element {
  const parts = diffWords(oldText, newText)
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-[11.5px] leading-relaxed">
      {parts.map((p, i) =>
        p.added ? (
          <span key={i} className="rounded bg-emerald-950 text-emerald-300">
            {p.value}
          </span>
        ) : p.removed ? (
          <span key={i} className="rounded bg-red-950 text-red-400 line-through decoration-red-700">
            {p.value}
          </span>
        ) : (
          <span key={i} className="text-zinc-500">
            {p.value}
          </span>
        )
      )}
    </pre>
  )
}

function ItemCard({
  proposalId,
  item
}: {
  proposalId: string
  item: ReviewItem
}): React.JSX.Element {
  const resolve = useProposalsStore((s) => s.resolve)
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState(item.newContent)
  const [busy, setBusy] = useState(false)

  const act = async (resolution: 'accept' | 'reject', content?: string): Promise<void> => {
    setBusy(true)
    await resolve(proposalId, item.path, resolution, content)
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-xs text-zinc-300">{item.path}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                item.action === 'create'
                  ? 'bg-emerald-950 text-emerald-300'
                  : 'bg-indigo-950 text-indigo-300'
              }`}
            >
              {item.action === 'create' ? 'New' : 'Update'}
            </span>
            {item.conflict && (
              <span
                className="rounded-full bg-amber-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
                title="You edited this file after the suggestion was generated — the comparison below is against your latest version."
              >
                File changed
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">{item.rationale}</p>
        </div>
      </div>

      <div className="mt-3">
        {editing ? (
          <textarea
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={12}
            className="w-full resize-y rounded border border-indigo-700 bg-zinc-950 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-200 outline-none"
          />
        ) : item.action === 'create' ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-[11.5px] leading-relaxed text-emerald-300/90">
            {item.newContent}
          </pre>
        ) : (
          <WordDiff oldText={item.currentContent} newText={item.newContent} />
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Cancel edit
            </button>
            <button
              disabled={busy}
              onClick={() => void act('accept', edited)}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Save & accept
            </button>
          </>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={() => void act('reject')}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
            >
              Reject
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setEdited(item.newContent)
                setEditing(true)
              }}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Edit
            </button>
            <button
              disabled={busy}
              onClick={() => void act('accept')}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Accept
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function ProposalsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const proposals = useProposalsStore((s) => s.proposals)
  const refresh = useProposalsStore((s) => s.refresh)
  const resolve = useProposalsStore((s) => s.resolve)
  const error = useProposalsStore((s) => s.error)
  const [busyAll, setBusyAll] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const total = proposals.reduce((n, p) => n + p.items.length, 0)

  const acceptAll = async (): Promise<void> => {
    setBusyAll(true)
    for (const p of proposals) {
      for (const item of p.items) {
        await resolve(p.id, item.path, 'accept')
      }
    }
    setBusyAll(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">Codex suggestions</h2>
            <p className="text-xs text-zinc-500">
              Review what the AI learned from your latest writing. Nothing changes until you accept
              it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {total > 1 && (
              <button
                disabled={busyAll}
                onClick={() => void acceptAll()}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {busyAll ? 'Applying…' : `Accept all (${total})`}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          {total === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-600">
              No pending suggestions. Save a chapter and press “Update Codex”, or ask the chat
              agent to do it.
            </p>
          ) : (
            proposals.map((p) => (
              <div key={p.id} className="mb-5">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  From “{p.chapterTitle}”
                </h3>
                <div className="flex flex-col gap-3">
                  {p.items.map((item) => (
                    <ItemCard key={item.path} proposalId={p.id} item={item} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
