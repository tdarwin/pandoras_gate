import { useEffect, useState } from 'react'
import { useProjectStore } from '../stores/project'
import { useDownloadsStore } from '../stores/downloads'
import { usePrefsStore } from '../stores/prefs'
import Welcome from './Welcome'
import Workspace from './Workspace'
import StatusBar from '../components/StatusBar'
import PreferencesModal from '../components/PreferencesModal'

export default function App(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)
  const lastError = useProjectStore((s) => s.lastError)
  const setError = useProjectStore((s) => s.setError)
  const initDownloads = useDownloadsStore((s) => s.init)
  const initPrefs = usePrefsStore((s) => s.init)
  const [showPrefs, setShowPrefs] = useState(false)

  useEffect(() => {
    initDownloads()
    void initPrefs()
  }, [initDownloads, initPrefs])

  return (
    <div className="flex h-screen flex-col">
      <header className="titlebar-drag relative flex h-10 shrink-0 items-center justify-center border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-400">
          {novel ? novel.manifest.title : "Pandora's Box"}
        </span>
        <button
          onClick={() => setShowPrefs(true)}
          title="Preferences"
          className="absolute right-3 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          ⚙
        </button>
      </header>
      {novel ? <Workspace /> : <Welcome />}
      <StatusBar />
      {showPrefs && <PreferencesModal onClose={() => setShowPrefs(false)} />}
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
