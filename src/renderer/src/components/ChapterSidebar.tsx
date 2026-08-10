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
  const reorderChapters = useProjectStore((s) => s.reorderChapters)
  const archiveChapter = useProjectStore((s) => s.archiveChapter)
  const deleteChapter = useProjectStore((s) => s.deleteChapter)
  const closeNovel = useProjectStore((s) => s.closeNovel)

  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const submitNew = async (): Promise<void> => {
    if (newTitle.trim()) await createChapter(newTitle.trim())
    setNewTitle('')
    setAdding(false)
  }

  const submitRename = async (file: string): Promise<void> => {
    if (renameValue.trim()) await renameChapter(file, renameValue.trim())
    setRenaming(null)
  }

  const completeDrop = async (): Promise<void> => {
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    const files = novel.manifest.chapters.map((c) => c.file)
    const [moved] = files.splice(dragIndex, 1)
    // Removing an earlier item shifts the target left by one.
    const insertAt = dragIndex < dropIndex ? dropIndex - 1 : dropIndex
    files.splice(insertAt, 0, moved!)
    setDragIndex(null)
    setDropIndex(null)
    await reorderChapters(files)
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

          <ul
            className="mt-1 flex-1 overflow-y-auto px-2 pb-3"
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropIndex(null)
            }}
          >
            {novel.manifest.chapters.map((ch, i) => (
              <li key={ch.file} className="group relative">
                {dropIndex === i && dragIndex !== null && (
                  <div className="absolute -top-0.5 left-1 right-1 h-0.5 rounded bg-indigo-500" />
                )}
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
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i)
                      setMenuFor(null)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      // Above midpoint → insert before this row; below → after.
                      const rect = e.currentTarget.getBoundingClientRect()
                      const before = e.clientY < rect.top + rect.height / 2
                      setDropIndex(before ? i : i + 1)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      void completeDrop()
                    }}
                    onDragEnd={() => {
                      setDragIndex(null)
                      setDropIndex(null)
                    }}
                    className={`flex cursor-grab items-center rounded px-2 py-1.5 text-sm active:cursor-grabbing ${
                      activeFile === ch.file
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                    } ${dragIndex === i ? 'opacity-40' : ''}`}
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuFor(menuFor === ch.file ? null : ch.file)
                        setConfirmDelete(null)
                      }}
                      title="Chapter actions"
                      className="hidden shrink-0 rounded px-1 text-zinc-500 hover:text-zinc-200 group-hover:block"
                    >
                      ⋯
                    </button>
                  </div>
                )}

                {menuFor === ch.file && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => {
                        setMenuFor(null)
                        setConfirmDelete(null)
                      }}
                    />
                  <div className="absolute right-1 top-8 z-20 w-44 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                    <button
                      onClick={() => {
                        setMenuFor(null)
                        setRenaming(ch.file)
                        setRenameValue(ch.title)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => {
                        setMenuFor(null)
                        void archiveChapter(ch.file)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      Archive
                      <span className="block text-[10px] text-zinc-600">
                        Moves the file to archive/, keeps history
                      </span>
                    </button>
                    {confirmDelete === ch.file ? (
                      <button
                        onClick={() => {
                          setMenuFor(null)
                          setConfirmDelete(null)
                          void deleteChapter(ch.file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs font-medium text-red-400 hover:bg-red-950/50"
                      >
                        Really delete “{ch.title}”?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(ch.file)}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-400/80 hover:bg-zinc-800"
                      >
                        Delete…
                      </button>
                    )}
                  </div>
                  </>
                )}
              </li>
            ))}
            {dropIndex === novel.manifest.chapters.length && dragIndex !== null && (
              <li className="relative">
                <div className="absolute -top-0.5 left-1 right-1 h-0.5 rounded bg-indigo-500" />
              </li>
            )}
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
