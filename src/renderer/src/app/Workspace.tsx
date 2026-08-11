import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useProposalsStore } from '../stores/proposals'
import { useDraftStore } from '../stores/draft'
import { usePrefsStore } from '../stores/prefs'
import { useChatStore } from '../stores/chat'
import ChapterSidebar from '../components/ChapterSidebar'
import ChatPanel from '../components/ChatPanel'
import HistoryPanel from '../components/HistoryPanel'
import ProposalsPanel from '../components/ProposalsPanel'
import AiPromptModal from '../components/AiPromptModal'
import MarkdownEditor from '../editor/MarkdownEditor'
import type { EditorView } from '@codemirror/view'
import { toggleInline, setHeading, toggleLinePrefix } from '../editor/commands'
import { parseFrontmatter } from '@shared/frontmatter'

const AUTO_METADATA_DELAY_MS = 15_000

function wordCount(content: string): { words: number; readMinutes: number } {
  const body = parseFrontmatter(content).body
  const words = body.split(/\s+/).filter((w) => /\w/.test(w)).length
  return { words, readMinutes: Math.max(1, Math.round(words / 230)) }
}

function StyleToolbar({ viewRef }: { viewRef: React.RefObject<EditorView | null> }): React.JSX.Element {
  const run = (fn: (view: EditorView) => void): void => {
    if (viewRef.current) fn(viewRef.current)
  }
  const btn =
    'rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-ink'
  return (
    <span className="flex items-center gap-0.5 border-r border-line pr-2">
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value
          if (v !== '') run((view) => setHeading(view, Number(v)))
          e.target.value = ''
        }}
        title="Paragraph style"
        className="rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink-muted outline-none"
      >
        <option value="" disabled>
          Style
        </option>
        <option value="0">Body text</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>
      <button onClick={() => run((v) => toggleInline(v, '**'))} title="Bold (⌘B style)" className={`${btn} font-bold`}>
        B
      </button>
      <button onClick={() => run((v) => toggleInline(v, '*'))} title="Italic" className={`${btn} italic`}>
        I
      </button>
      <button onClick={() => run((v) => toggleLinePrefix(v, '> '))} title="Quote" className={btn}>
        ❝
      </button>
      <button onClick={() => run((v) => toggleLinePrefix(v, '- '))} title="Bullet list" className={btn}>
        •
      </button>
    </span>
  )
}

