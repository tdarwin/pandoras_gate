import { useState } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import { parseFrontmatter } from '@shared/frontmatter'
import { useProposalsStore, type ActiveSuggestions } from '../stores/proposals'
import WordDiff from './WordDiff'

/**
 * A thin, non-modal strip above the document being reviewed. It says what is
 * waiting and offers the whole-document actions; the suggestions themselves
 * live in the prose, as tracked changes with ✓/✕ on each.
 *
 * Deliberately not a banner that takes over the column — the author is meant
 * to keep writing while they decide.
 */
export default function SuggestionStrip({
  active,
  chunkCount,
  currentRaw,
  onShow
}: {
  active: ActiveSuggestions
  /** Undecided changes the editor is showing — what the reader actually counts. */
  chunkCount: number
  /** The document as the buffer holds it, for the frontmatter comparison. */
  currentRaw: string
  /** Puts the overlay on the editor (deferred while the author is typing). */
  onShow: () => void
}): React.JSX.Element {
  const setFmChoice = useProposalsStore((s) => s.setFmChoice)
  const showOnly = useProposalsStore((s) => s.showOnly)
  const resolveDoc = useProposalsStore((s) => s.resolveDoc)
  const [openRationale, setOpenRationale] = useState(false)
  const [busy, setBusy] = useState(false)

  // Before the overlay is on, the only number available is how many proposals
  // are waiting; once it is on, count what the author can actually click.
  const count = active.shown && chunkCount > 0 ? chunkCount : active.chain.length
  const sources = [...new Set(active.chain.map((l) => l.sourceTitle))].join(', ')
  const isNew = active.current === ''

  const proposed = parseFrontmatter(active.chain[active.chain.length - 1]?.content ?? '')
  const current = parseFrontmatter(currentRaw)
  const fmDiffers =
    !isNew && JSON.stringify(current.data) !== JSON.stringify(proposed.data)
  const fmText = (data: Record<string, unknown>): string =>
    Object.keys(data).length > 0 ? stringifyYaml(data).trimEnd() : '(none)'

  const act = async (resolution: 'accept' | 'reject'): Promise<void> => {
    setBusy(true)
    await resolveDoc(active.path, resolution)
    setBusy(false)
  }

  return (
    <div className="shrink-0 border-b border-line bg-panel/40">
      <div className="flex items-center justify-between gap-3 px-4 py-1.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium text-amber-300">
            {isNew
              ? 'New document'
              : `${count} suggestion${count === 1 ? '' : 's'}`}
          </span>
          {sources && (
            <span className="min-w-0 truncate text-xs text-ink-faint">from {sources}</span>
          )}
          <button
            onClick={() => setOpenRationale((v) => !v)}
            className="shrink-0 text-xs text-ink-faint hover:text-ink-muted"
          >
            why {openRationale ? '▾' : '▸'}
          </button>
          {active.blocked.length > 0 && (
            <button
              onClick={() => void showOnly(active.blocked[0]!.proposalId)}
              title={active.blocked[0]!.reason}
              className="shrink-0 rounded px-1.5 text-xs text-amber-300 hover:bg-raised"
            >
              {active.blocked.length} can&rsquo;t be combined · next ›
            </button>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {!active.shown && (
            <button
              onClick={onShow}
              className="rounded border border-amber-800 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-900/50"
            >
              Show
            </button>
          )}
          <button
            onClick={() => void act('reject')}
            disabled={busy}
            className="rounded px-2 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted disabled:opacity-60"
          >
            {isNew ? 'Reject' : 'Reject all'}
          </button>
          <button
            onClick={() => void act('accept')}
            disabled={busy}
            className="rounded bg-emerald-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
          >
            {isNew ? 'Accept — creates the file' : 'Accept all'}
          </button>
        </span>
      </div>
      {openRationale && (
        <ul className="border-t border-line/60 px-4 py-1.5 text-xs text-ink-muted">
          {active.chain.map((link) => (
            <li key={link.proposalId} className="py-0.5">
              <span className="text-ink-faint">{link.sourceTitle}</span> — {link.rationale}
            </li>
          ))}
          {active.blocked.map((b) => (
            <li key={b.proposalId} className="py-0.5 text-amber-300">
              <span className="text-ink-faint">{b.sourceTitle}</span> — {b.rationale} (needs a
              look: {b.reason})
            </li>
          ))}
        </ul>
      )}
      {fmDiffers && (
        <div className="border-t border-line/60 px-4 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-ink-muted">Details also change</span>
            <span className="flex shrink-0 gap-3 text-xs text-ink-muted">
              <label className="flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  checked={active.fmChoice === 'proposed'}
                  onChange={() => setFmChoice('proposed')}
                />
                Use proposed
              </label>
              <label className="flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  checked={active.fmChoice === 'current'}
                  onChange={() => setFmChoice('current')}
                />
                Keep current
              </label>
            </span>
          </div>
          <WordDiff oldText={fmText(current.data)} newText={fmText(proposed.data)} />
        </div>
      )}
    </div>
  )
}
