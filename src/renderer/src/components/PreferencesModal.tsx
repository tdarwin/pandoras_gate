import { useEffect, useState } from 'react'
import { usePrefsStore } from '../stores/prefs'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'

function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-zinc-200">{label}</span>
        <span className="block text-xs leading-relaxed text-zinc-500">{hint}</span>
      </span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-indigo-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  )
}

function SyncSection(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [token, setToken] = useState('')
  const [tokenConfigured, setTokenConfigured] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!novel) return
    void window.pandora.invoke('sync:getConfig', { novelDir: novel.dir }).then((r) => {
      if (r.ok) {
        setRemoteUrl(r.data.remoteUrl ?? '')
        setTokenConfigured(r.data.tokenConfigured)
      }
    })
  }, [novel])

  if (!novel) {
    return (
      <p className="text-xs text-zinc-600">Open a novel to configure its remote repository.</p>
    )
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    const result = await window.pandora.invoke('sync:setConfig', {
      novelDir: novel.dir,
      remoteUrl: remoteUrl.trim(),
      ...(token.trim() ? { token: token.trim() } : {})
    })
    setBusy(false)
    if (result.ok) {
      setStatus('Saved.')
      if (token.trim()) setTokenConfigured(true)
      setToken('')
    } else {
      setStatus(result.error.message)
    }
  }

  const push = async (): Promise<void> => {
    setBusy(true)
    setStatus('Pushing…')
    const result = await window.pandora.invoke('sync:push', { novelDir: novel.dir })
    setBusy(false)
    setStatus(result.ok ? `Pushed to ${result.data.remoteUrl}` : result.error.message)
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-zinc-500">
        Back up “{novel.manifest.title}” to a remote git repository over HTTPS. Create an empty
        repository (GitHub, GitLab, …) and an access token with write permission — the token is
        stored encrypted in your system keychain.
      </p>
      <input
        value={remoteUrl}
        onChange={(e) => setRemoteUrl(e.target.value)}
        placeholder="https://github.com/you/my-novel.git  (git@… is converted)"
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={tokenConfigured ? 'Access token (saved — paste to replace)' : 'Access token'}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !remoteUrl.trim()}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => void push()}
          disabled={busy || !remoteUrl.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Push now
        </button>
        {status && <span className="min-w-0 truncate text-xs text-zinc-500">{status}</span>}
      </div>
    </div>
  )
}

export default function PreferencesModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const prefs = usePrefsStore()
  const apiKeyConfigured = useChatStore((s) => s.apiKeyConfigured)
  const saveApiKey = useChatStore((s) => s.saveApiKey)
  const [key, setKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<string | null>(null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-200">Preferences</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Writing</h3>
          <Toggle
            checked={prefs.autoStoryBible}
            onChange={(v) => void prefs.update({ autoStoryBible: v })}
            label="Update the Codex automatically"
            hint="A little while after you stop writing, the AI proposes Codex updates (you still review them). Off = only when you click “Update Codex” or ask in chat."
          />
          <Toggle
            checked={prefs.snapshotOnBlur}
            onChange={(v) => void prefs.update({ snapshotOnBlur: v })}
            label="Snapshot when leaving the window"
            hint="Take a history snapshot when the app loses focus. ⌘S and switching chapters always snapshot."
          />
          <div className="flex items-start justify-between gap-4 py-2">
            <span>
              <span className="block text-sm text-zinc-200">Regular interval snapshots</span>
              <span className="block text-xs leading-relaxed text-zinc-500">
                Also snapshot on a timer while you write. “No interval” keeps snapshots to ⌘S,
                leaving the window, and switching chapters. Timer snapshots only create a history
                entry when something actually changed.
              </span>
            </span>
            <select
              value={prefs.snapshotIntervalMinutes}
              onChange={(e) =>
                void prefs.update({
                  snapshotIntervalMinutes: Number(e.target.value) as 0 | 5 | 10 | 15 | 20
                })
              }
              className="mt-0.5 shrink-0 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none"
            >
              <option value={0}>No interval</option>
              <option value={5}>Every 5 minutes</option>
              <option value={10}>Every 10 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={20}>Every 20 minutes</option>
            </select>
          </div>

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">
            OpenRouter
          </h3>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                apiKeyConfigured ? 'API key (saved — paste to replace)' : 'API key (sk-or-…)'
              }
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => {
                void saveApiKey(key.trim()).then((ok) => {
                  setKeyStatus(ok ? 'Saved.' : 'Could not save the key.')
                  if (ok) setKey('')
                })
              }}
              disabled={!key.trim()}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {keyStatus && <p className="mt-1 text-xs text-zinc-500">{keyStatus}</p>}

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Sync (this novel)
          </h3>
          <div className="mt-2">
            <SyncSection />
          </div>

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Observability
          </h3>
          <div className="mt-2">
            <ObservabilitySection />
          </div>
        </div>
      </div>
    </div>
  )
}

function ObservabilitySection(): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    void window.pandora.invoke('telemetry:status', undefined).then((r) => {
      if (r.ok) setEnabled(r.data.enabled)
    })
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-zinc-500">
        In development mode, OpenTelemetry traces are exported using the standard{' '}
        <code className="text-zinc-400">OTEL_EXPORTER_OTLP_*</code> environment variables (from
        your shell/.envrc). Packaged builds never send telemetry.{' '}
        {enabled === null ? null : enabled ? (
          <span className="text-emerald-400">Currently exporting.</span>
        ) : (
          <span className="text-zinc-600">Currently off (no OTLP endpoint in environment).</span>
        )}
      </p>
      <div>
        <button
          onClick={() => void window.pandora.invoke('app:openLogs', undefined)}
          className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          Open local log folder…
        </button>
      </div>
    </div>
  )
}
