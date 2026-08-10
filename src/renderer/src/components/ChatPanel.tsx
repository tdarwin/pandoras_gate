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
    <div className="border-t border-zinc-800 px-3 py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        <span>
          Context: {report.usedTokens.toLocaleString()} / {report.budgetTokens.toLocaleString()}{' '}
          tokens
        </span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="mt-1.5 max-h-40 overflow-y-auto pb-1">
          {report.sections.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[s.status]}`} />
              <span className="min-w-0 flex-1 truncate text-zinc-400">{s.label}</span>
              <span className="shrink-0 text-zinc-600">
                {s.status === 'dropped' ? 'dropped' : `${s.tokens.toLocaleString()} tok`}
                {s.status === 'degraded' ? ' (trimmed)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ModelSetupPrompt({ onOpenModels }: { onOpenModels: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h3 className="text-sm font-medium text-zinc-300">No model connected yet</h3>
      <p className="text-xs leading-relaxed text-zinc-500">
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
    <aside className="flex w-[26rem] shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/60">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Chat</h2>
        <div className="flex min-w-0 items-center gap-1">
          {models.length > 0 && (
            <select
              value={selectedModelId ?? ''}
              onChange={(e) => selectModel(e.target.value)}
              className="max-w-48 truncate rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 outline-none"
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
            className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            Models
          </button>
          {messages.length > 0 && (
            <button
              onClick={clear}
              title="Clear conversation"
              className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
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
              <p className="mt-8 text-center text-xs leading-relaxed text-zinc-600">
                Ask about your story, brainstorm plot points,
                <br />
                or talk through a scene.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`mb-3 ${m.role === 'user' ? 'flex justify-end' : ''}`}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600/80 px-3 py-2 text-sm text-white">
                    {m.content}
                  </div>
                ) : (
                  <div className="prose-chat max-w-none text-sm leading-relaxed text-zinc-200">
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
          <div className="shrink-0 border-t border-zinc-800 p-3">
            {usage && (
              <div className="mb-1.5 text-right text-[10px] text-zinc-600">
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
                rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                placeholder="Message… (Enter to send, Shift+Enter for newline)"
                className="min-h-9 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
              />
              {streaming ? (
                <button
                  onClick={() => void cancel()}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
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
