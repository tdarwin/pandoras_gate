import { create } from 'zustand'
import type { IpcEventPayload } from '@shared/ipc'

/**
 * Global download tracker: one subscription to model:downloadProgress feeds
 * both the Models manager and the bottom status bar, with smoothed transfer
 * speed and ETA.
 */

export interface DownloadEntry {
  key: string
  label: string
  downloadedBytes: number
  totalBytes: number
  /** Exponentially smoothed bytes/second; 0 until two samples arrive. */
  speedBps: number
  /** Seconds remaining at current speed; null until speed is known. */
  etaSeconds: number | null
  lastSampleAt: number
  error: string | null
}

/** EMA-smoothed speed update — pure, unit tested. */
export function nextSpeed(
  prevSpeedBps: number,
  bytesDelta: number,
  msDelta: number,
  smoothing = 0.3
): number {
  if (msDelta <= 0) return prevSpeedBps
  const instant = (bytesDelta / msDelta) * 1000
  if (instant < 0) return prevSpeedBps
  if (prevSpeedBps === 0) return instant
  return smoothing * instant + (1 - smoothing) * prevSpeedBps
}

export function etaSeconds(entry: {
  downloadedBytes: number
  totalBytes: number
  speedBps: number
}): number | null {
  if (entry.speedBps <= 0 || entry.totalBytes <= 0) return null
  const remaining = entry.totalBytes - entry.downloadedBytes
  if (remaining <= 0) return 0
  return Math.round(remaining / entry.speedBps)
}

export function formatSpeed(bps: number): string {
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${Math.round(bps)} B/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return '…'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

interface DownloadsStore {
  downloads: Record<string, DownloadEntry>
  init: () => void
  /** Called by UI after it has shown a terminal error. */
  dismiss: (key: string) => void
}

let initialized = false

export const useDownloadsStore = create<DownloadsStore>((set) => ({
  downloads: {},

  init: () => {
    if (initialized) return
    initialized = true
    window.pandora.on('model:downloadProgress', (raw) => {
      const p = raw as IpcEventPayload<'model:downloadProgress'>
      set((s) => {
        const downloads = { ...s.downloads }
        if (p.done || p.error === 'cancelled') {
          delete downloads[p.modelId]
          return { downloads }
        }
        if (p.error) {
          const prev = downloads[p.modelId]
          if (prev) downloads[p.modelId] = { ...prev, error: p.error }
          return { downloads }
        }
        const now = Date.now()
        const prev = downloads[p.modelId]
        const speedBps = prev
          ? nextSpeed(prev.speedBps, p.downloadedBytes - prev.downloadedBytes, now - prev.lastSampleAt)
          : 0
        const entry: DownloadEntry = {
          key: p.modelId,
          label: p.label,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          speedBps,
          etaSeconds: etaSeconds({
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
            speedBps
          }),
          lastSampleAt: now,
          error: null
        }
        downloads[p.modelId] = entry
        return { downloads }
      })
    })
  },

  dismiss: (key) =>
    set((s) => {
      const downloads = { ...s.downloads }
      delete downloads[key]
      return { downloads }
    })
}))
