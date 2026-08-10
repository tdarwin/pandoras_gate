import { useCallback, useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'

interface Commit {
  oid: string
  message: string
  timestamp: number
}

interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface DiffState {
  oid: string
  hunks: Hunk[]
  additions: number
  deletions: number
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

export default function HistoryPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const openChapter = useProjectStore((s) => s.openChapter)
  const setError = useProjectStore((s) => s.setError)

  const [commits, setCommits] = useState<Commit[]>([])
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeFile) return
    setLoading(true)
    const result = await window.pandora.invoke('history:list', {
      novelDir: novel.dir,
      file: activeFile
    })
    setLoading(false)
    if (result.ok) setCommits(result.data.commits)
    else setError(result.error.message)
  }, [novel.dir, activeFile, setError])

  useEffect(() => {
    setDiff(null)
    void refresh()
  }, [refresh])

  const showDiff = async (oid: string): Promise<void> => {
    if (!activeFile) return
    const result = await window.pandora.invoke('history:diff', {
      novelDir: novel.dir,
      oid,
      file: activeFile
    })
    if (result.ok) setDiff({ oid, ...result.data })
    else setError(result.error.message)
  }

  const restore = async (oid: string): Promise<void> => {
    if (!activeFile) return
    const result = await window.pandora.invoke('history:restore', {
      novelDir: novel.dir,
      oid,
      file: activeFile
    })
    if (result.ok) {
      await openChapter(activeFile)
      setDiff(null)
      await refresh()
    } else {
      setError(result.error.message)
    }
  }

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/60">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">History</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-sm text-zinc-500">Loading…</p>
        ) : commits.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">
            No snapshots yet. Snapshots are taken automatically a moment after you stop typing.
          </p>
        ) : (
          <ul className="p-2">
            {commits.map((c) => (
              <li key={c.oid} className="mb-1">
                <div
                  className={`rounded-lg border px-3 py-2 ${
                    diff?.oid === c.oid
                      ? 'border-indigo-700 bg-indigo-950/40'
                      : 'border-transparent hover:bg-zinc-800/60'
                  }`}
                >
                  <button onClick={() => void showDiff(c.oid)} className="w-full text-left">
                    <div className="truncate text-sm text-zinc-200">{c.message}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{timeAgo(c.timestamp)}</div>
                  </button>
                  {diff?.oid === c.oid && (
                    <div className="mt-2 border-t border-zinc-800 pt-2">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          <span className="text-emerald-400">+{diff.additions}</span>{' '}
                          <span className="text-red-400">−{diff.deletions}</span>
                          <span className="ml-1 text-zinc-500">vs. current</span>
                        </span>
                        <button
                          onClick={() => void restore(c.oid)}
                          className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
                        >
                          Restore this version
                        </button>
                      </div>
                      {diff.hunks.length === 0 ? (
                        <p className="mt-2 text-xs text-zinc-500">Identical to current version.</p>
                      ) : (
                        <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed">
                          {diff.hunks.map((h, i) => (
                            <div key={i}>
                              {h.lines.map((line, j) => (
                                <div
                                  key={j}
                                  className={
                                    line.startsWith('+')
                                      ? 'text-emerald-400'
                                      : line.startsWith('-')
                                        ? 'text-red-400'
                                        : 'text-zinc-500'
                                  }
                                >
                                  {line || ' '}
                                </div>
                              ))}
                            </div>
                          ))}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
