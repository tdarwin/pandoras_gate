import { useCallback, useEffect, useState } from 'react'
import type { IpcEventPayload } from '@shared/ipc'
import { useChatStore } from '../stores/chat'
import { useDownloadsStore, formatSpeed, formatEta } from '../stores/downloads'

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
    <div className="mt-6 border-t border-line pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Browse Hugging Face
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
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
          className="flex-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink outline-none focus:border-indigo-500"
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
        <p className="mt-3 text-xs text-ink-faint">No GGUF models found for that search.</p>
      )}

      {repos && repos.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {repos.map((r) => {
            const repoFiles = files[r.id]
            return (
              <li key={r.id} className="rounded-lg border border-line bg-surface/60">
                <button
                  onClick={() => void toggleRepo(r.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                >
                  <span className="min-w-0 truncate font-mono text-xs text-ink-muted">{r.id}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[10px] text-ink-faint">
                    {r.gated && <span className="text-amber-500">gated</span>}
                    <span>↓ {count(r.downloads)}</span>
                    <span>♥ {count(r.likes)}</span>
                    <span className="text-ink-faint">{expanded === r.id ? '▾' : '▸'}</span>
                  </span>
                </button>

                {expanded === r.id && (
                  <div className="border-t border-line px-3 py-2">
                    {repoFiles === 'loading' && (
                      <p className="py-1 text-xs text-ink-faint">Loading files…</p>
                    )}
                    {repoFiles === 'gated' && (
                      <p className="py-1 text-xs leading-relaxed text-amber-400/80">
                        This model is gated — it requires accepting a license on huggingface.co
                        while signed in. Download it there, then use “import a .gguf file” below.
                      </p>
                    )}
                    {Array.isArray(repoFiles) && repoFiles.length === 0 && (
                      <p className="py-1 text-xs text-ink-faint">No GGUF files in this repo.</p>
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
                                <span className="font-mono text-xs text-ink-muted">{f.quant}</span>
                                <span className="ml-2 text-[10px] text-ink-faint">
                                  {gb(f.sizeBytes)}
                                  {f.parts > 1 ? ` · ${f.parts} parts` : ''} ·{' '}
                                  <span className={fit.cls}>{fit.text}</span>
                                </span>
                              </span>
                              {progress ? (
                                <span className="flex shrink-0 items-center gap-2">
                                  <span className="h-1 w-20 overflow-hidden rounded-full bg-raised">
                                    <span
                                      className="block h-full rounded-full bg-indigo-500 transition-all"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </span>
                                  <span className="text-[10px] text-ink-faint">{pct}%</span>
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

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  )
}

export default function ModelsManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [orKey, setOrKey] = useState('')
  const downloads = useDownloadsStore((s) => s.downloads)
  const models = useChatStore((s) => s.models)
  const selectedModelId = useChatStore((s) => s.selectedModelId)
  const selectModel = useChatStore((s) => s.selectModel)
  const apiKeyConfigured = useChatStore((s) => s.apiKeyConfigured)
  const saveApiKey = useChatStore((s) => s.saveApiKey)
  const loadModels = useChatStore((s) => s.loadModels)
  const importLocalModel = useChatStore((s) => s.importLocalModel)

  const localModels = models.filter((m) => m.provider === 'local')

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
    void loadModels()
    // Completion/failure notifications; live progress comes from the
    // downloads store.
    const unsubscribe = window.pandora.on('model:downloadProgress', (raw) => {
      const p = raw as IpcEventPayload<'model:downloadProgress'>
      if (p.error && p.error !== 'cancelled') setError(p.error)
      if (p.done) {
        void refresh()
        void loadModels()
      }
    })
    return unsubscribe
  }, [refresh, loadModels])

  const downloadHf = async (repoId: string, file: HfFile): Promise<void> => {
    setError(null)
    const result = await window.pandora.invoke('models:downloadHf', {
      repoId,
      filename: file.filename,
      sizeBytes: file.sizeBytes
    })
    if (!result.ok) setError(result.error.message)
  }

  const download = async (id: string): Promise<void> => {
    setError(null)
    await window.pandora.invoke('models:download', { modelId: id })
  }

  const cancel = async (id: string): Promise<void> => {
    await window.pandora.invoke('models:cancelDownload', { modelId: id })
    void refresh()
  }

  const removeCatalog = async (id: string): Promise<void> => {
    await window.pandora.invoke('models:delete', { modelId: id })
    await refresh()
    await loadModels()
  }

  const removeLocal = async (path: string): Promise<void> => {
    // Catalog-installed models get their file deleted too; imports are only
    // deregistered (the user's own file stays put).
    const catalogEntry = entries.find((e) => e.installedPath === path)
    if (catalogEntry) {
      await removeCatalog(catalogEntry.id)
    } else {
      await window.pandora.invoke('llm:removeLocalModel', { path })
      await loadModels()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Local models</h2>
            {hardware && (
              <p className="text-xs text-ink-faint">
                {hardware.appleSilicon ? 'Apple Silicon' : hardware.arch} ·{' '}
                {hardware.totalMemoryGB} GB memory
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <Section title="Your models">
            {localModels.length === 0 ? (
              <p className="text-xs text-ink-faint">
                Nothing downloaded yet — grab a recommended model below, or search Hugging Face.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {localModels.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface/60 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{m.name}</span>
                      <span className="text-[10px] text-ink-faint">
                        {Math.round(m.contextLength / 1024)}k context
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {selectedModelId === m.id ? (
                        <span className="text-[11px] text-emerald-400">In use</span>
                      ) : (
                        <button
                          onClick={() => selectModel(m.id)}
                          className="rounded border border-line-strong px-2 py-0.5 text-[11px] text-ink-muted hover:bg-raised"
                        >
                          Use
                        </button>
                      )}
                      <button
                        onClick={() => void removeLocal(m.id)}
                        className="text-[11px] text-ink-faint hover:text-red-400"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Recommended models">
            <ul className="flex flex-col gap-3">
              {entries
                .filter((e) => !e.installedPath)
                .map((e) => {
                  const progress = downloads[e.id]
                  const fit = FIT_LABEL[e.fit]
                  const pct =
                    progress && e.sizeBytes > 0
                      ? Math.min(100, Math.round((progress.downloadedBytes / e.sizeBytes) * 100))
                      : 0
                  return (
                    <li key={e.id} className="rounded-lg border border-line bg-surface/60 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-medium text-ink">{e.name}</h4>
                            {e.tags.includes('recommended') && (
                              <span className="rounded-full bg-indigo-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-300">
                                Popular
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                            {e.description}
                          </p>
                          <p className="mt-1.5 text-[11px] text-ink-faint">
                            {gb(e.sizeBytes)} · {Math.round(e.contextLength / 1024)}k context ·{' '}
                            {e.license} · <span className={fit.cls}>{fit.text}</span>
                          </p>
                        </div>
                        <div className="shrink-0">
                          {progress ? (
                            <button
                              onClick={() => void cancel(e.id)}
                              className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:bg-raised"
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
                      {progress && (
                        <div className="mt-3">
                          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                            <div
                              className="h-full rounded-full bg-indigo-500 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="mt-1 tabular-nums text-[11px] text-ink-faint">
                            {gb(progress.downloadedBytes)} of {gb(e.sizeBytes)} ({pct}%)
                            {progress.speedBps > 0 && <> · {formatSpeed(progress.speedBps)}</>}
                            {progress.etaSeconds !== null && (
                              <> · about {formatEta(progress.etaSeconds)} left</>
                            )}
                          </p>
                        </div>
                      )}
                    </li>
                  )
                })}
            </ul>

            <HuggingFaceBrowser
              downloading={downloads}
              onDownload={(r, f) => void downloadHf(r, f)}
            />
          </Section>

          <Section title="Remote models — OpenRouter">
            <p className="text-xs leading-relaxed text-ink-faint">
              {apiKeyConfigured
                ? 'Connected. Remote models appear in the chat model picker.'
                : 'Bring your own OpenRouter API key to use hosted models (Claude, GPT, and more). The key is stored encrypted in your system keychain.'}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                value={orKey}
                onChange={(e) => setOrKey(e.target.value)}
                placeholder={apiKeyConfigured ? 'API key (saved — paste to replace)' : 'sk-or-…'}
                className="flex-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => {
                  void saveApiKey(orKey.trim()).then((ok) => {
                    if (ok) setOrKey('')
                  })
                }}
                disabled={!orKey.trim()}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised disabled:opacity-50"
              >
                {apiKeyConfigured ? 'Replace' : 'Connect'}
              </button>
            </div>
          </Section>

          <Section title="Have a GGUF file already?">
            <button
              onClick={() => void importLocalModel()}
              className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:bg-raised"
            >
              Import a .gguf file…
            </button>
          </Section>
        </div>
      </div>
    </div>
  )
}
