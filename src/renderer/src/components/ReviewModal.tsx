import { useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useProposalsStore } from '../stores/proposals'

export type ReviewType = 'proofread' | 'copy-edit' | 'developmental' | 'fact-check'

const REVIEW_TYPES: {
  key: ReviewType
  label: string
  description: string
}[] = [
  {
    key: 'proofread',
    label: 'Proofread',
    description: 'Mechanical fixes only — spelling, punctuation, grammar. Your phrasing stays.'
  },
  {
    key: 'copy-edit',
    label: 'Copy edit',
    description: 'Line-level edits for clarity and consistency, preserving your voice.'
  },
  {
    key: 'developmental',
    label: 'Developmental edit',
    description: 'A craft report on structure, pacing, characters, and stakes — no rewrites.'
  },
  {
    key: 'fact-check',
    label: 'Fact check',
    description: 'Continuity report against the Codex: contradictions in canon, timeline, rules.'
  }
]

/**
 * Ask for an editing pass. Edits land in the suggestions queue for
 * tracked-changes review; reports land there too and join the Codex once
 * accepted.
 */
export default function ReviewModal({
  chapterTitle,
  onClose
}: {
  /** Title of the active chapter; null when it isn't a chapter file. */
  chapterTitle: string | null
  onClose: () => void
}): React.JSX.Element {
  const [type, setType] = useState<ReviewType>('copy-edit')
  const [scope, setScope] = useState<'chapter' | 'novel'>(chapterTitle ? 'chapter' : 'novel')
  const [guidance, setGuidance] = useState('')
  const runReview = useProposalsStore((s) => s.runReview)
  const modelForRole = useChatStore((s) => s.modelForRole)

  const isLineEdit = type === 'proofread' || type === 'copy-edit'
  const model = modelForRole(isLineEdit ? 'copyEdit' : 'developmental')

  const start = (): void => {
    void runReview(type, scope, guidance)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-ink">Request an editing review</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          Edits arrive as tracked-change suggestions; reports arrive as documents. Nothing touches
          your files until you accept it.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {REVIEW_TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={`rounded-lg border px-3 py-2 text-left ${
                type === t.key
                  ? 'border-indigo-500 bg-indigo-500/10'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <span className="block text-xs font-medium text-ink">{t.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                {t.description}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3 text-xs text-ink-muted">
          <span className="text-ink-faint">Scope:</span>
          <label className={`flex items-center gap-1 ${chapterTitle ? 'cursor-pointer' : 'opacity-50'}`}>
            <input
              type="radio"
              checked={scope === 'chapter'}
              disabled={!chapterTitle}
              onChange={() => setScope('chapter')}
            />
            {chapterTitle ? `“${chapterTitle}”` : 'This chapter'}
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input type="radio" checked={scope === 'novel'} onChange={() => setScope('novel')} />
            Whole novel
          </label>
        </div>
        {scope === 'novel' && isLineEdit && (
          <p className="mt-1.5 text-[11px] leading-snug text-amber-300/80">
            Goes chapter by chapter — with many chapters this can take a while and, on hosted
            models, cost accordingly.
          </p>
        )}

        <textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
            if (e.key === 'Escape') onClose()
          }}
          rows={2}
          placeholder="Optional focus — “watch for tense slips”, “is the midpoint earned?”… (⌘↵ to start)"
          className="mt-3 w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
        />

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-ink-faint">
            {model
              ? `Runs with ${model.name} — change under Preferences → AI models by task`
              : 'No model available — pick one in the chat panel'}
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:bg-raised"
            >
              Cancel
            </button>
            <button
              onClick={start}
              disabled={!model}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Start review
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
