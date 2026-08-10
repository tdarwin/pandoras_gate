import { app, dialog, ipcMain } from 'electron'
import {
  ipcContract,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult
} from '../../shared/ipc'
import { basename } from 'node:path'
import * as project from '../project/service'
import * as gitService from '../git/service'
import { readAppState, touchRecentNovel } from '../store'
import { getProvider, startChat, cancelChat } from '../llm/chat'
import { importGguf, removeLocalModel } from '../llm/local'
import {
  catalogStatus,
  startDownload,
  startHfDownload,
  cancelDownload,
  deleteDownloadedModel
} from '../llm/downloader'
import { searchHfGgufModels, listHfGgufFiles } from '../llm/hf'
import { detectHardware, fitForSize } from '../llm/hardware'
import { llmWorkerHost } from '../llm/worker-host'
import { listLocalModels } from '../llm/local'
import {
  getNovelModel,
  setNovelModel,
  readPrefs,
  writePrefs
} from '../store'
import { getRemoteUrl, setRemoteUrl, pushToRemote } from '../git/sync'
import { setSecret, hasSecret } from '../secrets'
import { assembleContext } from '../context/assembler'
import { gatherStorySource } from '../context/gather'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  proposalsForReview,
  resolveProposalItem
} from '../metadata/pipeline'
import { startDraft, finishDraft } from '../draft/service'

/**
 * Registers a handler for a contract channel. Incoming payloads are validated
 * against the contract's request schema before the handler runs; handler errors
 * are serialized to IpcResult so the renderer always gets a structured response.
 */
function handle<C extends IpcChannel>(
  channel: C,
  handler: (
    payload: IpcRequest<C>,
    event: Electron.IpcMainInvokeEvent
  ) => Promise<IpcResponse<C>> | IpcResponse<C>
): void {
  ipcMain.handle(channel, async (event, payload): Promise<IpcResult<IpcResponse<C>>> => {
    const parsed = ipcContract[channel].request.safeParse(payload)
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: parsed.error.message }
      }
    }
    try {
      const data = await handler(parsed.data as IpcRequest<C>, event)
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'INTERNAL', message } }
    }
  })
}

