import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, type ContextReport } from '../stores/chat'
import ModelsManager from './ModelsManager'

function ContextInspector({ report }: { report: ContextReport }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const statusDot = {
    included: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    dropped: 'bg-red-500'
  } as const

  return (
    <div className="border-t border-line px-3 py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-ink-faint hover:text-ink-muted"
      >
        <span>
          Context: {report.usedTokens.toLocaleString()} / {report.budgetTokens.toLocaleString()}{' '}
          tokens
          {report.windowTokens > report.budgetTokens
            ? ` · ${Math.round(report.windowTokens / 1024)}k window`
            : ''}
        </span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <ul className="mt-1.5 max-h-40 overflow-y-auto pb-1">
            {report.sections.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-0.5 text-[11px]">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[s.status]}`} />
                <span className="min-w-0 flex-1 truncate text-ink-muted">{s.label}</span>
                <span className="shrink-0 text-ink-faint">
                  {s.status === 'dropped' ? 'dropped' : `${s.tokens.toLocaleString()} tok`}
                  {s.status === 'degraded' ? ' (trimmed)' : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="pb-1.5 text-[10px] leading-relaxed text-ink-faint">
            Story context (chapter, Codex, outlines) is rebuilt and resent with every message —
            that&apos;s most of this number, and it now includes the agent&apos;s tool
            instructions. The target size is set in Preferences → Story context size. Token
            counts are estimates (≈4 chars/token).
          </p>
        </>
      )}
    </div>
  )
}

function ModelSetupPrompt({ onOpenModels }: { onOpenModels: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h3 className="text-sm font-medium text-ink-muted">No model connected yet</h3>
      <p className="text-xs leading-relaxed text-ink-faint">
        Download a local model that runs entirely on this machine, connect OpenRouter for hosted
        models, or import a GGUF file you already have.
      </p>
      <button
        onClick={onOpenModels}
        className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
      >
        Set up a model…
      </button>
    </div>
  )
}

const PANEL_MIN = 300
const PANEL_MAX = 900
const INPUT_MIN = 40
const INPUT_MAX = 400

