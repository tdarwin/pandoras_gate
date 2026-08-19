import { BrowserWindow } from 'electron'
import { logWarn } from './log'

/**
 * Save-before-close handshake. The renderer holds the only copy of unsaved
 * typing (the zustand buffer), so quitting or closing the window must ask it
 * to flush and wait for the ack — bounded, because a hung renderer must never
 * make the app unquittable.
 */

const FLUSH_TIMEOUT_MS = 5000

const pending = new Map<number, () => void>()

export function requestRendererFlush(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve()
  const id = win.webContents.id
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      logWarn('app', 'renderer flush timed out — proceeding with whatever reached disk')
      resolve()
    }, FLUSH_TIMEOUT_MS)
    pending.set(id, () => {
      clearTimeout(timer)
      pending.delete(id)
      resolve()
    })
    win.webContents.send('app:flushRequest', {})
  })
}

export async function requestAllRendererFlushes(): Promise<void> {
  await Promise.allSettled(BrowserWindow.getAllWindows().map((w) => requestRendererFlush(w)))
}

/** Called by the app:flushed IPC handler with the acking webContents id. */
export function rendererFlushed(webContentsId: number): void {
  pending.get(webContentsId)?.()
}
