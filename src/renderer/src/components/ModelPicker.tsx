import { useMemo, useState } from 'react'
import {
  recommend,
  recommendationReason,
  STYLES,
  STYLE_LABELS,
  USE_CASES,
  USE_CASE_LABELS,
  type CatalogEntryStatus,
  type HostedPick,
  type Style,
  type UseCase
} from '@shared/llm/catalog'
import { formatContext } from '@shared/llm/memory'
import { usePrefsStore } from '../stores/prefs'
import { formatSpeed, formatEta, type DownloadEntry } from '../stores/downloads'

/**
 * The guided part of the Models manager.
 *
 * Novelists don't shop for parameter counts, they shop for outcomes — so the
 * question asked here is "what do you want help with", not "how much memory do
 * you have". Machine fit is still enforced underneath, it just isn't the
 * organizing idea.
 */

const TOP_N = 3

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1024)}k`
}

const FIT_LABEL = {
  recommended: { text: 'Fits comfortably', cls: 'text-emerald-400' },
  slow: { text: 'Tight fit', cls: 'text-amber-400' },
  'too-large': { text: 'Not enough memory', cls: 'text-red-400' }
} as const

function Chip({
  label,
  selected,
  onClick
}: {
  label: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={
        selected
          ? 'rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white'
          : 'rounded-full border border-line-strong px-3 py-1 text-xs text-ink-muted hover:bg-raised'
      }
    >
      {label}
    </button>
  )
}

function Pill({ text, tone }: { text: string; tone: 'popular' | 'unfiltered' }): React.JSX.Element {
  const cls =
    tone === 'popular'
      ? 'bg-indigo-950 text-indigo-300'
      : 'bg-rose-950 text-rose-300'
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {text}
    </span>
  )
}

function UseCaseBadges({ useCases }: { useCases: readonly UseCase[] }): React.JSX.Element {
  return (
    <span className="mt-2 flex flex-wrap gap-1">
      {useCases.map((u) => (
        <span
          key={u}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint"
        >
          {USE_CASE_LABELS[u]}
        </span>
      ))}
    </span>
  )
}

function LocalCard({
  entry,
  reason,
  progress,
  suppressCrampedNote,
  onDownload,
  onCancel
}: {
  entry: CatalogEntryStatus
  reason: string
  progress: DownloadEntry | undefined
  /** True when a banner above already says every option here is cramped. */
  suppressCrampedNote: boolean
  onDownload: () => void
  onCancel: () => void
}): React.JSX.Element {
  const fit = FIT_LABEL[entry.fit]
  const pct =
    progress && entry.sizeBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / entry.sizeBytes) * 100))
      : 0
  return (
    <li className="rounded-lg border border-line bg-surface/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-ink">{entry.name}</h4>
            <span className="text-[11px] text-ink-faint">{entry.params}</span>
            {entry.popular && <Pill text="Popular" tone="popular" />}
            {entry.unfiltered && <Pill text="Unfiltered" tone="unfiltered" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{entry.bestFor}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            <span className="text-ink-faint/70">Trade-off: </span>
            {entry.tradeoff}
          </p>
          <UseCaseBadges useCases={entry.useCases} />
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {gb(entry.sizeBytes)} · {entry.license} ·{' '}
            <span className={fit.cls}>{fit.text}</span>
          </p>
          {/*
            The number that actually matters, and the one the app got wrong for
            a long time: how much context THIS machine can give THIS model,
            after the weights are loaded. Not the window printed on the box.
          */}
          <p className="mt-0.5 text-[11px] text-ink-muted">
            <span className="font-medium text-ink">
              ~{formatContext(entry.usableContext)} of context
            </span>{' '}
            on your machine
            {entry.memory.trainContextLength > entry.usableContext && (
              <span
                className="text-ink-faint"
                title={`Trained for ${formatContext(entry.memory.trainContextLength)}; your machine has memory for ${formatContext(entry.usableContext)} once the weights are loaded.`}
              >
                {' '}
                (trained for {formatContext(entry.memory.trainContextLength)})
              </span>
            )}
          </p>
          {entry.cramped && !suppressCrampedNote && (
            <p className="mt-1 rounded border border-amber-900/60 bg-amber-950/40 px-2 py-1 text-[11px] leading-relaxed text-amber-300/90">
              That is enough for line edits, but too little to draft against your Codex. A hosted
              model below will do this job far better on this machine.
            </p>
          )}
          {reason && <p className="mt-1 text-[11px] italic text-indigo-300/80">{reason}</p>}
        </div>
        <div className="shrink-0">
          {progress ? (
            <button
              onClick={onCancel}
              className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:bg-raised"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onDownload}
              disabled={entry.fit === 'too-large'}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download
            </button>
          )}
        </div>
      </div>
      {progress && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 tabular-nums text-[11px] text-ink-faint">
            {gb(progress.downloadedBytes)} of {gb(entry.sizeBytes)} ({pct}%)
            {progress.speedBps > 0 && <> · {formatSpeed(progress.speedBps)}</>}
            {progress.etaSeconds !== null && <> · about {formatEta(progress.etaSeconds)} left</>}
          </p>
        </div>
      )}
    </li>
  )
}

function HostedCard({
  pick,
  reason,
  apiKeyConfigured
}: {
  pick: HostedPick
  reason: string
  apiKeyConfigured: boolean
}): React.JSX.Element {
  return (
    <li className="rounded-lg border border-line bg-surface/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium text-ink">{pick.name}</h4>
        {pick.popular && <Pill text="Popular" tone="popular" />}
        {pick.unfiltered && <Pill text="Unfiltered" tone="unfiltered" />}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{pick.bestFor}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-faint">
        <span className="text-ink-faint/70">Trade-off: </span>
        {pick.tradeoff}
      </p>
      <UseCaseBadges useCases={pick.useCases} />
      <p className="mt-1.5 text-[11px] text-ink-faint">
        ${pick.approxCostPerMTok.prompt.toFixed(2)} in / $
        {pick.approxCostPerMTok.completion.toFixed(2)} out per million tokens ·{' '}
        {k(pick.contextLength)} context
      </p>
      {reason && <p className="mt-1 text-[11px] italic text-indigo-300/80">{reason}</p>}
      <p className="mt-1.5 font-mono text-[10px] text-ink-faint">{pick.id}</p>
      {!apiKeyConfigured && (
        <p className="mt-1 text-[11px] text-amber-400/80">
          Add an OpenRouter key below to use this.
        </p>
      )}
    </li>
  )
}

export default function ModelPicker({
  entries,
  hosted,
  downloads,
  apiKeyConfigured,
  onDownload,
  onCancel
}: {
  entries: CatalogEntryStatus[]
  hosted: HostedPick[]
  downloads: Record<string, DownloadEntry>
  apiKeyConfigured: boolean
  onDownload: (id: string) => void
  onCancel: (id: string) => void
}): React.JSX.Element {
  const [useCase, setUseCase] = useState<UseCase | null>(null)
  const [style, setStyle] = useState<Style | null>(null)
  const [showAll, setShowAll] = useState(false)
  const showUnfiltered = usePrefsStore((s) => s.showUnfilteredModels)
  const updatePrefs = usePrefsStore((s) => s.update)

  const filters = useMemo(
    () => ({ useCase, style, showUnfiltered }),
    [useCase, style, showUnfiltered]
  )

  // Only offer models that aren't already installed; "Your models" covers those.
  const available = useMemo(() => entries.filter((e) => !e.installedPath), [entries])
  const rankedLocal = useMemo(() => recommend(available, filters), [available, filters])
  const rankedHosted = useMemo(() => recommend(hosted, filters), [hosted, filters])

  const narrowed = useCase !== null && !showAll
  const shownLocal = narrowed ? rankedLocal.slice(0, TOP_N) : rankedLocal
  const shownHosted = narrowed ? rankedHosted.slice(0, TOP_N) : rankedHosted
  const hiddenCount =
    rankedLocal.length - shownLocal.length + (rankedHosted.length - shownHosted.length)

  const unfilteredAvailable =
    entries.some((e) => e.unfiltered) || hosted.some((h) => h.unfiltered)
  /** Every local option is too cramped to be useful — say it once, not per card. */
  const allCramped = shownLocal.length > 0 && shownLocal.every((e) => e.cramped)

  return (
    <div>
      <div className="rounded-lg border border-line bg-surface/40 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          What do you want help with?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {USE_CASES.map((u) => (
            <Chip
              key={u}
              label={USE_CASE_LABELS[u]}
              selected={useCase === u}
              onClick={() => {
                setUseCase(useCase === u ? null : u)
                setShowAll(false)
              }}
            />
          ))}
        </div>

        <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          What are you writing? <span className="normal-case tracking-normal">(optional)</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <Chip
              key={s}
              label={STYLE_LABELS[s]}
              selected={style === s}
              onClick={() => setStyle(style === s ? null : s)}
            />
          ))}
        </div>

        {unfilteredAvailable && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-line pt-3">
            <input
              type="checkbox"
              checked={showUnfiltered}
              onChange={(e) => void updatePrefs({ showUnfilteredModels: e.target.checked })}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="block text-xs text-ink">Show unfiltered models</span>
              <span className="block text-[11px] leading-relaxed text-ink-faint">
                Models that write explicit sex and violence on request instead of refusing. The
                same property makes them less likely to refuse anything else, so they need a
                clearer brief about what you actually want.
              </span>
            </span>
          </label>
        )}

        {useCase === null && (
          <p className="mt-3 text-[11px] text-ink-faint">
            Pick a task above and this list narrows to the best few for it.
          </p>
        )}
      </div>

      {shownLocal.length === 0 && shownHosted.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-ink-faint">
          Nothing in the catalog matches that on a machine this size.{' '}
          {!showUnfiltered && unfilteredAvailable
            ? 'Turning on unfiltered models may add options, or search Hugging Face below.'
            : 'Try another task, or search Hugging Face below.'}
        </p>
      ) : (
        <>
          {/*
            A machine that can't hold a workable local model isn't out of
            options — it's a machine that should be using hosted ones. Say so
            rather than showing an empty list.
          */}
          {shownLocal.length === 0 && shownHosted.length > 0 && (
            <p className="mt-4 rounded-lg border border-line bg-surface/40 px-3 py-2 text-xs leading-relaxed text-ink-muted">
              No local model fits this machine with enough context to be useful for that. The
              hosted models below have no such limit — they run on someone else&rsquo;s hardware
              and need only an OpenRouter key.
            </p>
          )}
          {allCramped && (
            <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-300/90">
              Every local option here would run with very little context on this machine. They
              will work for short, mechanical passes; for drafting or continuity work, the hosted
              models below are the better answer.
            </p>
          )}
          {shownLocal.length > 0 && (
            <ul className="mt-4 flex flex-col gap-3">
              {shownLocal.map((e) => (
                <LocalCard
                  key={e.id}
                  entry={e}
                  reason={narrowed ? recommendationReason(e, filters) : ''}
                  progress={downloads[e.id]}
                  suppressCrampedNote={allCramped}
                  onDownload={() => onDownload(e.id)}
                  onCancel={() => onCancel(e.id)}
                />
              ))}
            </ul>
          )}

          {shownHosted.length > 0 && (
            <>
              <h4 className="mt-5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Hosted, via OpenRouter
              </h4>
              <ul className="mt-2 flex flex-col gap-3">
                {shownHosted.map((h) => (
                  <HostedCard
                    key={h.id}
                    pick={h}
                    reason={narrowed ? recommendationReason(h, filters) : ''}
                    apiKeyConfigured={apiKeyConfigured}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {narrowed && hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs text-indigo-400 hover:text-indigo-300"
        >
          Show {hiddenCount} more that also match →
        </button>
      )}
      {showAll && useCase !== null && (
        <button
          onClick={() => setShowAll(false)}
          className="mt-3 text-xs text-indigo-400 hover:text-indigo-300"
        >
          ← Show just the top picks
        </button>
      )}
    </div>
  )
}