function readStoredSize(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Generic pointer-drag helper: calls onMove with cursor deltas until mouseup. */
function startDrag(
  e: React.MouseEvent,
  onMove: (dx: number, dy: number) => void,
  onDone: () => void
): void {
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const move = (ev: MouseEvent): void => onMove(ev.clientX - startX, ev.clientY - startY)
  const up = (): void => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    onDone()
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

export default function ChatPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const {
    models,
    selectedModelId,
    apiKeyConfigured,
    messages,
    streaming,
    usage,
    report,
    toolStatus,
    error,
    init,
    selectModel,
    send,
    cancel,
    clear
  } = useChatStore()

  const [draft, setDraft] = useState('')
  const [showModels, setShowModels] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Both dimensions are user-resizable and remembered.
  const [panelWidth, setPanelWidth] = useState(() => readStoredSize('chat.panelWidth', 416))
  const [inputHeight, setInputHeight] = useState(() => readStoredSize('chat.inputHeight', 0))
  const widthRef = useRef(panelWidth)
  widthRef.current = panelWidth
  const inputHeightRef = useRef(inputHeight)
  inputHeightRef.current = inputHeight

  const clampW = (w: number): number => Math.min(PANEL_MAX, Math.max(PANEL_MIN, w))
  const clampH = (h: number): number => Math.min(INPUT_MAX, Math.max(INPUT_MIN, h))

  const dragWidth = (e: React.MouseEvent): void => {
    const start = widthRef.current
    document.body.style.cursor = 'col-resize'
    startDrag(
      e,
      (dx) => setPanelWidth(clampW(start - dx)),
      () => localStorage.setItem('chat.panelWidth', String(widthRef.current))
    )
  }

  const dragInputHeight = (e: React.MouseEvent): void => {
    const start = inputHeightRef.current || 40
    document.body.style.cursor = 'row-resize'
    startDrag(
      e,
      (_dx, dy) => setInputHeight(clampH(start - dy)),
      () => localStorage.setItem('chat.inputHeight', String(inputHeightRef.current))
    )
  }

  useEffect(() => init(), [init])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const submit = (): void => {
    if (!draft.trim() || streaming) return
    void send(draft)
    setDraft('')
  }

  return (
    <aside
      style={{ width: panelWidth }}
      className="relative flex shrink-0 flex-col border-l border-line bg-panel/60"
    >
      {/* Drag the panel's left edge to resize the whole chat pane. */}
      <div
        onMouseDown={dragWidth}
        title="Drag to resize"
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-indigo-500/30"
      />
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Chat</h2>
        <div className="flex min-w-0 items-center gap-1">
          {models.length > 0 && (
            <select
              value={selectedModelId ?? ''}
              onChange={(e) => selectModel(e.target.value)}
              className="max-w-48 truncate rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-ink-muted outline-none"
            >
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
          )}
          <button
            onClick={() => setShowModels(true)}
            title="Manage local models"
            className="rounded p-1 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            Models
          </button>
          {messages.length > 0 && (
            <button
              onClick={clear}
              title="Clear conversation"
              className="rounded p-1 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            ✕
          </button>
        </div>
      </div>

      {showModels && <ModelsManager onClose={() => setShowModels(false)} />}
      {!apiKeyConfigured && models.length === 0 ? (
        <ModelSetupPrompt onOpenModels={() => setShowModels(true)} />
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
            {messages.length === 0 && (
              <p className="mt-8 text-center text-xs leading-relaxed text-ink-faint">
                Ask about your story, brainstorm plot points,
                <br />
                or talk through a scene.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`mb-3 ${m.role === 'user' ? 'flex justify-end' : ''}`}>
                {m.uiKind === 'tool' ? (
                  <div className="flex items-center gap-2 text-xs text-indigo-400">
                    <span className="rounded-full border border-indigo-800/60 bg-indigo-950/40 px-2 py-0.5">
                      🛠 {m.content}
                    </span>
                  </div>
                ) : m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600/80 px-3 py-2 text-sm text-white">
                    {m.content}
                  </div>
                ) : (
                  <div className="prose-chat max-w-none text-sm leading-relaxed text-ink">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    {streaming && i === messages.length - 1 && (
                      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-indigo-400 align-text-bottom" />
                    )}
                  </div>
                )}
              </div>
            ))}
            {toolStatus && (
              <div className="mb-3 flex items-center gap-2 text-xs text-indigo-300">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                {toolStatus}
              </div>
            )}
            {error && (
              <div className="mb-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}
          </div>

          {report && <ContextInspector report={report} />}
          {/* Drag to give yourself more typing room. */}
          <div
            onMouseDown={dragInputHeight}
            onDoubleClick={() => {
              setInputHeight(0)
              localStorage.removeItem('chat.inputHeight')
            }}
            title="Drag to resize the message box (double-click to reset)"
            className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-t border-line hover:bg-indigo-500/20"
          >
            <span className="h-0.5 w-8 rounded-full bg-raised group-hover:bg-indigo-400" />
          </div>
          <div className="shrink-0 p-3 pt-1.5">
            {usage && (
              <div className="mb-1.5 text-right text-[10px] text-ink-faint">
                {usage.promptTokens.toLocaleString()} in · {usage.completionTokens.toLocaleString()}{' '}
                out
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                {...(inputHeight > 0
                  ? { style: { height: inputHeight } }
                  : { rows: Math.min(6, Math.max(1, draft.split('\n').length)) })}
                placeholder="Message… (Enter to send, Shift+Enter for newline)"
                className="min-h-9 flex-1 resize-none rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500"
              />
              {streaming ? (
                <button
                  onClick={() => void cancel()}
                  className="rounded-lg border border-line-strong px-3 py-2 text-sm text-ink-muted hover:bg-raised"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
