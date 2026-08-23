import { useCallback, useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useProposalsStore } from '../stores/proposals'
import AiPromptModal from './AiPromptModal'

interface Listing {
  characters: { file: string; name: string }[]
  world: { file: string; name: string }[]
  summaries: { file: string; title: string }[]
  outlines: { file: string; title: string }[]
  reviews: { file: string; title: string }[]
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
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
        {onAdd && (
          <button
            onClick={onAdd}
            className="rounded px-1.5 text-ink-muted hover:bg-raised hover:text-ink"
          >
            +
          </button>
        )}
      </div>
      <ul className="mt-1 px-2">{children}</ul>
    </div>
  )
}

export default function CodexBrowser(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const openChapter = useProjectStore((s) => s.openChapter)
  const setError = useProjectStore((s) => s.setError)

  const [listing, setListing] = useState<Listing | null>(null)
  const [adding, setAdding] = useState<'character' | 'world' | null>(null)
  const [newName, setNewName] = useState('')
  const [showOutlineModal, setShowOutlineModal] = useState(false)
  const generateOutline = useProposalsStore((s) => s.generateOutline)
  const proposalsRunning = useProposalsStore((s) => s.running)

  const pendingTotal = useProposalsStore((s) => s.pendingTotal)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.pandora.invoke('metadata:list', { novelDir: novel.dir })
    if (result.ok) setListing(result.data)
    else setError(result.error.message)
  }, [novel.dir, setError])

  // Re-list whenever proposals are created or resolved — accepting a
  // suggestion writes new Codex files that must appear here immediately.
  useEffect(() => {
    void refresh()
  }, [refresh, pendingTotal])

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
            ? 'bg-raised text-ink'
            : 'text-ink-muted hover:bg-raised/60 hover:text-ink'
        }`}
        title={label}
      >
        {label}
      </button>
    </li>
  )

  if (!listing) return <p className="p-4 text-sm text-ink-faint">Loading…</p>

  return (
    <div className="flex-1 overflow-y-auto pb-3">
      <Section title="Story">
        {listing.hasSynopsis && item('metadata/synopsis.md', 'Synopsis')}
        {listing.hasGlossary && item('metadata/glossary.md', 'Glossary')}
        {listing.hasTimeline && item('metadata/timeline.yaml', 'Timeline')}
      </Section>

      <Section title="Outlines">
        {listing.outlines.map((o) => item(o.file, o.title))}
        <li className="mt-0.5">
          <button
            onClick={() => setShowOutlineModal(true)}
            disabled={proposalsRunning}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-indigo-300 hover:bg-raised/60 hover:text-indigo-200 disabled:opacity-60"
          >
            {proposalsRunning
              ? 'Working…'
              : listing.outlines.some((o) => o.file === 'outlines/novel.md')
                ? '✦ Refine novel outline with AI'
                : '✦ Outline the novel with AI'}
          </button>
        </li>
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
              className="w-full rounded border border-indigo-500 bg-panel px-2 py-1 text-sm text-ink outline-none"
            />
          </li>
        )}
        {listing.characters.length === 0 && adding !== 'character' && (
          <li className="px-2 py-1 text-xs text-ink-faint">
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
              className="w-full rounded border border-indigo-500 bg-panel px-2 py-1 text-sm text-ink outline-none"
            />
          </li>
        )}
        {listing.world.length === 0 && adding !== 'world' && (
          <li className="px-2 py-1 text-xs text-ink-faint">
            Magic systems, factions, rules of the world.
          </li>
        )}
      </Section>

      {listing.summaries.length > 0 && (
        <Section title="Chapter summaries">
          {listing.summaries.map((s) => item(s.file, s.title))}
        </Section>
      )}

      {listing.reviews.length > 0 && (
        <Section title="Editing reviews">
          {listing.reviews.map((r) => item(r.file, r.title))}
        </Section>
      )}

      {showOutlineModal && (
        <AiPromptModal
          title="Outline the novel"
          description="Generates or refines the whole-novel outline from your synopsis, chapters, and summaries. You review it before it's saved."
          placeholder="Optional direction — structure, arcs, where the story should go… (⌘↵ to generate)"
          cta="Generate outline"
          onSubmit={(guidance) => void generateOutline('novel', guidance).then(refresh)}
          onClose={() => setShowOutlineModal(false)}
        />
      )}
    </div>
  )
}