export default function Workspace(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)!
  const activeFile = useProjectStore((s) => s.activeFile)
  const content = useProjectStore((s) => s.content)
  const dirty = useProjectStore((s) => s.dirty)
  const setContent = useProjectStore((s) => s.setContent)
  const saveActiveChapter = useProjectStore((s) => s.saveActiveChapter)
  const snapshotActiveChapter = useProjectStore((s) => s.snapshotActiveChapter)
  const applyNovelState = useProjectStore((s) => s.applyNovelState)
  const autoStoryBible = usePrefsStore((s) => s.autoStoryBible)
  const snapshotOnBlur = usePrefsStore((s) => s.snapshotOnBlur)
  const snapshotIntervalMinutes = usePrefsStore((s) => s.snapshotIntervalMinutes)
  const openChapter = useProjectStore((s) => s.openChapter)
  const setError = useProjectStore((s) => s.setError)
  const [showHistory, setShowHistory] = useState(false)
  const [showChat, setShowChat] = useState(true)
  const [showProposals, setShowProposals] = useState(false)
  const [modal, setModal] = useState<'draft' | 'outline-chapter' | null>(null)

  const proposalsRunning = useProposalsStore((s) => s.running)
  const runningStatus = useProposalsStore((s) => s.runningStatus)
  const lastRunStatus = useProposalsStore((s) => s.lastRunStatus)
  const review = useProposalsStore((s) => s.review)
  const updateReviewBuffer = useProposalsStore((s) => s.updateReviewBuffer)
  const applyReview = useProposalsStore((s) => s.applyReview)
  const rejectReview = useProposalsStore((s) => s.rejectReview)
  const exitReview = useProposalsStore((s) => s.exitReview)
  const editorViewRef = useRef<EditorView | null>(null)
  const pendingCount = useProposalsStore((s) => s.proposals.reduce((n, p) => n + p.items.length, 0))
  const runProposals = useProposalsStore((s) => s.runForActiveChapter)
  const generateOutline = useProposalsStore((s) => s.generateOutline)
  const refreshProposals = useProposalsStore((s) => s.refresh)

  const drafting = useDraftStore((s) => s.drafting)
  const draftError = useDraftStore((s) => s.error)
  const startDraft = useDraftStore((s) => s.start)
  const stopDraft = useDraftStore((s) => s.stop)
  const initDraft = useDraftStore((s) => s.init)

  const loadForNovel = useChatStore((s) => s.loadForNovel)
  const initProposals = useProposalsStore((s) => s.init)
  const initProject = useProjectStore((s) => s.init)

  useEffect(() => {
    initProject()
    initDraft()
    initProposals()
    void refreshProposals()
    // Restore the model last used with this novel (and warm it up).
    void loadForNovel(novel.dir)
  }, [initProject, initDraft, initProposals, refreshProposals, loadForNovel, novel.dir])

  // Crash-safety writes: quiet disk write a few seconds after typing pauses.
  // These do NOT create history entries — snapshots happen on ⌘S, window
  // blur, and chapter switches.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void saveActiveChapter(), drafting ? 800 : 5000)
    return () => clearTimeout(t)
  }, [content, dirty, drafting, saveActiveChapter])

  // Snapshot when the window loses focus.
  useEffect(() => {
    if (!snapshotOnBlur) return
    const onBlur = (): void => void snapshotActiveChapter()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [snapshotOnBlur, snapshotActiveChapter])

  // Optional interval snapshots: no-ops (no commit) when nothing changed.
  // Paused while the AI is drafting, which has its own commit bracketing.
  useEffect(() => {
    if (snapshotIntervalMinutes <= 0 || drafting || !activeFile) return
    const t = setInterval(
      () => void snapshotActiveChapter(),
      snapshotIntervalMinutes * 60_000
    )
    return () => clearInterval(t)
  }, [snapshotIntervalMinutes, drafting, activeFile, snapshotActiveChapter])

  // ⌘S fallback when focus is outside the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void snapshotActiveChapter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snapshotActiveChapter])

  // Auto metadata run: a while after writing settles on a chapter.
  useEffect(() => {
    if (!autoStoryBible || dirty || drafting || !activeFile?.startsWith('chapters/')) return
    const t = setTimeout(() => void runProposals({ silent: true }), AUTO_METADATA_DELAY_MS)
    return () => clearTimeout(t)
  }, [autoStoryBible, dirty, drafting, activeFile, runProposals])

  const activeChapter = novel.manifest.chapters.find((c) => c.file === activeFile)
  const activeLabel =
    activeChapter?.title ??
    activeFile
      ?.split('/')
      .at(-1)
      ?.replace(/\.(md|yaml)$/, '')
  const isChapter = activeFile?.startsWith('chapters/') ?? false

  const markRevised = async (): Promise<void> => {
    if (!activeFile) return
    const result = await window.pandora.invoke('chapter:setStatus', {
      novelDir: novel.dir,
      file: activeFile,
      status: 'revised'
    })
    if (result.ok) {
      applyNovelState(result.data)
      await openChapter(activeFile)
    } else {
      setError(result.error.message)
    }
  }

  const stats = isChapter ? wordCount(content) : null

  // Inline review mode replaces the whole editor column.
  if (review) {
    return (
      <div className="flex min-h-0 flex-1">
        <ChapterSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-900 bg-amber-950/40 px-4 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-amber-200">
                Reviewing suggestion for {review.path}
              </div>
              <div className="truncate text-xs text-amber-200/70">
                {review.sourceTitle} — {review.rationale}. Use the ✓/✕ on each change, then Apply.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void rejectReview()}
                className="rounded-lg border border-amber-800 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900"
              >
                Reject all
              </button>
              <button
                onClick={exitReview}
                className="rounded-lg border border-amber-800 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900"
              >
                Later
              </button>
              <button
                onClick={() => void applyReview()}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
              >
                Apply
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <MarkdownEditor
              docId={`review:${review.proposalId}:${review.path}`}
              value={review.buffer}
              onChange={updateReviewBuffer}
              mergeOriginal={review.original}
            />
          </div>
        </div>
        {showChat && <ChatPanel onClose={() => setShowChat(false)} />}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ChapterSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeFile ? (
          <>
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-4">
              <span className="flex min-w-0 items-center gap-3">
                <span className="truncate text-sm text-ink-muted">{activeLabel}</span>
                {stats && (
                  <span
                    className="shrink-0 text-xs tabular-nums text-ink-faint"
                    title={`~${stats.readMinutes} min read`}
                  >
                    {stats.words.toLocaleString()} words
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                {isChapter && !drafting && <StyleToolbar viewRef={editorViewRef} />}
                <span className="text-xs text-ink-faint">{dirty ? 'Editing…' : 'Saved'}</span>
                {isChapter && !drafting && (
                  <>
                    <button
                      onClick={() => setModal('draft')}
                      title="Have the AI write or continue this chapter — you review and revise"
                      className="rounded px-2 py-0.5 text-xs text-indigo-300 hover:bg-raised hover:text-indigo-200"
                    >
                      ✦ Draft
                    </button>
                    <button
                      onClick={() => setModal('outline-chapter')}
                      disabled={proposalsRunning}
                      title="Generate or refine this chapter's outline (goes to review)"
                      className="rounded px-2 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted disabled:opacity-60"
                    >
                      Outline
                    </button>
                    <button
                      onClick={() => void runProposals()}
                      disabled={proposalsRunning}
                      title="Ask the AI to update character profiles, summaries, and world docs from this chapter"
                      className="rounded px-2 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted disabled:opacity-60"
                    >
                      {proposalsRunning
                        ? (runningStatus ?? 'Working…')
                        : (lastRunStatus ?? 'Update Codex')}
                    </button>
                  </>
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
                      ? 'bg-raised text-ink'
                      : 'text-ink-faint hover:bg-raised hover:text-ink-muted'
                  }`}
                >
                  History
                </button>
                <button
                  onClick={() => setShowChat((v) => !v)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    showChat
                      ? 'bg-raised text-ink'
                      : 'text-ink-faint hover:bg-raised hover:text-ink-muted'
                  }`}
                >
                  Chat
                </button>
              </span>
            </div>

            {drafting && (
              <div className="flex shrink-0 items-center justify-between border-b border-indigo-900 bg-indigo-950/50 px-4 py-1.5">
                <span className="flex items-center gap-2 text-xs text-indigo-200">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                  AI is drafting this chapter…
                </span>
                <button
                  onClick={() => void stopDraft()}
                  className="rounded border border-indigo-700 px-2 py-0.5 text-xs text-indigo-200 hover:bg-indigo-900"
                >
                  Stop
                </button>
              </div>
            )}
            {!drafting && activeChapter?.status === 'ai-draft' && (
              <div className="flex shrink-0 items-center justify-between border-b border-amber-900 bg-amber-950/40 px-4 py-1.5">
                <span className="text-xs text-amber-200">
                  This chapter is an AI draft — read it closely and make it yours.
                </span>
                <button
                  onClick={() => void markRevised()}
                  className="rounded border border-amber-800 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-900"
                >
                  Mark as revised
                </button>
              </div>
            )}
            {draftError && (
              <div className="shrink-0 border-b border-red-900 bg-red-950/50 px-4 py-1.5 text-xs text-red-300">
                {draftError}
              </div>
            )}

            <div className={`min-h-0 flex-1 overflow-hidden ${drafting ? 'pointer-events-none opacity-95' : ''}`}>
              <MarkdownEditor
                docId={activeFile}
                value={content}
                onChange={setContent}
                forceSync={drafting}
                onSave={() => void snapshotActiveChapter()}
                onViewReady={(view) => {
                  editorViewRef.current = view
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-ink-faint">
            {novel.manifest.chapters.length === 0
              ? 'Create your first chapter to start writing.'
              : 'Select a chapter to start writing.'}
          </div>
        )}
      </div>
      {showHistory && activeFile && <HistoryPanel onClose={() => setShowHistory(false)} />}
      {showChat && <ChatPanel onClose={() => setShowChat(false)} />}
      {showProposals && <ProposalsPanel onClose={() => setShowProposals(false)} />}

      {modal === 'draft' && (
        <AiPromptModal
          title={`Draft “${activeLabel}” with AI`}
          description="The AI writes into the chapter using your outline, story bible, and what's already on the page. A snapshot is taken first, so the whole draft is one undoable step."
          placeholder="Optional direction — tone, beats to hit, POV, pacing… (⌘↵ to start)"
          cta="Start drafting"
          onSubmit={(guidance) => void startDraft(guidance)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'outline-chapter' && (
        <AiPromptModal
          title={`Outline “${activeLabel}”`}
          description="Generates a beat-by-beat outline for this chapter from the novel outline and story so far. You review it before it's saved."
          placeholder="Optional direction — what should this chapter accomplish? (⌘↵ to generate)"
          cta="Generate outline"
          onSubmit={(guidance) => void generateOutline('chapter', guidance)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
