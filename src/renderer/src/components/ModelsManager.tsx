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

const FIT_LABEL = {
  recommended: { text: 'Recommended for your machine', cls: 'text-emerald-400' },
  slow: { text: 'Will run, but slowly', cls: 'text-amber-400' },
  'too-large': { text: 'Too large for this machine', cls: 'text-red-400' }
} as const

export default function ModelsManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [error, setError] = useState<string | null>(null)
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
