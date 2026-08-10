import { useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useProposalsStore } from '../stores/proposals'
import ChapterSidebar from '../components/ChapterSidebar'
import ChatPanel from '../components/ChatPanel'
import HistoryPanel from '../components/HistoryPanel'
import ProposalsPanel from '../components/ProposalsPanel'
import MarkdownEditor from '../editor/MarkdownEditor'

const AUTO_METADATA_DELAY_MS = 15_000

export default function Workspace(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const content = useProjectStore((s) => s.content)
  const dirty = useProjectStore((s) => s.dirty)
  const setContent = useProjectStore((s) => s.setContent)
  const saveActiveChapter = useProjectStore((s) => s.saveActiveChapter)
  const [showHistory, setShowHistory] = useState(false)
  const [showChat, setShowChat] = useState(true)
  const [showProposals, setShowProposals] = useState(false)

  const proposalsRunning = useProposalsStore((s) => s.running)
  const lastRunStatus = useProposalsStore((s) => s.lastRunStatus)
  const pendingCount = useProposalsStore((s) => s.proposals.reduce((n, p) => n + p.items.length, 0))
  const runProposals = useProposalsStore((s) => s.runForActiveChapter)
  const refreshProposals = useProposalsStore((s) => s.refresh)

  useEffect(() => {
    void refreshProposals()
  }, [refreshProposals])

  // Autosave: 1.5s after the last keystroke.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void saveActiveChapter(), 1500)
    return () => clearTimeout(t)
  }, [content, dirty, saveActiveChapter])

  // Auto metadata run: a while after writing settles on a chapter.
  useEffect(() => {
    if (dirty || !activeFile?.startsWith('chapters/')) return
    const t = setTimeout(() => void runProposals({ silent: true }), AUTO_METADATA_DELAY_MS)
    return () => clearTimeout(t)
  }, [dirty, activeFile, runProposals])

  const activeChapter = novel.manifest.chapters.find((c) => c.file === activeFile)
  const activeLabel =
    activeChapter?.title ??
    activeFile
      ?.split('/')
      .at(-1)
      ?.replace(/\.(md|yaml)$/, '')

  return (
    <div className="flex min-h-0 flex-1">
      <ChapterSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeFile ? (
          <>
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
              <span className="truncate text-sm text-zinc-400">{activeLabel}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-zinc-600">{dirty ? 'Editing…' : 'Saved'}</span>
                {activeFile?.startsWith('chapters/') && (
                  <button
                    onClick={() => void runProposals()}
                    disabled={proposalsRunning}
                    title="Ask the AI to update character profiles, summaries, and world docs from this chapter"
                    className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-60"
                  >
                    {proposalsRunning ? 'Updating story bible…' : (lastRunStatus ?? 'Update story bible')}
                  </button>
                )}
                {pendingCount > 0 && (
                  <button
                    onClick={() => setShowProposals(true)}
                    className="rounded-full bg-amber-900/70 px-2.5 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-800"
                  >
                    {pendingCount} suggestion{pendingCount === 1 ? '' : 's'}
                  </button>
                )}
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    showHistory
                      ? 'bg-zinc-800 text-zinc-200'
                      : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                  }`}
                >
                  History
                </button>
                <button
                  onClick={() => setShowChat((v) => !v)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    showChat
                      ? 'bg-zinc-800 text-zinc-200'
                      : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                  }`}
                >
                  Chat
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <MarkdownEditor docId={activeFile} value={content} onChange={setContent} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-600">
            {novel.manifest.chapters.length === 0
              ? 'Create your first chapter to start writing.'
              : 'Select a chapter to start writing.'}
          </div>
        )}
      </div>
      {showHistory && activeFile && <HistoryPanel onClose={() => setShowHistory(false)} />}
      {showChat && <ChatPanel onClose={() => setShowChat(false)} />}
      {showProposals && <ProposalsPanel onClose={() => setShowProposals(false)} />}
    </div>
  )
}
