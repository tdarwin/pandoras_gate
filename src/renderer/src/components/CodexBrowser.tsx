import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useProposalsStore } from '../stores/proposals'
import { codexSection, type CodexSection } from '../lib/codexPaths'
import SuggestionDot from './SuggestionDot'
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
  pending,
  children
}: {
  title: string
  onAdd?: () => void
  /** Rolled up from the section's rows, shown only while it is collapsed. */
  pending: { count: number; sources: string[] }
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 text-left"
        >
          <span className="text-xs text-ink-faint">{open ? '▾' : '▸'}</span>
          <h3 className="truncate text-xs font-medium uppercase tracking-wide text-ink-faint">
            {title}
          </h3>
          {/* Collapsing a section must not hide that something is waiting in it. */}
          {!open && (
            <SuggestionDot count={pending.count} sources={pending.sources} aggregate />
          )}
        </button>
        {onAdd && (
          <button
            onClick={onAdd}
            className="rounded px-1.5 text-ink-muted hover:bg-raised hover:text-ink"
          >
            +
          </button>
        )}
      </div>
      {open && <ul className="mt-1 px-2">{children}</ul>}
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
  const pendingByPath = useProposalsStore((s) => s.pendingByPath)

  // Paths with suggestions that have no file on disk yet.
  const phantoms = useMemo(
    () => [...pendingByPath.values()].filter((m) => m.action === 'create'),
    [pendingByPath]
  )

  const sectionPending = useMemo(() => {
    const out = {} as Record<CodexSection, { count: number; sources: string[] }>
    for (const mark of pendingByPath.values()) {
      const section = codexSection(mark.path)
      if (!section) continue
      const bucket = (out[section] ??= { count: 0, sources: [] })
      bucket.count += mark.count
      for (const src of mark.sources) if (!bucket.sources.includes(src)) bucket.sources.push(src)
    }
    return out
  }, [pendingByPath])
  const forSection = (s: CodexSection): { count: number; sources: string[] } =>
    sectionPending[s] ?? { count: 0, sources: [] }

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

  const item = (file: string, label: string): React.JSX.Element => {
    const mark = pendingByPath.get(file)
    const isNew = mark?.action === 'create'
    return (
      <li key={file}>
        <button
          // A create has no file yet — opening it shows the proposed document
          // as one big insertion rather than an ENOENT.
          onClick={() => void openChapter(file, { allowMissing: isNew })}
          className={`flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-sm ${
            activeFile === file
              ? 'bg-raised text-ink'
              : 'text-ink-muted hover:bg-raised/60 hover:text-ink'
          }`}
          title={label}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {isNew && (
            <span className="shrink-0 rounded bg-emerald-950 px-1 text-[10px] text-emerald-300">
              NEW
            </span>
          )}
          {mark && (
            <SuggestionDot count={mark.count} sources={mark.sources} blocked={mark.blocked} />
          )}
        </button>
      </li>
    )
  }

  /** Rows for documents that exist only as a proposal, by section. */
  const phantomsIn = (section: CodexSection): React.JSX.Element[] =>
    phantoms
      .filter((m) => codexSection(m.path) === section)
      .map((m) => item(m.path, m.label ?? m.path.split('/').pop()!))

  /**
   * Rows for the "Other" bucket. Unlike the named sections there is no
   * `metadata:list` enumeration behind it, so updates need drawing here too —
   * otherwise the header carries a count with nothing underneath it.
   */
  const otherRows = (): React.JSX.Element[] =>
    [...pendingByPath.values()]
      .filter((m) => codexSection(m.path) === 'other')
      .map((m) => item(m.path, m.label ?? m.path.split('/').pop()!))

  if (!listing) return <p className="p-4 text-sm text-ink-faint">Loading…</p>

  return (
    <div className="flex-1 overflow-y-auto pb-3">
      <Section title="Story" pending={forSection('story')}>
        {listing.hasSynopsis && item('metadata/synopsis.md', 'Synopsis')}
        {listing.hasGlossary && item('metadata/glossary.md', 'Glossary')}
        {listing.hasTimeline && item('metadata/timeline.yaml', 'Timeline')}
        {phantomsIn('story')}
      </Section>

      <Section title="Outlines" pending={forSection('outlines')}>
        {listing.outlines.map((o) => item(o.file, o.title))}
        {phantomsIn('outlines')}
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

      <Section title="Characters" pending={forSection('characters')} onAdd={() => setAdding('character')}>
        {listing.characters.map((c) => item(c.file, c.name))}
        {phantomsIn('characters')}
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
        {listing.characters.length === 0 && phantomsIn('characters').length === 0 && adding !== 'character' && (
          <li className="px-2 py-1 text-xs text-ink-faint">
            No profiles yet — the AI proposes them as you write.
          </li>
        )}
      </Section>

      <Section title="World & systems" pending={forSection('world')} onAdd={() => setAdding('world')}>
        {listing.world.map((w) => item(w.file, w.name))}
        {phantomsIn('world')}
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
        {listing.world.length === 0 && phantomsIn('world').length === 0 && adding !== 'world' && (
          <li className="px-2 py-1 text-xs text-ink-faint">
            Magic systems, factions, rules of the world.
          </li>
        )}
      </Section>

      {(listing.summaries.length > 0 || forSection('summaries').count > 0) && (
        <Section title="Chapter summaries" pending={forSection('summaries')}>
          {listing.summaries.map((s) => item(s.file, s.title))}
          {phantomsIn('summaries')}
        </Section>
      )}

      {(listing.reviews.length > 0 || forSection('reviews').count > 0) && (
        <Section title="Editing reviews" pending={forSection('reviews')}>
          {listing.reviews.map((r) => item(r.file, r.title))}
          {phantomsIn('reviews')}
        </Section>
      )}

      {/* Anything the allowlist permits that has no section of its own —
          counted in the badges either way, so it needs somewhere to be. */}
      {forSection('other').count > 0 && (
        <Section title="Other" pending={forSection('other')}>
          {otherRows()}
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
