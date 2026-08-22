import { useState } from 'react'
import { parseFrontmatter } from '@shared/frontmatter'
import { useProposalsStore, type BlockedProposal } from '../stores/proposals'
import WordDiff from './WordDiff'

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
export default function StructuralReview({
  item,
  current
}: {
  item: BlockedProposal
  /** The file as main last confirmed it. */
  current: string
}): React.JSX.Element {
  const close = useProposalsStore((s) => s.closeStructuralReview)
  const decide = useProposalsStore((s) => s.decideStructural)
  const [busy, setBusy] = useState(false)

  const act = async (resolution: 'accept' | 'reject'): Promise<void> => {
    setBusy(true)
    await decide(item.proposalId, resolution)
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5">
      <div className="mx-auto w-full max-w-3xl">
        <button onClick={close} className="text-xs text-ink-faint hover:text-ink-muted">
          ‹ back to the document
        </button>
        <h2 className="mt-3 text-sm font-medium text-ink">{item.sourceTitle}</h2>
        <p className="mt-1 text-xs text-ink-muted">{item.rationale}</p>
        <p className="mt-3 text-xs text-amber-300">
          This one {item.reason}, so it is decided as a whole rather than change by change.
        </p>

        <div className="mt-4">
          <WordDiff
            oldText={parseFrontmatter(current).body}
            newText={parseFrontmatter(item.content ?? '').body}
          />
        </div>

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
