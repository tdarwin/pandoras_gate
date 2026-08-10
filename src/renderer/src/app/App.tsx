import { useProjectStore } from '../stores/project'
import Welcome from './Welcome'
import Workspace from './Workspace'

export default function App(): React.JSX.Element {
  const novel = useProjectStore((s) => s.novel)
  const lastError = useProjectStore((s) => s.lastError)
  const setError = useProjectStore((s) => s.setError)

  return (
    <div className="flex h-screen flex-col">
      <header className="titlebar-drag flex h-10 shrink-0 items-center justify-center border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-400">
          {novel ? novel.manifest.title : "Pandora's Box"}
        </span>
      </header>
      {novel ? <Workspace /> : <Welcome />}
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
