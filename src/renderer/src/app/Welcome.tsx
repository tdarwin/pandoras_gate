import { useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useUiStore } from '../stores/ui'

export default function Welcome(): React.JSX.Element {
  const setNovel = useProjectStore((s) => s.setNovel)
  const welcomeIntent = useUiStore((s) => s.welcomeIntent)
  const [recents, setRecents] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [seriesTitle, setSeriesTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.pandora.invoke('app:getRecentNovels', undefined).then((r) => {
      if (r.ok) setRecents(r.data.dirs)
    })
  }, [])

  // File → New Novel… jumps straight to the create form; the intent is
  // cleared on consumption so revisiting Welcome later doesn't replay it.
  useEffect(() => {
    if (welcomeIntent === 'create') {
      useUiStore.getState().setWelcomeIntent(null)
      setCreating(true)
    }
  }, [welcomeIntent])

  const openExisting = async (dir?: string): Promise<void> => {
    setError(null)
    let target = dir
    if (!target) {
      const picked = await window.pandora.invoke('dialog:chooseDirectory', {
        title: 'Open a novel folder'
      })
      if (!picked.ok || !picked.data.dir) return
      target = picked.data.dir
    }
    const result = await window.pandora.invoke('project:openNovel', { dir: target })
    if (result.ok) setNovel(result.data)
    else setError(result.error.message)
  }

  const create = async (): Promise<void> => {
    setError(null)
    if (!title.trim()) {
      setError('Give your novel a title.')
      return
    }
    const picked = await window.pandora.invoke('dialog:chooseDirectory', {
      title: 'Where should the novel folder be created?'
    })
    if (!picked.ok || !picked.data.dir) return
    setBusy(true)
    const result = await window.pandora.invoke('project:createNovel', {
      parentDir: picked.data.dir,
      title: title.trim(),
      author: author.trim(),
      ...(seriesTitle.trim() ? { seriesTitle: seriesTitle.trim() } : {})
    })
    setBusy(false)
    if (result.ok) setNovel(result.data)
    else setError(result.error.message)
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">
        <h1 className="text-center text-3xl font-semibold tracking-tight">Pandora&apos;s Gate</h1>
        <p className="mt-2 text-center text-ink-muted">
          Your stories, your worlds, your AI writing partner.
        </p>

        {!creating ? (
          <div className="mt-8 flex flex-col gap-3">
            <button
              onClick={() => setCreating(true)}
              className="rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500"
            >
              Create a new novel
            </button>
            <button
              onClick={() => void openExisting()}
              className="rounded-lg border border-line-strong px-4 py-2.5 font-medium text-ink hover:bg-raised"
            >
              Open an existing novel…
            </button>
            {recents.length > 0 && (
              <div className="mt-4">
                <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Recent
                </h2>
                <ul className="mt-2 flex flex-col gap-1">
                  {recents.map((dir) => (
                    <li key={dir}>
                      <button
                        onClick={() => void openExisting(dir)}
                        className="w-full truncate rounded px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-raised"
                        title={dir}
                      >
                        {dir.split('/').at(-1)}
                        <span className="ml-2 text-xs text-ink-faint">{dir}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-ink outline-none focus:border-indigo-500"
                placeholder="The Iron Gate"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Author
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-ink outline-none focus:border-indigo-500"
                placeholder="Your name"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Series <span className="text-ink-faint">(optional — creates a series folder)</span>
              <input
                value={seriesTitle}
                onChange={(e) => setSeriesTitle(e.target.value)}
                className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-ink outline-none focus:border-indigo-500"
                placeholder="Jade Ascension"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void create()}
                disabled={busy}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Choose location & create'}
              </button>
              <button
                onClick={() => setCreating(false)}
                className="rounded-lg border border-line-strong px-4 py-2.5 text-ink-muted hover:bg-raised"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-4 text-center text-sm text-red-400">{error}</p>}
      </div>
    </div>
  )
}
