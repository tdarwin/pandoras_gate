import { useEffect, useState } from 'react'
import iconUrl from '../assets/icon.png'

type AppInfo = { version: string; electron: string; platform: string }

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}

export default function AboutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.pandora.invoke('app:getInfo', undefined).then((r) => {
      if (r.ok) setInfo(r.data)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">About</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col items-center px-6 py-7 text-center">
          <img
            src={iconUrl}
            alt="Pandora's Gate"
            width={96}
            height={96}
            className="h-24 w-24 rounded-[22%]"
          />
          <h3 className="mt-4 text-lg font-semibold text-ink">Pandora&rsquo;s Gate</h3>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Writer&rsquo;s Studio</p>

          <p className="mt-4 text-sm text-ink-muted">
            {info ? `Version ${info.version}` : 'Version …'}
          </p>
          {info && (
            <p className="mt-0.5 text-xs text-ink-faint">
              Electron {info.electron} · {PLATFORM_NAMES[info.platform] ?? info.platform}
            </p>
          )}

          <p className="mt-5 text-xs leading-relaxed text-ink-faint">
            A desktop studio for writing novels with local and remote AI assistance.
          </p>
          <p className="mt-3 text-xs text-ink-faint">© 2026 Davin Taddeo · MIT License</p>
          <a
            href="https://github.com/tdarwin/pandoras_gate"
            target="_blank"
            rel="noreferrer"
            className="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
          >
            github.com/tdarwin/pandoras_gate
          </a>
        </div>
      </div>
    </div>
  )
}
