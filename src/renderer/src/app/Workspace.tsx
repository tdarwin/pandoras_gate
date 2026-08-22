import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useProposalsStore, setSuggestionHandle } from '../stores/proposals'
import { useDraftStore } from '../stores/draft'
import { usePrefsStore } from '../stores/prefs'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import ChapterSidebar from '../components/ChapterSidebar'
import ChatPanel from '../components/ChatPanel'
import HistoryPanel from '../components/HistoryPanel'
import SuggestionStrip from '../components/SuggestionStrip'
import AiPromptModal from '../components/AiPromptModal'
import ReviewModal from '../components/ReviewModal'
import ChapterDetails from '../components/ChapterDetails'
import MarkdownEditor, { type EditorHandle, type ImageImporter } from '../editor/MarkdownEditor'
import EditorToolbar from '../editor/EditorToolbar'
import PlainEditor from '../editor/PlainEditor'
import { parseFrontmatter, serializeFrontmatter } from '@shared/frontmatter'

const AUTO_METADATA_DELAY_MS = 15_000

function wordCount(body: string): { words: number; readMinutes: number } {
  const words = body.split(/\s+/).filter((w) => /\w/.test(w)).length
  return { words, readMinutes: Math.max(1, Math.round(words / 230)) }
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
  const autoCodex = usePrefsStore((s) => s.autoCodex)
  const snapshotOnBlur = usePrefsStore((s) => s.snapshotOnBlur)
  const snapshotIntervalMinutes = usePrefsStore((s) => s.snapshotIntervalMinutes)
  const openChapter = useProjectStore((s) => s.openChapter)
  const reloadActiveChapter = useProjectStore((s) => s.reloadActiveChapter)
  const setError = useProjectStore((s) => s.setError)
  const [showHistory, setShowHistory] = useState(false)
  const [showChat, setShowChat] = useState(true)
  const [modal, setModal] = useState<'draft' | 'outline-chapter' | 'review' | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)

  const proposalsRunning = useProposalsStore((s) => s.running)
  const runningStatus = useProposalsStore((s) => s.runningStatus)

  // Toolbar/paste/drop image imports: bytes land in <novel>/assets/ via main,
  // the editor gets back the relative path for the markdown link.
  const importImage = useMemo<ImageImporter>(() => {
    const finish = (result: Awaited<ReturnType<typeof window.pandora.invoke<'assets:import'>>>):
      | { rel: string }
      | null => {
      if (!result.ok) {
        useProjectStore.getState().setError(result.error.message)
        return null
      }
      return result.data.rel ? { rel: result.data.rel } : null
    }
    return {
      fromDialog: async () =>
        finish(
          await window.pandora.invoke('assets:import', {
            novelDir: novel.dir,
            source: { kind: 'dialog' }
          })
        ),
      fromFile: async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        return finish(
          await window.pandora.invoke('assets:import', {
            novelDir: novel.dir,
            source: { kind: 'bytes', base64: btoa(binary), name: file.name }
          })
        )
      }
    }
  }, [novel.dir])
  const lastRunStatus = useProposalsStore((s) => s.lastRunStatus)
  const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null)
  const activeSuggestions = useProposalsStore((s) => s.active)
  const loadSuggestionsFor = useProposalsStore((s) => s.loadFor)
  const setSuggestionsShown = useProposalsStore((s) => s.setShown)
  const persistDecisions = useProposalsStore((s) => s.persistDecisions)
  const runProposals = useProposalsStore((s) => s.runForActiveChapter)
  const generateOutline = useProposalsStore((s) => s.generateOutline)
  const refreshProposals = useProposalsStore((s) => s.refresh)

  const drafting = useDraftStore((s) => s.drafting)
  const draftFile = useDraftStore((s) => s.draftFile)
  const draftStatus = useDraftStore((s) => s.status)
  const draftError = useDraftStore((s) => s.error)
  const startDraft = useDraftStore((s) => s.start)
  const stopDraft = useDraftStore((s) => s.stop)
  const initDraft = useDraftStore((s) => s.init)

  const loadForNovel = useChatStore((s) => s.loadForNovel)
  const chatStreaming = useChatStore((s) => s.streaming)

  // Whether the DRAFT's chapter is the one on screen — most editor chrome
  // only locks for that case; drafting elsewhere leaves this chapter free.
  const draftingHere = drafting && draftFile === activeFile
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
  // blur, and chapter switches. (While the AI drafts, the draft store
  // persists its own text — this buffer never goes dirty.)
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void saveActiveChapter(), 5000)
    return () => clearTimeout(t)
  }, [content, dirty, saveActiveChapter])

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
    if (snapshotIntervalMinutes <= 0 || draftingHere || !activeFile) return
    const t = setInterval(
      () => void snapshotActiveChapter(),
      snapshotIntervalMinutes * 60_000
    )
    return () => clearInterval(t)
  }, [snapshotIntervalMinutes, draftingHere, activeFile, snapshotActiveChapter])

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

  // Auto metadata run: a while after writing settles on a chapter. Waits out
  // a streaming chat too — its reply may itself defer a Codex run.
  useEffect(() => {
    if (!autoCodex || dirty || drafting || chatStreaming || !activeFile?.startsWith('chapters/'))
      return
    const t = setTimeout(() => void runProposals({ silent: true }), AUTO_METADATA_DELAY_MS)
    return () => clearTimeout(t)
  }, [autoCodex, dirty, drafting, chatStreaming, activeFile, runProposals])

  const activeChapter = novel.manifest.chapters.find((c) => c.file === activeFile)
  const draftingChapterTitle = drafting
    ? (novel.manifest.chapters.find((c) => c.file === draftFile)?.title ?? draftFile)
    : null
  const activeLabel =
    activeChapter?.title ??
    activeFile
      ?.split('/')
      .at(-1)
      ?.replace(/\.(md|yaml)$/, '')
  const isChapter = activeFile?.startsWith('chapters/') ?? false

  const copyFor = async (platform: 'royalroad' | 'patreon'): Promise<void> => {
    if (!activeFile) return
    await saveActiveChapter()
    const result = await window.pandora.invoke('publish:copy', {
      novelDir: novel.dir,
      file: activeFile,
      platform
    })
    if (result.ok) {
      const label = platform === 'royalroad' ? 'RoyalRoad' : 'Patreon'
      const notes = [
        ...(result.data.warning ? [result.data.warning] : []),
        ...(result.data.dropped?.length
          ? [`${label} paste can't carry: ${result.data.dropped.join(', ')}`]
          : [])
      ]
      setCopyStatus(
        `Copied for ${label} — paste into a new post${notes.length ? ` (${notes.join('; ')})` : ''}`
      )
    } else {
      setCopyStatus(result.error.message)
    }
    window.setTimeout(() => setCopyStatus(null), 8000)
  }

  // File > Copy Chapter For — only requests made while mounted are honored,
  // so a remount (novel switch) never replays a stale copy.
  const copyForRequest = useUiStore((s) => s.copyForRequest)
  const consumedCopySeq = useRef(copyForRequest?.seq ?? 0)
  useEffect(() => {
    if (!copyForRequest || copyForRequest.seq === consumedCopySeq.current) return
    consumedCopySeq.current = copyForRequest.seq
    void copyFor(copyForRequest.platform)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signal consumer
  }, [copyForRequest])

  const markRevised = async (): Promise<void> => {
    if (!activeFile) return
    // Main rewrites the file from DISK — unsaved typing must reach it first,
    // or the reload below would discard it.
    await snapshotActiveChapter()
    const result = await window.pandora.invoke('chapter:setStatus', {
      novelDir: novel.dir,
      file: activeFile,
      status: 'revised'
    })
    if (result.ok) {
      applyNovelState(result.data)
      // Reload rather than openChapter: the snapshot-first path would commit
      // the buffer's OLD frontmatter back over the status main just wrote.
      await reloadActiveChapter()
    } else {
      setError(result.error.message)
    }
  }

  const doc = useMemo(() => parseFrontmatter(content), [content])
  // The editor and details callbacks re-serialize the whole file around the
  // part they changed, so they must read the CURRENT frontmatter, not whatever
  // was parsed when the callback was created. Accepting a suggestion can write
  // frontmatter the buffer never had, and a stale closure then wrote the
  // document straight back without it.
  const docRef = useRef(doc)
  docRef.current = doc

  // Suggestions for the document that is actually open. Anything pending for
  // another document shows as a dot in the navigation, not here.
  const suggestionsHere =
    activeSuggestions && activeSuggestions.path === activeFile ? activeSuggestions : null

  const suggestionSpec = useMemo(() => {
    if (!suggestionsHere || !suggestionsHere.shown) return null
    return {
      original: parseFrontmatter(suggestionsHere.current).body,
      chain: suggestionsHere.chain.map((link) => ({
        proposalId: link.proposalId,
        content: parseFrontmatter(link.content).body
      }))
    }
  }, [suggestionsHere])

  const suggestionTitles = useMemo(() => {
    const out: Record<string, string> = {}
    for (const link of suggestionsHere?.chain ?? []) {
      out[link.proposalId] = `${link.sourceTitle} — ${link.rationale}`
    }
    return out
  }, [suggestionsHere])

  const showSuggestions = useCallback(() => {
    setSuggestionsShown(true)
  }, [setSuggestionsShown])

  // What the READER sees is chunks, not proposals — one Codex run routinely
  // suggests half a dozen changes to one document.
  const [chunkCount, setChunkCount] = useState(0)
  // A reject leaves the savable text unchanged, so the buffer never goes dirty
  // and autosave never fires — the decision would sit in memory until the next
  // blur or quit. Persist it the moment the count drops.
  const lastChunkCountRef = useRef(0)
  const onChunkCountChange = useCallback(
    (n: number) => {
      setChunkCount(n)
      const fell = n < lastChunkCountRef.current
      lastChunkCountRef.current = n
      if (fell) void persistDecisions()
    },
    [persistDecisions]
  )

  // Fold the suggestions for whichever document is open.
  useEffect(() => {
    // A new document starts from no chunks; without this the drop from the
    // previous one's count reads as a decision.
    lastChunkCountRef.current = 0
    void loadSuggestionsFor(activeFile)
  }, [activeFile, loadSuggestionsFor])

  // Put them on the editor as soon as it is safe to. A clean buffer means the
  // author is not mid-sentence, so nothing moves under their cursor; while
  // they are typing the strip offers "Show" instead, because AI text appearing
  // under a moving caret is the one thing this feature must never do.
  useEffect(() => {
    if (!suggestionsHere || suggestionsHere.shown || dirty || drafting) return
    setSuggestionsShown(true)
  }, [suggestionsHere, dirty, drafting, setSuggestionsShown])

  // The overlay attaches to the LIVE editor rather than remounting it —
  // recreating the editor steals focus and resets the caret.
  const shownKey = suggestionSpec ? suggestionsHere?.chain.map((l) => l.proposalId).join() : null
  // The baseline counts as much as the chain does: re-anchoring after someone
  // else wrote the file changes what the same suggestions MEAN, and an overlay
  // left on the old baseline would have the next save quietly undo the
  // external edit.
  const baseline = suggestionSpec ? suggestionsHere?.current : null
  useEffect(() => {
    if (!editorHandle) return
    if (suggestionSpec) editorHandle.attachSuggestions(suggestionSpec)
    else if (editorHandle.suggestionCount() > 0) editorHandle.detachSuggestions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorHandle, shownKey, baseline, activeFile])

  // The store asks the editor what each proposal still proposes, at save time.
  useEffect(() => {
    setSuggestionHandle(editorHandle)
    return () => setSuggestionHandle(null)
  }, [editorHandle])

  const isYamlFile = /\.ya?ml$/.test(activeFile ?? '')
  const stats = isChapter ? wordCount(doc.body) : null

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
                <span className="max-w-72 truncate text-xs text-ink-faint" title={copyStatus ?? undefined}>
                  {copyStatus ?? (dirty ? 'Editing…' : 'Saved')}
                </span>
                {isChapter && !draftingHere && (
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
                      onClick={() => setModal('review')}
                      disabled={proposalsRunning}
                      title="Ask for a proofread, copy edit, developmental edit, or fact check"
                      className="rounded px-2 py-0.5 text-xs text-ink-faint hover:bg-raised hover:text-ink-muted disabled:opacity-60"
                    >
                      Review
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
                  {draftStatus ??
                    (draftingHere
                      ? 'AI is drafting this chapter…'
                      : `AI is drafting “${draftingChapterTitle}”…`)}
                </span>
                <span className="flex items-center gap-2">
                  {!draftingHere && draftFile && (
                    <button
                      onClick={() => void openChapter(draftFile)}
                      className="rounded border border-indigo-700 px-2 py-0.5 text-xs text-indigo-200 hover:bg-indigo-900"
                    >
                      Show
                    </button>
                  )}
                  <button
                    onClick={() => void stopDraft()}
                    className="rounded border border-indigo-700 px-2 py-0.5 text-xs text-indigo-200 hover:bg-indigo-900"
                  >
                    Stop
                  </button>
                </span>
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

            <div
              className={`flex min-h-0 flex-1 flex-col overflow-hidden ${draftingHere ? 'pointer-events-none opacity-95' : ''}`}
            >
              {isYamlFile ? (
                <PlainEditor
                  value={content}
                  onChange={setContent}
                  onSave={() => void snapshotActiveChapter()}
                />
              ) : (
                <>
                  {suggestionsHere && (
                    <SuggestionStrip
                      active={suggestionsHere}
                      chunkCount={chunkCount}
                      currentRaw={content}
                      onShow={showSuggestions}
                    />
                  )}
                  <ChapterDetails
                    key={activeFile}
                    data={doc.data}
                    rawFrontmatter={doc.rawFrontmatter}
                    lockedKeys={isChapter ? ['title', 'status'] : []}
                    onChange={(data) =>
                      setContent(
                        serializeFrontmatter({
                          data,
                          body: docRef.current.body,
                          rawFrontmatter: docRef.current.rawFrontmatter
                        })
                      )
                    }
                    onRawChange={(raw) =>
                      setContent(
                        serializeFrontmatter({
                          data: {},
                          body: doc.body,
                          // An emptied block drops out entirely rather than
                          // round-tripping as an unreadable pair of fences.
                          rawFrontmatter: raw.trim() ? raw : null
                        })
                      )
                    }
                  />
                  <EditorToolbar handle={draftingHere ? null : editorHandle} />
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <MarkdownEditor
                      docId={activeFile}
                      value={doc.body}
                      suggestion={suggestionSpec}
                      suggestionTitles={suggestionTitles}
                      onSuggestionsChange={onChunkCountChange}
                      onChange={(body) =>
                        setContent(
                          serializeFrontmatter({
                            data: docRef.current.data,
                            body,
                            rawFrontmatter: docRef.current.rawFrontmatter
                          })
                        )
                      }
                      forceSync={draftingHere}
                      editable={!draftingHere}
                      onSave={() => void snapshotActiveChapter()}
                      onReady={setEditorHandle}
                      importImage={importImage}
                    />
                  </div>
                </>
              )}
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

      {modal === 'draft' && (
        <AiPromptModal
          title={`Draft “${activeLabel}” with AI`}
          description="The AI writes into the chapter using your outline, Codex, and what's already on the page. A snapshot is taken first, so the whole draft is one undoable step."
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
      {modal === 'review' && (
        <ReviewModal
          chapterTitle={isChapter ? (activeLabel ?? null) : null}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
