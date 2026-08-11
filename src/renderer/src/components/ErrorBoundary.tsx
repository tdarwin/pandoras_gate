import React from 'react'

/** Reports a renderer-side error to the main-process log file. */
export function reportRendererError(source: string, message: string, stack?: string): void {
  try {
    void window.pandora.invoke('app:rendererError', {
      message,
      ...(stack ? { stack } : {}),
      source
    })
  } catch {
    // Logging must never cascade.
  }
}

/** Global hooks: uncaught errors and rejections land in the log file. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    reportRendererError('window.onerror', e.message, e.error instanceof Error ? e.error.stack : undefined)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    reportRendererError(
      'unhandledrejection',
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined
    )
  })
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * A crashed component tree must never leave a silent blank window: show what
 * broke, log it, and offer a reload.
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportRendererError('react', error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`)
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-surface p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">Something broke in the interface</h1>
        <p className="max-w-md text-sm leading-relaxed text-ink-faint">
          Your writing is safe on disk — this was a display error, and it has been written to the
          log file (Preferences → Observability → Open local log folder).
        </p>
        <pre className="max-h-40 max-w-xl overflow-auto rounded-lg bg-panel p-3 text-left font-mono text-xs text-red-300">
          {this.state.error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Reload the app
        </button>
      </div>
    )
  }
}