export function registerIpcHandlers(): void {
  handle('app:getInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    platform: process.platform as 'darwin' | 'win32' | 'linux'
  }))

  handle('app:getRecentNovels', async () => {
    const state = await readAppState()
    return { dirs: state.recentNovels }
  })

  handle('dialog:chooseDirectory', async (req) => {
    const result = await dialog.showOpenDialog({
      title: req.title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return { dir: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  handle('project:createNovel', async (req) => {
    const state = await project.createNovel(req)
    await touchRecentNovel(state.dir)
    await gitService.commitAll(state.dir, 'novel created')
    return state
  })

  handle('project:openNovel', async (req) => {
    const state = await project.openNovel(req.dir)
    await touchRecentNovel(state.dir)
    // Adopt pre-existing novels (or repos from older versions) transparently.
    await gitService.ensureRepo(state.dir)
    return state
  })

  handle('chapter:create', async (req) => {
    const state = await project.createChapter(req.novelDir, req.title)
    gitService.scheduleAutocommit(req.novelDir, `chapter created: ${req.title}`, ['novel.yaml'])
    return state
  })

  handle('chapter:rename', async (req) => {
    const state = await project.renameChapter(req.novelDir, req.file, req.newTitle)
    gitService.scheduleAutocommit(req.novelDir, `chapter renamed: ${req.newTitle}`, ['novel.yaml'])
    return state
  })

  handle('chapter:reorder', async (req) => {
    const state = await project.reorderChapters(req.novelDir, req.orderedFiles)
    gitService.scheduleAutocommit(req.novelDir, 'chapters reordered', ['novel.yaml'])
    return state
  })

  handle('chapter:read', async (req) => ({
    content: await project.readChapter(req.novelDir, req.file)
  }))

  handle('chapter:write', async (req) => {
    await project.writeChapter(req.novelDir, req.file, req.content)
    let snapshotted = false
    if (req.snapshot) {
      // Explicit save (⌘S / blur / chapter switch): one history snapshot now.
      await gitService.flushAutocommit(req.novelDir)
      const label = req.file.startsWith('metadata/')
        ? 'metadata'
        : req.file.startsWith('outlines/')
          ? 'outline'
          : 'chapter'
      const oid = await gitService.commitAll(
        req.novelDir,
        `${label}: ${basename(req.file).replace(/\.(md|yaml)$/, '')}`,
        [req.file]
      )
      snapshotted = oid !== null
    }
    return { saved: true as const, snapshotted }
  })

  handle('chapter:archive', async (req) => {
    const state = await project.archiveChapter(req.novelDir, req.file)
    await gitService.commitAll(req.novelDir, `chapter archived: ${basename(req.file, '.md')}`, [
      'novel.yaml'
    ])
    return state
  })

  handle('chapter:delete', async (req) => {
    const state = await project.deleteChapter(req.novelDir, req.file)
    await gitService.commitAll(req.novelDir, `chapter deleted: ${basename(req.file, '.md')}`, [
      'novel.yaml'
    ])
    return state
  })

  handle('metadata:list', (req) => project.listMetadata(req.novelDir))

  handle('metadata:create', async (req) => {
    const result = await project.createMetadataDoc(req.novelDir, req.kind, req.name)
    gitService.scheduleAutocommit(req.novelDir, `metadata: add ${req.name}`, [result.file])
    return result
  })

  handle('metadata:delete', async (req) => {
    await project.deleteMetadataDoc(req.novelDir, req.file)
    gitService.scheduleAutocommit(req.novelDir, `metadata: remove ${basename(req.file)}`, [])
    return { deleted: true as const }
  })

  handle('history:list', async (req) => {
    // Make sure the latest saves are snapshotted before showing history.
    await gitService.flushAutocommit(req.novelDir)
    return { commits: await gitService.history(req.novelDir, req.file) }
  })

  handle('history:diff', async (req) => {
    await gitService.flushAutocommit(req.novelDir)
    return gitService.diffAgainstWorkdir(req.novelDir, req.oid, req.file)
  })

  handle('history:restore', async (req) => {
    await gitService.flushAutocommit(req.novelDir)
    await gitService.restoreFile(req.novelDir, req.oid, req.file, basename(req.file, '.md'))
    return { content: await project.readChapter(req.novelDir, req.file) }
  })

  handle('llm:listModels', async () => {
    const [local, remote] = await Promise.all([
      getProvider('local')
        .listModels()
        .catch(() => []),
      hasSecret('openrouter-api-key').then((configured) =>
        configured
          ? getProvider('openrouter')
              .listModels()
              .catch(() => [])
          : []
      )
    ])
    return { models: [...local, ...remote] }
  })

  handle('llm:importGguf', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { model: null }
    const entry = await importGguf(path)
    return {
      model: {
        id: entry.path,
        name: entry.name,
        provider: 'local' as const,
        contextLength: entry.contextLength,
        capabilities: { jsonSchema: true }
      }
    }
  })

  handle('llm:removeLocalModel', async (req) => {
    await removeLocalModel(req.path)
    return { removed: true as const }
  })

  handle('llm:setApiKey', async (req) => {
    await setSecret(`${req.provider}-api-key`, req.key)
    return { saved: true as const }
  })

  handle('llm:hasApiKey', async (req) => ({
    configured: await hasSecret(`${req.provider}-api-key`)
  }))

  handle('chat:start', (req, event) => {
    startChat(event.sender, req.requestId, req.provider, {
      modelId: req.modelId,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {})
    })
    return { started: true as const }
  })

  handle('chat:cancel', (req) => ({ cancelled: cancelChat(req.requestId) }))

  handle('models:catalog', () => catalogStatus())

  handle('models:download', (req, event) => {
    // Fire-and-forget: progress and completion arrive via events.
    void startDownload(event.sender, req.modelId)
    return { started: true as const }
  })

  handle('models:cancelDownload', async (req) => ({
    cancelled: await cancelDownload(req.modelId)
  }))

  handle('models:searchHf', async (req) => ({
    repos: await searchHfGgufModels(req.query)
  }))

  handle('models:listHfFiles', async (req) => {
    const { files, gated } = await listHfGgufFiles(req.repoId)
    const hw = detectHardware()
    return {
      gated,
      files: files.map((f) => ({ ...f, fit: fitForSize(hw, f.sizeBytes) }))
    }
  })

  handle('models:downloadHf', (req, event) =>
    startHfDownload(event.sender, req.repoId, req.filename, req.sizeBytes)
  )

  handle('llm:warmLoad', async (req) => {
    const models = await listLocalModels()
    const entry = models.find((m) => m.path === req.modelId)
    if (!entry) return { warming: false }
    // Fire-and-forget: first chat gets a hot model instead of a load stall.
    void llmWorkerHost.loadModel(entry.path, entry.contextLength).catch(() => {})
    return { warming: true }
  })

  handle('llm:novelModel:get', async (req) => ({
    modelId: await getNovelModel(req.novelDir)
  }))

  handle('llm:novelModel:set', async (req) => {
    await setNovelModel(req.novelDir, req.modelId)
    return { saved: true as const }
  })

  handle('prefs:get', () => readPrefs())

  handle('prefs:set', (req) =>
    writePrefs({
      ...(req.autoStoryBible !== undefined ? { autoStoryBible: req.autoStoryBible } : {}),
      ...(req.snapshotOnBlur !== undefined ? { snapshotOnBlur: req.snapshotOnBlur } : {}),
      ...(req.snapshotIntervalMinutes !== undefined
        ? { snapshotIntervalMinutes: req.snapshotIntervalMinutes }
        : {})
    })
  )

  handle('sync:getConfig', async (req) => ({
    remoteUrl: await getRemoteUrl(req.novelDir),
    tokenConfigured: await hasSecret('git-sync-token')
  }))

  handle('sync:setConfig', async (req) => {
    await setRemoteUrl(req.novelDir, req.remoteUrl)
    if (req.token?.trim()) await setSecret('git-sync-token', req.token.trim())
    return { saved: true as const }
  })

  handle('sync:push', async (req) => ({
    pushed: true as const,
    remoteUrl: await pushToRemote(req.novelDir)
  }))

  handle('models:delete', async (req) => {
    await deleteDownloadedModel(req.modelId)
    return { deleted: true as const }
  })

  handle('chapter:setStatus', async (req) => {
    const state = await project.setChapterStatus(req.novelDir, req.file, req.status)
    gitService.scheduleAutocommit(req.novelDir, `status: ${basename(req.file, '.md')} → ${req.status}`, [
      req.file,
      'novel.yaml'
    ])
    return state
  })

  handle('outlines:generate', async (req) => {
    if (req.scope === 'chapter' && !req.chapterFile) {
      throw new Error('chapterFile is required for a chapter outline')
    }
    await gitService.flushAutocommit(req.novelDir)
    return runOutlineGeneration({
      novelDir: req.novelDir,
      scope: req.scope,
      ...(req.chapterFile ? { chapterFile: req.chapterFile } : {}),
      ...(req.guidance ? { guidance: req.guidance } : {}),
      provider: getProvider(req.provider),
      modelId: req.modelId
    })
  })

  handle('draft:start', (req, event) =>
    startDraft(event.sender, {
      requestId: req.requestId,
      novelDir: req.novelDir,
      chapterFile: req.chapterFile,
      providerId: req.provider,
      modelId: req.modelId,
      contextTokens: req.contextTokens,
      ...(req.instructions ? { instructions: req.instructions } : {})
    })
  )

  handle('draft:finish', async (req) => {
    await finishDraft(req.novelDir, req.chapterFile)
    return { done: true as const }
  })

  handle('proposals:run', async (req) => {
    await gitService.flushAutocommit(req.novelDir)
    return runMetadataUpdate({
      novelDir: req.novelDir,
      chapterFile: req.chapterFile,
      provider: getProvider(req.provider),
      modelId: req.modelId
    })
  })

  handle('proposals:review', async (req) => ({
    proposals: await proposalsForReview(req.novelDir)
  }))

  handle('proposals:resolve', (req) => resolveProposalItem(req))

  handle('context:assemble', async (req) => {
    // Snapshot pending saves so the assembler reads current chapter text.
    await gitService.flushAutocommit(req.novelDir)
    const source = await gatherStorySource(req.novelDir, req.activeFile)
    return assembleContext({
      source,
      chatHistory: req.chatHistory,
      userMessage: req.userMessage,
      contextTokens: req.contextTokens,
      reservedOutput: req.reservedOutput
    })
  })
}
