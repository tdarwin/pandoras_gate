import { useState } from 'react'

interface AiPromptModalProps {
  title: string
  description: string
  placeholder: string
  cta: string
  onSubmit: (guidance: string) => void
  onClose: () => void
}

/** Small shared modal for AI actions that take optional author direction. */
export default function AiPromptModal({
  title,
  description,
  placeholder,
  cta,
  onSubmit,
  onClose
}: AiPromptModalProps): React.JSX.Element {
  const [text, setText] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              onSubmit(text)
              onClose()
            }
            if (e.key === 'Escape') onClose()
          }}
          rows={4}
          placeholder={placeholder}
          className="mt-3 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSubmit(text)
              onClose()
            }}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            {cta}
          </button>
        </div>
      </div>
    </div>
  )
}
