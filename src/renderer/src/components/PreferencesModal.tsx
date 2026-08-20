import { useCallback, useEffect, useState } from 'react'
import { MODEL_ROLES, recommend } from '@shared/llm/catalog'
import {
  SNAPSHOT_INTERVALS,
  CONTEXT_TARGETS,
  THEME_BASES,
  CUSTOM_THEME_RE,
  type SnapshotInterval,
  type ContextTarget,
  type ThemeBase,
  type ThemePref
} from '@shared/prefs'
import type { ThemeSummary } from '@shared/schemas/theme'
import { usePrefsStore, type ModelRole } from '../stores/prefs'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import { onIpcEvent } from '../lib/events'
import { FONT_SUGGESTIONS } from '../lib/fonts'

/* Labels keyed by the shared value sets: adding a value to @shared/prefs is a
 * compile error here until the label exists — the UI cannot drift silently. */
const THEME_LABELS: Record<ThemeBase, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System'
}
const SNAPSHOT_LABELS: Record<SnapshotInterval, string> = {
  0: 'No interval',
  5: 'Every 5 minutes',
  10: 'Every 10 minutes',
  15: 'Every 15 minutes',
  20: 'Every 20 minutes'
}
const CONTEXT_LABELS: Record<ContextTarget, string> = {
  0: 'Automatic',
  8192: 'Compact (~8k tokens)',
  16384: 'Roomy (~16k tokens)',
  32768: 'Maximal (~32k tokens)'
}

