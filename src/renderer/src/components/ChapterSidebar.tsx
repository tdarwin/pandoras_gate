import { useState } from 'react'
import { useProjectStore } from '../stores/project'
import StoryBible from './StoryBible'

export default function ChapterSidebar(): React.JSX.Element {
  const [tab, setTab] = useState<'chapters' | 'bible'>('chapters')
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const openChapter = useProjectStore((s) => s.openChapter)
  const createChapter = useProjectStore((s) => s.createChapter)
  const renameChapter = useProjectStore((s) => s.renameChapter)
  const moveChapter = useProjectStore((s) => s.moveChapter)
  const closeNovel = useProjectStore((s) => s.closeNovel)

  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const submitNew = async (): Promise<void> => {
    if (newTitle.trim()) await createChapter(newTitle.trim())
    setNewTitle('')
    setAdding(false)
  }

  const submitRename = async (file: string): Promise<void> => {
    if (renameValue.trim()) await renameChapter(file, renameValue.trim())
    setRenaming(null)
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="min-w-0">
          {novel.seriesTitle && (
            <div className="truncate text-xs text-zinc-500">{novel.seriesTitle}</div>
          )}
          <div className="truncate text-sm font-medium text-zinc-200">{novel.manifest.title}</div>
        </div>
        <button
          onClick={closeNovel}
          title="Close novel"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      <div className="mt-3 flex gap-1 px-2">
        <button
          onClick={() => setTab('chapters')}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
            tab === 'chapters' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Chapters
        </button>
        <button
          onClick={() => setTab('bible')}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
            tab === 'bible' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Story Bible
        </button>
      </div>

      {tab === 'bible' ? (
        <StoryBible />
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between px-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Chapters</h2>
            <button
              onClick={() => setAdding(true)}
              title="New chapter"
              className="rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              +
            </button>
          </div>

          <ul className="mt-1 flex-1 overflow-y-auto px-2 pb-3">
        {novel.manifest.chapters.map((ch, i) => (
          <li key={ch.file} className="group">
            {renaming === ch.file ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void submitRename(ch.file)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(ch.file)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                className="w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none"
              />
            ) : (
              <div
                className={`flex items-center rounded px-2 py-1.5 text-sm ${
                  activeFile === ch.file
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                }`}
              >
                <button
                  onClick={() => void openChapter(ch.file)}
                  onDoubleClick={() => {
                    setRenaming(ch.file)
                    setRenameValue(ch.title)
                  }}
                  className="min-w-0 flex-1 truncate text-left"
                  title={ch.title}
                >
                  <span className="mr-1.5 text-xs text-zinc-600">{i + 1}.</span>
                  {ch.title}
                </button>
                <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                  <button
                    onClick={() => void moveChapter(ch.file, -1)}
                    disabled={i === 0}
                    title="Move up"
                    className="rounded px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => void moveChapter(ch.file, 1)}
                    disabled={i === novel.manifest.chapters.length - 1}
                    title="Move down"
                    className="rounded px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </span>
              </div>
            )}
          </li>
        ))}
        {adding && (
          <li className="mt-1">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onBlur={() => void submitNew()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNew()
                if (e.key === 'Escape') {
                  setAdding(false)
                  setNewTitle('')
                }
              }}
              placeholder="Chapter title…"
              className="w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </li>
        )}
          </ul>
        </>
      )}
    </aside>
  )
}
