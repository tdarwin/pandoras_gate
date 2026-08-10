import { useCallback, useEffect, useState } from 'react'
import type { IpcEventPayload } from '@shared/ipc'
import { useChatStore } from '../stores/chat'

interface CatalogEntry {
  id: string
  name: string
  description: string
  sizeBytes: number
  minMemoryGB: number
  recommendedMemoryGB: number
  contextLength: number
  license: string
  tier: 'light' | 'mid' | 'large'
  tags: string[]
  fit: 'recommended' | 'slow' | 'too-large'
  installedPath: string | null
  downloading: boolean
  downloadedBytes: number
}

interface Hardware {
  totalMemoryGB: number
  platform: string
  arch: string
  appleSilicon: boolean
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

const FIT_LABEL = {
  recommended: { text: 'Recommended for your machine', cls: 'text-emerald-400' },
  slow: { text: 'Will run, but slowly', cls: 'text-amber-400' },
  'too-large': { text: 'Too large for this machine', cls: 'text-red-400' }
} as const

const FIT_SHORT = {
  recommended: { text: 'fits well', cls: 'text-emerald-400' },
  slow: { text: 'slow', cls: 'text-amber-400' },
  'too-large': { text: 'too large', cls: 'text-red-400' }
} as const

interface HfRepo {
  id: string
  downloads: number
  likes: number
  gated: boolean
}

interface HfFile {
  filename: string
  sizeBytes: number
  quant: string
  parts: number
  fit: 'recommended' | 'slow' | 'too-large'
}

function HuggingFaceBrowser({
  downloading,
  onDownload
}: {
  /** Progress keyed by download key (`hf:<repo>/<file>`). */
  downloading: Record<string, { downloadedBytes: number; totalBytes: number }>
  onDownload: (repoId: string, file: HfFile) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [repos, setRepos] = useState<HfRepo[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, HfFile[] | 'loading' | 'gated'>>({})
  const [error, setError] = useState<string | null>(null)

  const search = async (): Promise<void> => {
    if (!query.trim() || searching) return
    setSearching(true)
    setError(null)
    setExpanded(null)
    const result = await window.pandora.invoke('models:searchHf', { query: query.trim() })
    setSearching(false)
    if (result.ok) setRepos(result.data.repos)
    else setError(result.error.message)
  }

  const toggleRepo = async (repoId: string): Promise<void> => {
    if (expanded === repoId) {
      setExpanded(null)
      return
    }
    setExpanded(repoId)
    if (files[repoId]) return
    setFiles((f) => ({ ...f, [repoId]: 'loading' }))
    const result = await window.pandora.invoke('models:listHfFiles', { repoId })
    if (result.ok) {
      setFiles((f) => ({
        ...f,
        [repoId]: result.data.gated ? 'gated' : result.data.files
      }))
    } else {
      setError(result.error.message)
      setFiles((f) => {
        const next = { ...f }
        delete next[repoId]
        return next
      })
    }
  }

  return (
    <div className="mt-6 border-t border-zinc-800 pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Browse Hugging Face
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
        Search the Hub for any GGUF model — community fine-tunes, new releases, anything. Pick a
        quantization sized for your machine.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
          placeholder="e.g. Qwen3 14B, Mistral Small, dark fantasy writer…"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        <button
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {repos && repos.length === 0 && (
        <p className="mt-3 text-xs text-zinc-600">No GGUF models found for that search.</p>
      )}

      {repos && repos.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {repos.map((r) => {
            const repoFiles = files[r.id]
            return (
              <li key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60">
                <button
                  onClick={() => void toggleRepo(r.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                >
                  <span className="min-w-0 truncate font-mono text-xs text-zinc-300">{r.id}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[10px] text-zinc-600">
                    {r.gated && <span className="text-amber-500">gated</span>}
                    <span>↓ {count(r.downloads)}</span>
                    <span>♥ {count(r.likes)}</span>
                    <span className="text-zinc-500">{expanded === r.id ? '▾' : '▸'}</span>
                  </span>
                </button>

                {expanded === r.id && (
                  <div className="border-t border-zinc-800 px-3 py-2">
                    {repoFiles === 'loading' && (
                      <p className="py-1 text-xs text-zinc-600">Loading files…</p>
                    )}
                    {repoFiles === 'gated' && (
                      <p className="py-1 text-xs leading-relaxed text-amber-400/80">
                        This model is gated — it requires accepting a license on huggingface.co
                        while signed in. Download it there, then use “import a .gguf file” below.
                      </p>
                    )}
                    {Array.isArray(repoFiles) && repoFiles.length === 0 && (
                      <p className="py-1 text-xs text-zinc-600">No GGUF files in this repo.</p>
                    )}
                    {Array.isArray(repoFiles) && repoFiles.length > 0 && (
                      <ul className="flex flex-col">
                        {repoFiles.map((f) => {
                          const key = `hf:${r.id}/${f.filename}`
                          const progress = downloading[key]
                          const fit = FIT_SHORT[f.fit]
                          const pct = progress
                            ? Math.min(
                                100,
                                Math.round(
                                  (progress.downloadedBytes / (progress.totalBytes || f.sizeBytes)) *
                                    100
                                )
                              )
                            : 0
                          return (
                            <li
                              key={f.filename}
                              className="flex items-center justify-between gap-3 py-1"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="font-mono text-xs text-zinc-300">{f.quant}</span>
                                <span className="ml-2 text-[10px] text-zinc-600">
                                  {gb(f.sizeBytes)}
                                  {f.parts > 1 ? ` · ${f.parts} parts` : ''} ·{' '}
                                  <span className={fit.cls}>{fit.text}</span>
                                </span>
                              </span>
                              {progress ? (
                                <span className="flex shrink-0 items-center gap-2">
                                  <span className="h-1 w-20 overflow-hidden rounded-full bg-zinc-800">
                                    <span
                                      className="block h-full rounded-full bg-indigo-500 transition-all"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </span>
                                  <span className="text-[10px] text-zinc-500">{pct}%</span>
                                </span>
                              ) : (
                                <button
                                  onClick={() => onDownload(r.id, f)}
                                  disabled={f.fit === 'too-large'}
                                  className="shrink-0 rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Download
                                </button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function ModelsManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hfProgress, setHfProgress] = useState<
    Record<string, { downloadedBytes: number; totalBytes: number }>
  >({})
  const loadModels = useChatStore((s) => s.loadModels)
  const importLocalModel = useChatStore((s) => s.importLocalModel)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.pandora.invoke('models:catalog', undefined)
    if (result.ok) {
      setEntries(result.data.entries)
      setHardware(result.data.hardware)
    } else {
      setError(result.error.message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.pandora.on('model:downloadProgress', (raw) => {
      const p = raw as IpcEventPayload<'model:downloadProgress'>
      if (p.error && p.error !== 'cancelled') setError(p.error)

      if (p.modelId.startsWith('hf:')) {
        if (p.done || p.error) {
          setHfProgress((prev) => {
            const next = { ...prev }
            delete next[p.modelId]
            return next
          })
          if (p.done) void loadModels()
        } else {
          setHfProgress((prev) => ({
            ...prev,
            [p.modelId]: { downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes }
          }))
        }
        return
      }

      if (p.done) {
        void refresh()
        void loadModels()
      } else {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === p.modelId
              ? { ...e, downloading: !p.error, downloadedBytes: p.downloadedBytes }
              : e
          )
        )
      }
    })
    return unsubscribe
  }, [refresh, loadModels])

  const downloadHf = async (repoId: string, file: HfFile): Promise<void> => {
    setError(null)
    const key = `hf:${repoId}/${file.filename}`
    setHfProgress((prev) => ({
      ...prev,
      [key]: { downloadedBytes: 0, totalBytes: file.sizeBytes }
    }))
    const result = await window.pandora.invoke('models:downloadHf', {
      repoId,
      filename: file.filename,
      sizeBytes: file.sizeBytes
    })
    if (!result.ok) {
      setError(result.error.message)
      setHfProgress((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const download = async (id: string): Promise<void> => {
    setError(null)
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, downloading: true } : e)))
    await window.pandora.invoke('models:download', { modelId: id })
  }

  const cancel = async (id: string): Promise<void> => {
    await window.pandora.invoke('models:cancelDownload', { modelId: id })
    void refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await window.pandora.invoke('models:delete', { modelId: id })
    await refresh()
    await loadModels()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">Local models</h2>
            {hardware && (
              <p className="text-xs text-zinc-500">
                {hardware.appleSilicon ? 'Apple Silicon' : hardware.arch} ·{' '}
                {hardware.totalMemoryGB} GB memory
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <ul className="flex flex-col gap-3">
            {entries.map((e) => {
              const fit = FIT_LABEL[e.fit]
              const pct =
                e.downloading && e.sizeBytes > 0
                  ? Math.min(100, Math.round((e.downloadedBytes / e.sizeBytes) * 100))
                  : 0
              return (
                <li key={e.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-zinc-200">{e.name}</h3>
                        {e.tags.includes('recommended') && (
                          <span className="rounded-full bg-indigo-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-300">
                            Popular
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-zinc-500">{e.description}</p>
                      <p className="mt-1.5 text-[11px] text-zinc-600">
                        {gb(e.sizeBytes)} · {Math.round(e.contextLength / 1024)}k context ·{' '}
                        {e.license} · <span className={fit.cls}>{fit.text}</span>
                      </p>
                    </div>
                    <div className="shrink-0">
                      {e.installedPath ? (
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-xs text-emerald-400">Installed</span>
                          <button
                            onClick={() => void remove(e.id)}
                            className="text-[11px] text-zinc-500 hover:text-red-400"
                          >
                            Remove
                          </button>
                        </div>
                      ) : e.downloading ? (
                        <button
                          onClick={() => void cancel(e.id)}
                          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          onClick={() => void download(e.id)}
                          disabled={e.fit === 'too-large'}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Download
                        </button>
                      )}
                    </div>
                  </div>
                  {e.downloading && (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-indigo-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        {gb(e.downloadedBytes)} of {gb(e.sizeBytes)} ({pct}%)
                      </p>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <HuggingFaceBrowser downloading={hfProgress} onDownload={(r, f) => void downloadHf(r, f)} />
        </div>

        <div className="border-t border-zinc-800 px-5 py-3">
          <button
            onClick={() => void importLocalModel().then(onClose)}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Or import a .gguf file you already have…
          </button>
        </div>
      </div>
    </div>
  )
}