const EDITOR_FONT_SIZES = [13, 14, 15, 16, 17, 18, 20]
const EDITOR_LINE_HEIGHTS = [1.5, 1.6, 1.75, 1.9, 2.1]
const EDITOR_MEASURES = [36, 42, 46, 52, 60]

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
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-xs leading-relaxed text-ink-faint">{hint}</span>
      </span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-indigo-600' : 'bg-raised'
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
      <p className="text-xs text-ink-faint">Open a novel to configure its remote repository.</p>
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
      <p className="text-xs leading-relaxed text-ink-faint">
        Back up “{novel.manifest.title}” to a remote git repository over HTTPS. Create an empty
        repository (GitHub, GitLab, …) and an access token with write permission — the token is
        stored encrypted in your system keychain.
      </p>
      <input
        value={remoteUrl}
        onChange={(e) => setRemoteUrl(e.target.value)}
        placeholder="https://github.com/you/my-novel.git  (git@… is converted)"
        className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
      />
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={tokenConfigured ? 'Access token (saved — paste to replace)' : 'Access token'}
        className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !remoteUrl.trim()}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised disabled:opacity-50"
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
        {status && <span className="min-w-0 truncate text-xs text-ink-faint">{status}</span>}
      </div>
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  const prefs = usePrefsStore()
  const [themes, setThemes] = useState<ThemeSummary[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [fontDraft, setFontDraft] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.pandora.invoke('themes:list', undefined)
    if (result.ok) setThemes(result.data.themes)
  }, [])

  useEffect(() => {
    void refresh()
    // Live: imports, hand edits, and deletions show up while the modal is open.
    return onIpcEvent('themes:changed', () => void refresh())
  }, [refresh])

  const selectTheme = (value: string): void => {
    const theme: ThemePref | undefined =
      THEME_BASES.find((t) => t === value) ??
      (CUSTOM_THEME_RE.test(value) ? (value as ThemePref) : undefined)
    if (theme) void prefs.update({ theme })
  }

  const importTheme = async (): Promise<void> => {
    setStatus(null)
    const result = await window.pandora.invoke('themes:import', undefined)
    if (!result.ok) {
      setStatus(result.error.message)
      return
    }
    if (result.data.id === null) return
    await refresh()
    await prefs.update({ theme: `custom:${result.data.id}` })
    setStatus('Imported and applied.')
  }

  const saveAsCustom = async (): Promise<void> => {
    setStatus(null)
    const from: ThemePref =
      prefs.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : prefs.theme
    const result = await window.pandora.invoke('themes:duplicateCurrent', { from })
    if (!result.ok) {
      setStatus(result.error.message)
      return
    }
    await refresh()
    await prefs.update({ theme: `custom:${result.data.id}` })
    setStatus('Saved — tweak it via “Open themes folder”; edits apply live.')
  }

  const commitFont = (raw: string): void => {
    const family = raw.trim()
    void prefs.update({ editorFontFamily: family === '' ? null : family })
    setFontDraft(null)
  }

  // A selected custom theme whose folder vanished still needs a visible row.
  const missingSelected =
    prefs.theme.startsWith('custom:') &&
    !themes.some((t) => `custom:${t.id}` === prefs.theme)

  const selectClass =
    'mt-0.5 shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none'

  return (
    <div>
      <div className="flex items-center justify-between py-2">
        <span>
          <span className="block text-sm text-ink">Theme</span>
          <span className="block text-xs text-ink-faint">
            System follows your OS setting. Custom themes live in the themes folder.
          </span>
        </span>
        <select value={prefs.theme} onChange={(e) => selectTheme(e.target.value)} className={selectClass}>
          {THEME_BASES.map((t) => (
            <option key={t} value={t}>
              {THEME_LABELS[t]}
            </option>
          ))}
          {themes.length > 0 && <option disabled>──────────</option>}
          {themes.map((t) => (
            <option
              key={t.id}
              value={`custom:${t.id}`}
              disabled={!t.valid}
              title={t.problem ?? t.name}
            >
              {t.valid ? t.name : `${t.name} (broken: ${t.problem ?? 'invalid'})`}
            </option>
          ))}
          {missingSelected && (
            <option value={prefs.theme}>{prefs.theme.slice('custom:'.length)} (missing)</option>
          )}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 py-1">
        <button
          onClick={() => void importTheme()}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised"
        >
          Import theme…
        </button>
        <button
          onClick={() => void saveAsCustom()}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised"
        >
          Save current as custom theme
        </button>
        <button
          onClick={() => void window.pandora.invoke('themes:openFolder', undefined)}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised"
        >
          Open themes folder
        </button>
        {status && <span className="min-w-0 truncate text-xs text-ink-faint">{status}</span>}
      </div>

      <div className="flex items-start justify-between gap-4 py-2">
        <span>
          <span className="block text-sm text-ink">Editor font</span>
          <span className="block text-xs leading-relaxed text-ink-faint">
            Any font installed on this Mac, by name. Empty = the theme&apos;s font.
          </span>
        </span>
        <input
          list="pandora-font-suggestions"
          value={fontDraft ?? prefs.editorFontFamily ?? ''}
          placeholder="Theme default"
          onChange={(e) => setFontDraft(e.target.value)}
          onBlur={(e) => commitFont(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitFont(e.currentTarget.value)
          }}
          className="mt-0.5 w-48 shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none focus:border-indigo-500"
        />
        <datalist id="pandora-font-suggestions">
          {FONT_SUGGESTIONS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div className="flex items-center justify-between gap-4 py-2">
        <span className="block text-sm text-ink">Editor size &amp; spacing</span>
        <span className="flex shrink-0 items-center gap-2">
          <select
            value={prefs.editorFontSize ?? ''}
            onChange={(e) =>
              void prefs.update({
                editorFontSize: e.target.value === '' ? null : Number(e.target.value)
              })
            }
            title="Font size"
            className={selectClass}
          >
            <option value="">Size</option>
            {EDITOR_FONT_SIZES.map((v) => (
              <option key={v} value={v}>
                {v}px
              </option>
            ))}
          </select>
          <select
            value={prefs.editorLineHeight ?? ''}
            onChange={(e) =>
              void prefs.update({
                editorLineHeight: e.target.value === '' ? null : Number(e.target.value)
              })
            }
            title="Line height"
            className={selectClass}
          >
            <option value="">Spacing</option>
            {EDITOR_LINE_HEIGHTS.map((v) => (
              <option key={v} value={v}>
                ×{v}
              </option>
            ))}
          </select>
          <select
            value={prefs.editorMeasure ?? ''}
            onChange={(e) =>
              void prefs.update({
                editorMeasure: e.target.value === '' ? null : Number(e.target.value)
              })
            }
            title="Line width"
            className={selectClass}
          >
            <option value="">Width</option>
            {EDITOR_MEASURES.map((v) => (
              <option key={v} value={v}>
                {v}rem
              </option>
            ))}
          </select>
        </span>
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
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">Preferences</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Appearance</h3>
          <AppearanceSection />

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-ink-faint">Writing</h3>
          <Toggle
            checked={prefs.autoCodex}
            onChange={(v) => void prefs.update({ autoCodex: v })}
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
              <span className="block text-sm text-ink">Regular interval snapshots</span>
              <span className="block text-xs leading-relaxed text-ink-faint">
                Also snapshot on a timer while you write. “No interval” keeps snapshots to ⌘S,
                leaving the window, and switching chapters. Timer snapshots only create a history
                entry when something actually changed.
              </span>
            </span>
            <select
              value={prefs.snapshotIntervalMinutes}
              onChange={(e) => {
                const minutes = SNAPSHOT_INTERVALS.find((v) => v === Number(e.target.value))
                if (minutes !== undefined) void prefs.update({ snapshotIntervalMinutes: minutes })
              }}
              className="mt-0.5 shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none"
            >
              {SNAPSHOT_INTERVALS.map((v) => (
                <option key={v} value={v}>
                  {SNAPSHOT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-start justify-between gap-4 py-2">
            <span>
              <span className="block text-sm text-ink">Story context size</span>
              <span className="block text-xs leading-relaxed text-ink-faint">
                How much of the chapter, Codex, and summaries is sent with every AI message.
                Bigger = more story awareness but slower and pricier. Automatic stays lean and
                scales gently with the model&apos;s window.
              </span>
            </span>
            <select
              value={prefs.contextTargetTokens}
              onChange={(e) => {
                const target = CONTEXT_TARGETS.find((v) => v === Number(e.target.value))
                if (target !== undefined) void prefs.update({ contextTargetTokens: target })
              }}
              className="mt-0.5 shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none"
            >
              {CONTEXT_TARGETS.map((v) => (
                <option key={v} value={v}>
                  {CONTEXT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-ink-faint">
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
              className="flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => {
                void saveApiKey(key.trim()).then((ok) => {
                  setKeyStatus(ok ? 'Saved.' : 'Could not save the key.')
                  if (ok) setKey('')
                })
              }}
              disabled={!key.trim()}
              className="rounded-lg border border-line-strong px-3 py-2 text-xs text-ink hover:bg-raised disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {keyStatus && <p className="mt-1 text-xs text-ink-faint">{keyStatus}</p>}

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-ink-faint">
            AI models by task
          </h3>
          <ModelRolesSection />

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-ink-faint">
            AI instructions (this novel)
          </h3>
          <div className="mt-2">
            <NovelInstructionsSection />
          </div>

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-ink-faint">
            Sync (this novel)
          </h3>
          <div className="mt-2">
            <SyncSection />
          </div>
        </div>
      </div>
    </div>
  )
}

/* Keyed by ModelRole so adding a role to MODEL_ROLES stops compiling until
 * this section can render it — the exhaustiveness DEVELOPMENT.md promises. */
const ROLE_ROWS: Record<ModelRole, { label: string; hint: string }> = {
  drafting: {
    label: 'Drafting & outlining',
    hint: 'Writes chapter drafts and outlines — worth your biggest model.'
  },
  copyEdit: {
    label: 'Copy editing & proofreading',
    hint: 'Line-level fixes: grammar, typos, phrasing. A small, fast model does fine.'
  },
  developmental: {
    label: 'Developmental editing & fact-checking',
    hint: 'Structural feedback and continuity checks against the Codex — benefits from a larger model.'
  },
  codex: {
    label: 'Codex updates',
    hint: 'Extracts summaries, character and world updates when you save a chapter.'
  }
}

function ModelRolesSection(): React.JSX.Element {
  const prefs = usePrefsStore()
  const models = useChatStore((s) => s.models)
  const initChat = useChatStore((s) => s.init)
  const loadModels = useChatStore((s) => s.loadModels)
  /** Best installed catalog model per role, for the "Recommended" nudge. */
  const [suggestions, setSuggestions] = useState<Partial<Record<ModelRole, string>>>({})

  // Prefs can open before the chat panel ever initialized (Welcome screen).
  useEffect(() => {
    initChat()
    if (models.length === 0) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void (async () => {
      const result = await window.pandora.invoke('models:catalog', undefined)
      if (!result.ok) return
      // Only models actually on disk — suggesting one the user hasn't
      // downloaded would be a dead end in a dropdown of installed models.
      const installed = result.data.entries.filter((e) => e.installedPath !== null)
      const next: Partial<Record<ModelRole, string>> = {}
      for (const role of MODEL_ROLES) {
        const best = recommend(installed, {
          useCase: role,
          style: null,
          showUnfiltered: true
        })[0]
        if (best?.installedPath) next[role] = best.installedPath
      }
      setSuggestions(next)
    })()
  }, [models])

  return (
    <div>
      <p className="py-1 text-xs leading-relaxed text-ink-faint">
        Use different models for different kinds of work — a big model where quality matters, a
        small one where speed does. “Chat model” means whatever is selected in the chat panel.
      </p>
      {MODEL_ROLES.map((key) => {
        const { label, hint } = ROLE_ROWS[key]
        const assigned = prefs.modelRoles[key]
        const missing = assigned !== null && !models.some((m) => m.id === assigned)
        const suggested = suggestions[key]
        const suggestedName =
          suggested && suggested !== assigned
            ? models.find((m) => m.id === suggested)?.name
            : undefined
        return (
          <div key={key} className="flex items-start justify-between gap-4 py-2">
            <span>
              <span className="block text-sm text-ink">{label}</span>
              <span className="block text-xs leading-relaxed text-ink-faint">{hint}</span>
              {suggestedName && (
                <button
                  onClick={() => void prefs.update({ modelRoles: { [key]: suggested } })}
                  className="mt-0.5 text-xs text-indigo-400 hover:text-indigo-300"
                >
                  Recommended: {suggestedName} — use it
                </button>
              )}
            </span>
            <select
              value={assigned ?? ''}
              onChange={(e) => void prefs.update({ modelRoles: { [key]: e.target.value || null } })}
              className="mt-0.5 max-w-52 shrink-0 truncate rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none"
            >
              <option value="">Chat model</option>
              {missing && <option value={assigned}>{assigned} (unavailable)</option>}
              {models.some((m) => m.provider === 'local') && (
                <optgroup label="On this machine">
                  {models
                    .filter((m) => m.provider === 'local')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </optgroup>
              )}
              {models.some((m) => m.provider === 'openrouter') && (
                <optgroup label="OpenRouter">
                  {models
                    .filter((m) => m.provider === 'openrouter')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </div>
        )
      })}
    </div>
  )
}

function NovelInstructionsSection(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)
  const applyNovelState = useProjectStore((s) => s.applyNovelState)
  const [text, setText] = useState(novel?.manifest.chatInstructions ?? '')
  const [status, setStatus] = useState<string | null>(null)

  if (!novel) {
    return <p className="text-xs text-ink-faint">Open a novel to set its AI instructions.</p>
  }

  const save = async (): Promise<void> => {
    const result = await window.pandora.invoke('project:setChatInstructions', {
      novelDir: novel.dir,
      instructions: text
    })
    if (result.ok) {
      applyNovelState({ ...result.data, seriesTitle: novel.seriesTitle })
      setStatus('Saved — applied to every chat, draft, and Codex run for this novel.')
    } else {
      setStatus(result.error.message)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-ink-faint">
        Standing instructions appended to the AI&apos;s system prompt for “
        {novel.manifest.title}” — voice, tense, POV rules, content boundaries, style dos and
        don&apos;ts. Stored in novel.yaml.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={'e.g. Past tense, third person limited (Kael POV).\nNo modern slang. Keep chapters under 3,000 words.'}
        className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised"
        >
          Save instructions
        </button>
        {status && <span className="min-w-0 truncate text-xs text-ink-faint">{status}</span>}
      </div>
    </div>
  )
}

