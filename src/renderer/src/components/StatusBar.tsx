import { useDownloadsStore, formatSpeed, formatEta } from '../stores/downloads'

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Bottom status bar: visible while model downloads are active. */
export default function StatusBar(): React.JSX.Element | null {
  const downloads = useDownloadsStore((s) => s.downloads)
  const dismiss = useDownloadsStore((s) => s.dismiss)
  const entries = Object.values(downloads)
  if (entries.length === 0) return null

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-zinc-800 bg-zinc-900/80 px-3">
      {entries.map((d) => {
        const pct =
          d.totalBytes > 0 ? Math.min(100, Math.round((d.downloadedBytes / d.totalBytes) * 100)) : 0
        return (
          <div key={d.key} className="flex min-w-0 items-center gap-2 text-[11px]">
            {d.error ? (
              <>
                <span className="truncate text-red-400" title={d.error}>
                  {d.label}: download failed
                </span>
                <button onClick={() => dismiss(d.key)} className="text-zinc-500 hover:text-zinc-300">
                  ✕
                </button>
              </>
            ) : (
              <>
                <span className="max-w-48 truncate text-zinc-400" title={d.label}>
                  ⇣ {d.label}
                </span>
                <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-zinc-800">
                  <span
                    className="block h-full rounded-full bg-indigo-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">
                  {pct}% · {gb(d.downloadedBytes)}/{gb(d.totalBytes)}
                  {d.speedBps > 0 && <> · {formatSpeed(d.speedBps)}</>}
                  {d.etaSeconds !== null && <> · {formatEta(d.etaSeconds)} left</>}
                </span>
              </>
            )}
          </div>
        )
      })}
    </footer>
  )
}
