import { useState } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import { parseFrontmatter } from '@shared/frontmatter'
import { useProposalsStore, type ActiveSuggestions } from '../stores/proposals'
import WordDiff from './WordDiff'

type Review = NonNullable<ActiveSuggestions['review']>

/**
 * The whole-document decision for a proposal that changes the shape of the
 * document — a wrap, an unwrap, a paragraph added or removed.
 *
 * These are not shown inline: per-chunk ✓/✕ decides a suggestion by splicing
 * the original back over the proposal's range, which is only unambiguous when
 * both documents hold the same blocks (see `editor/blockShape.ts`). So they
 * are decided here instead, whole, against a word diff.
 *
 * A panel in the editor column rather than a modal: the author can leave it by
 * opening another document, and nothing about the rest of the app is blocked
 * while it is open.
 */
export default function StructuralReview({ review }: { review: Review }): React.JSX.Element {
  const close = useProposalsStore((s) => s.closeStructuralReview)
  const decide = useProposalsStore((s) => s.decideStructural)
  const fmChoice = useProposalsStore((s) => s.active?.fmChoice ?? 'current')
  const setFmChoice = useProposalsStore((s) => s.setFmChoice)
  const [busy, setBusy] = useState(false)

  const base = parseFrontmatter(review.base)
  const proposed = parseFrontmatter(review.content)
  // Frontmatter is not in the body diff, and accepting used to write the
  // proposal's file whole — so fields the author never saw were replaced.
  const fmDiffers = JSON.stringify(base.data) !== JSON.stringify(proposed.data)
  const fmText = (data: Record<string, unknown>): string =>
    Object.keys(data).length > 0 ? stringifyYaml(data).trimEnd() : '(none)'

  const act = async (resolution: 'accept' | 'reject'): Promise<void> => {
    setBusy(true)
    await decide(review.proposalId, resolution)
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5">
      <div className="mx-auto w-full max-w-3xl">
        <button onClick={close} className="text-xs text-ink-faint hover:text-ink-muted">
          ‹ back to the document
        </button>
        <h2 className="mt-3 text-sm font-medium text-ink">{review.sourceTitle}</h2>
        <p className="mt-1 text-xs text-ink-muted">{review.rationale}</p>
        <p className="mt-3 text-xs text-amber-300">
          This one has to be decided as a whole rather than change by change — it changes the
          shape of the document, or it changes formatting the tracked-changes view cannot show.
        </p>

        <div className="mt-4">
          <WordDiff oldText={base.body} newText={proposed.body} />
        </div>

        {fmDiffers && (
          <div className="mt-4">
            <p className="mb-1 text-xs text-ink-muted">It also changes the details:</p>
            <WordDiff oldText={fmText(base.data)} newText={fmText(proposed.data)} />
            <div className="mt-2 flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1 text-ink-muted">
                <input
                  type="radio"
                  checked={fmChoice === 'current'}
                  onChange={() => setFmChoice('current')}
                />
                Keep mine
              </label>
              <label className="flex items-center gap-1 text-ink-muted">
                <input
                  type="radio"
                  checked={fmChoice === 'proposed'}
                  onChange={() => setFmChoice('proposed')}
                />
                Use proposed
              </label>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void act('accept')}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
          >
            Accept
          </button>
          <button
            disabled={busy}
            onClick={() => void act('reject')}
            className="rounded border border-line px-3 py-1 text-xs text-ink-muted hover:bg-raised disabled:opacity-50"
          >
            Reject
          </button>
          <span className="text-xs text-ink-faint">
            Accepting replaces the document; anything you have typed is saved first.
          </span>
        </div>
      </div>
    </div>
  )
}
