import { useCallback, useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'

interface Listing {
  characters: { file: string; name: string }[]
  world: { file: string; name: string }[]
  summaries: { file: string; title: string }[]
  hasSynopsis: boolean
  hasGlossary: boolean
  hasTimeline: boolean
}

function Section({
  title,
  onAdd,
  children
}: {
  title: string
  onAdd?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
        {onAdd && (
          <button
            onClick={onAdd}
            className="rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            +
          </button>
        )}
      </div>
      <ul className="mt-1 px-2">{children}</ul>
    </div>
  )
}

export default function StoryBible(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const openChapter = useProjectStore((s) => s.openChapter)
  const setError = useProjectStore((s) => s.setError)

  const [listing, setListing] = useState<Listing | null>(null)
  const [adding, setAdding] = useState<'character' | 'world' | null>(null)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.pandora.invoke('metadata:list', { novelDir: novel.dir })
    if (result.ok) setListing(result.data)
    else setError(result.error.message)
  }, [novel.dir, setError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submitNew = async (): Promise<void> => {
    if (adding && newName.trim()) {
      const result = await window.pandora.invoke('metadata:create', {
        novelDir: novel.dir,
        kind: adding,
        name: newName.trim()
      })
      if (result.ok) {
        await refresh()
        await openChapter(result.data.file)
      } else {
        setError(result.error.message)
      }
    }
    setAdding(null)
    setNewName('')
  }

  const item = (file: string, label: string): React.JSX.Element => (
    <li key={file}>
      <button
        onClick={() => void openChapter(file)}
        className={`w-full truncate rounded px-2 py-1.5 text-left text-sm ${
          activeFile === file
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
        }`}
        title={label}
      >
        {label}
      </button>
    </li>
  )

  if (!listing) return <p className="p-4 text-sm text-zinc-600">Loading…</p>

  return (
    <div className="flex-1 overflow-y-auto pb-3">
      <Section title="Story">
        {listing.hasSynopsis && item('metadata/synopsis.md', 'Synopsis')}
        {listing.hasGlossary && item('metadata/glossary.md', 'Glossary')}
        {listing.hasTimeline && item('metadata/timeline.yaml', 'Timeline')}
      </Section>

      <Section title="Characters" onAdd={() => setAdding('character')}>
        {listing.characters.map((c) => item(c.file, c.name))}
        {adding === 'character' && (
          <li className="mt-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => void submitNew()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNew()
                if (e.key === 'Escape') setAdding(null)
              }}
              placeholder="Character name…"
              className="w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </li>
        )}
        {listing.characters.length === 0 && adding !== 'character' && (
          <li className="px-2 py-1 text-xs text-zinc-600">
            No profiles yet — the AI proposes them as you write.
          </li>
        )}
      </Section>

      <Section title="World & systems" onAdd={() => setAdding('world')}>
        {listing.world.map((w) => item(w.file, w.name))}
        {adding === 'world' && (
          <li className="mt-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => void submitNew()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNew()
                if (e.key === 'Escape') setAdding(null)
              }}
              placeholder="System name (e.g. Cultivation)…"
              className="w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </li>
        )}
        {listing.world.length === 0 && adding !== 'world' && (
          <li className="px-2 py-1 text-xs text-zinc-600">
            Magic systems, factions, rules of the world.
          </li>
        )}
      </Section>

      {listing.summaries.length > 0 && (
        <Section title="Chapter summaries">
          {listing.summaries.map((s) => item(s.file, s.title))}
        </Section>
      )}
    </div>
  )
}
