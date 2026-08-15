import { useEffect } from 'react'
import { useProjectStore } from '../stores/project'
import { useDownloadsStore } from '../stores/downloads'
import { usePrefsStore } from '../stores/prefs'
import { useUiStore } from '../stores/ui'
import Welcome from './Welcome'
import Workspace from './Workspace'
import StatusBar from '../components/StatusBar'
import PreferencesModal from '../components/PreferencesModal'
import AboutModal from '../components/AboutModal'
import iconUrl from '../assets/icon.png'
import type { IpcEventPayload } from '@shared/ipc'

/** Opens a novel folder (dialog when no dir given), snapshotting first. */
async function openNovelFromMenu(dir?: string): Promise<void> {
  const project = useProjectStore.getState()
  await project.snapshotActiveChapter()
  let target = dir
  if (!target) {
    const picked = await window.pandora.invoke('dialog:chooseDirectory', {
      title: 'Open a novel folder'
    })
    if (!picked.ok || !picked.data.dir) return
    target = picked.data.dir
  }
  const result = await window.pandora.invoke('project:openNovel', { dir: target })
  if (result.ok) useProjectStore.getState().setNovel(result.data)
  else useProjectStore.getState().setError(result.error.message)
}

export default function App(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)
  const activeFile = useProjectStore((s) => s.activeFile)
  const lastError = useProjectStore((s) => s.lastError)
  const setError = useProjectStore((s) => s.setError)
  const initDownloads = useDownloadsStore((s) => s.init)
  const initPrefs = usePrefsStore((s) => s.init)
  const theme = usePrefsStore((s) => s.theme)
  const showPrefs = useUiStore((s) => s.showPrefs)
  const showAbout = useUiStore((s) => s.showAbout)
  const setShowPrefs = useUiStore((s) => s.setShowPrefs)
  const setShowAbout = useUiStore((s) => s.setShowAbout)

  useEffect(() => {
    initDownloads()
    void initPrefs()
  }, [initDownloads, initPrefs])

  // Native menu commands act on the stores directly.
  useEffect(() => {
    return window.pandora.on('menu:action', (raw) => {
      const { action, dir, platform } = raw as IpcEventPayload<'menu:action'>
      const ui = useUiStore.getState()
      const project = useProjectStore.getState()
      switch (action) {
        case 'about':
          ui.setShowAbout(true)
          break
        case 'preferences':
          ui.setShowPrefs(true)
          break
        case 'new-novel':
          void project.snapshotActiveChapter().then(() => {
            ui.setWelcomeIntent('create')
            project.closeNovel()
          })
          break
        case 'open-novel':
          void openNovelFromMenu()
          break
        case 'open-recent':
          if (dir) void openNovelFromMenu(dir)
          break
        case 'close-novel':
          void project.snapshotActiveChapter().then(() => project.closeNovel())
          break
        case 'new-chapter':
          ui.signalNewChapter()
          break
        case 'save':
          void project.snapshotActiveChapter()
          break
        case 'copy-for':
          if (platform) ui.signalCopyFor(platform)
          break
      }
    })
  }, [])

  // Menu enablement (and the Open Recent list) follows what's open.
  useEffect(() => {
    void window.pandora.invoke('menu:setContext', {
      novelOpen: novel !== null,
      documentOpen: novel !== null && activeFile !== null,
      chapterOpen: novel !== null && (activeFile?.startsWith('chapters/') ?? false)
    })
  }, [novel, activeFile])

  // Apply the theme to <html data-theme>; 'system' follows the OS setting.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      document.documentElement.dataset['theme'] =
        theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])

  return (
    <div className="flex h-screen flex-col">
      <header className="titlebar-drag relative flex h-10 shrink-0 items-center justify-center border-b border-line">
        <span className="text-sm font-medium text-ink-muted">
          {novel ? novel.manifest.title : "Pandora's Gate"}
        </span>
        <div className="absolute right-3 flex items-center gap-1">
          <button
            onClick={() => setShowAbout(true)}
            title="About Pandora's Gate"
            className="rounded p-1 opacity-70 hover:bg-raised hover:opacity-100"
          >
            <img src={iconUrl} alt="" width={16} height={16} className="h-4 w-4 rounded-[22%]" />
          </button>
          <button
            onClick={() => setShowPrefs(true)}
            title="Preferences (⌘,)"
            className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink-muted"
          >
            ⚙
          </button>
        </div>
      </header>
      {novel ? <Workspace /> : <Welcome />}
      <StatusBar />
      {showPrefs && <PreferencesModal onClose={() => setShowPrefs(false)} />}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {lastError && (
        <div className="fixed bottom-4 right-4 flex items-center gap-3 rounded-lg border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-200 shadow-lg">
          <span className="max-w-md truncate">{lastError}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
