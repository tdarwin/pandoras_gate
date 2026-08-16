import { app, type WebContents } from 'electron'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import type { ModelDownloader } from 'node-llama-cpp'
import { catalogSource } from './catalog-source'
import type { CatalogModel, HostedPick, CatalogEntryStatus } from '../../shared/llm/catalog'
import { memoryRequirementsGB, memoryVerdict } from '../../shared/llm/memory'
import { detectHardware } from './hardware'
import { importGguf, listLocalModels, removeLocalModel } from './local'

function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

interface ActiveDownload {
  downloader: ModelDownloader
  downloadedBytes: number
  totalBytes: number
}

const activeDownloads = new Map<string, ActiveDownload>()

/** Looks a catalog model up in whichever catalog is currently live. */
async function catalogModel(modelId: string): Promise<CatalogModel> {
  const { models } = await catalogSource.load()
  const entry = models.find((m) => m.id === modelId)
  if (!entry) throw new Error(`Unknown catalog model: ${modelId}`)
  return entry
}

export async function catalogStatus(): Promise<{
  hardware: ReturnType<typeof detectHardware>
  entries: CatalogEntryStatus[]
  hosted: HostedPick[]
}> {
  const hw = detectHardware()
  const [catalog, installed] = await Promise.all([catalogSource.load(), listLocalModels()])
  const totalBytes = hw.totalMemoryGB * 1024 ** 3
  const entries = catalog.models.map((m) => {
    const installedEntry = installed.find((i) => i.path === join(modelsDir(), m.filename))
    const active = activeDownloads.get(m.id)
    // Fit is decided by whether the machine can hold the weights *and* a
    // workable context, not by weights alone — a model that loads but leaves
    // room for 2k of context is no use for writing a novel.
    const verdict = memoryVerdict(m.memory, totalBytes)
    const { minimumGB, comfortableGB } = memoryRequirementsGB(m.memory)
    return {
      ...m,
      fit: verdict.fit,
      usableContext: verdict.usableContext,
      cramped: verdict.cramped,
      minimumGB,
      comfortableGB,
      installedPath: installedEntry?.path ?? null,
      downloading: active !== undefined,
      downloadedBytes: active?.downloadedBytes ?? 0
    }
  })
  return { hardware: hw, entries, hosted: catalog.hosted }
}

interface DownloadSpec {
  /** Progress-event key; catalog id or `hf:<repo>/<file>`. */
  key: string
  /** Human-readable name for progress UI (status bar). */
  label: string
  hfUri: string
  fileName: string
  dirPath: string
  expectedBytes: number
}

/**
 * Starts (or resumes) a GGUF download. Progress is pushed to the renderer on
 * `model:downloadProgress`; on completion the model is registered and a final
 * event with `done: true` is sent. Shared by the curated catalog and the
 * Hugging Face browser.
 */
async function downloadGguf(sender: WebContents, spec: DownloadSpec): Promise<void> {
  if (activeDownloads.has(spec.key)) return

  await mkdir(spec.dirPath, { recursive: true })
  const { createModelDownloader } = await import('node-llama-cpp')

  const send = (payload: {
    modelId: string
    downloadedBytes: number
    totalBytes: number
    done: boolean
    error?: string
  }): void => {
    if (!sender.isDestroyed()) {
      sender.send('model:downloadProgress', { ...payload, label: spec.label })
    }
  }

  const state: ActiveDownload = {
    downloader: null as unknown as ModelDownloader,
    downloadedBytes: 0,
    totalBytes: spec.expectedBytes
  }
  activeDownloads.set(spec.key, state)

  try {
    const downloader = await createModelDownloader({
      modelUri: spec.hfUri,
      dirPath: spec.dirPath,
      fileName: spec.fileName,
      showCliProgress: false,
      onProgress: ({ totalSize, downloadedSize }) => {
        state.downloadedBytes = downloadedSize
        state.totalBytes = totalSize || spec.expectedBytes
        send({
          modelId: spec.key,
          downloadedBytes: downloadedSize,
          totalBytes: state.totalBytes,
          done: false
        })
      }
    })
    state.downloader = downloader

    const path = await downloader.download()
    await importGguf(path)
    send({
      modelId: spec.key,
      downloadedBytes: state.totalBytes,
      totalBytes: state.totalBytes,
      done: true
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Cancellation surfaces as an error from download(); report it quietly.
    send({
      modelId: spec.key,
      downloadedBytes: state.downloadedBytes,
      totalBytes: state.totalBytes,
      done: false,
      error: message.includes('abort') ? 'cancelled' : message
    })
  } finally {
    activeDownloads.delete(spec.key)
  }
}

export async function startDownload(sender: WebContents, modelId: string): Promise<void> {
  const entry = await catalogModel(modelId)
  await downloadGguf(sender, {
    key: modelId,
    label: entry.name,
    hfUri: entry.hfUri,
    fileName: entry.filename,
    dirPath: modelsDir(),
    expectedBytes: entry.sizeBytes
  })
}

/** Downloads an arbitrary GGUF picked in the Hugging Face browser. */
export async function startHfDownload(
  sender: WebContents,
  repoId: string,
  filename: string,
  sizeBytes: number
): Promise<{ key: string }> {
  const key = `hf:${repoId}/${filename}`
  // Per-repo subdirectory so same-named quants from different repos coexist.
  const dirPath = join(modelsDir(), repoId.replaceAll('/', '__'))
  void downloadGguf(sender, {
    key,
    label: filename.replace(/\.gguf$/i, ''),
    hfUri: `hf:${repoId}/${filename}`,
    fileName: filename,
    dirPath,
    expectedBytes: sizeBytes
  })
  return { key }
}

/** Live progress for a download key (HF browser polls this on reopen). */
export function downloadProgress(key: string): { downloadedBytes: number; totalBytes: number } | null {
  const active = activeDownloads.get(key)
  return active ? { downloadedBytes: active.downloadedBytes, totalBytes: active.totalBytes } : null
}

export async function cancelDownload(modelId: string): Promise<boolean> {
  const active = activeDownloads.get(modelId)
  if (!active?.downloader) return false
  await active.downloader.cancel()
  activeDownloads.delete(modelId)
  return true
}

/** Removes a downloaded catalog model from disk and the registry. */
export async function deleteDownloadedModel(modelId: string): Promise<void> {
  const entry = await catalogModel(modelId)
  const path = join(modelsDir(), entry.filename)
  await removeLocalModel(path)
  await rm(path, { force: true })
}
