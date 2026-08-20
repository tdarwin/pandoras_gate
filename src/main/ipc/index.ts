import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
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
import { rendererFlushed } from '../flush'
import { isOpenableExternalUrl } from '../navigation'
import { setNovelAssetRoot } from '../assets/scheme'
import { refreshAppMenu } from '../menu'
import { readAppState, touchRecentNovel } from '../store'
import { getProvider, startChat, cancelChat } from '../llm/chat'
import {
  importGguf,
  removeLocalModel,
  recordResolvedContext,
  contextCeilingFor
} from '../llm/local'
import {
  catalogStatus,
  startDownload,
  startHfDownload,
  cancelDownload
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
import { logWarn, logError } from '../log'
import { withSpan } from '../telemetry'
import { setSecret, hasSecret } from '../secrets'
import { assembleContext, estimateTokens, resolveContextTarget } from '../context/assembler'
import { toolOverheadTokens } from '../llm/tools'
import { gatherStorySource } from '../context/gather'
import { chapterHtml, chapterPlainText } from '../publish/profiles'
import { parseFrontmatter } from '../../shared/frontmatter'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  proposalsForReview,
  resolveProposalItem
} from '../metadata/pipeline'
import { startDraft, finishDraft } from '../draft/service'
import { runEditingReview } from '../review/service'

/**
 * Drops keys whose value is `undefined` so a partial update can be spread over
 * current state without an absent field blanking it.
 */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

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
      logWarn('ipc', `${channel} rejected: invalid request`, parsed.error.message)
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: parsed.error.message }
      }
    }
    try {
      // Every IPC call is a span — the app's whole surface flows through here.
      const data = await withSpan(`ipc ${channel}`, { 'ipc.channel': channel }, () =>
        Promise.resolve(handler(parsed.data as IpcRequest<C>, event))
      )
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('ipc', `${channel} failed`, err)
      return { ok: false, error: { code: 'INTERNAL', message } }
    }
  })
}

export function registerIpcHandlers(): void {
  handle('app:flushed', (_req, event) => {
    rendererFlushed(event.sender.id)
    return { ok: true as const }
  })

  // The worker resolves context windows on both the warm-load and the chat
  // path, so recording is driven by the worker rather than by whichever caller
  // happened to trigger the load. The renderer is told as well, because it
  // budgets story context from its own cached copy of the model list.
  llmWorkerHost.onContextResolved((modelPath, contextLength) => {
    void recordResolvedContext(modelPath, contextLength).catch(() => {})
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('model:contextResolved', { modelId: modelPath, contextLength })
      }
    }
  })


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

  handle('shell:openExternal', async (req) => {
    // Validated in main, not just the renderer: the renderer is the side
    // rendering untrusted markdown, so its judgment is not trusted here.
    if (!isOpenableExternalUrl(req.url)) return { opened: false }
    await shell.openExternal(req.url)
    return { opened: true }
  })

  handle('project:createNovel', async (req) => {
    const state = await project.createNovel(req)
    await touchRecentNovel(state.dir)
    setNovelAssetRoot(state.dir)
    await gitService.commitAll(state.dir, 'novel created')
    return state
  })

  handle('project:openNovel', async (req) => {
    const state = await project.openNovel(req.dir)
    await touchRecentNovel(state.dir)
    setNovelAssetRoot(state.dir)
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
    const result = await project.renameChapter(req.novelDir, req.file, req.newTitle)
    gitService.scheduleAutocommit(req.novelDir, `chapter renamed: ${req.newTitle}`, ['novel.yaml'])
    return result
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

  handle('archive:list', async (req) => ({
    chapters: await project.listArchivedChapters(req.novelDir)
  }))

  handle('archive:restore', async (req) => {
    const state = await project.restoreArchivedChapter(req.novelDir, req.file)
    await gitService.commitAll(req.novelDir, `chapter restored from archive: ${basename(req.file, '.md')}`, [
      'novel.yaml'
    ])
    return state
  })

  handle('archive:delete', async (req) => {
    await project.deleteArchivedChapter(req.novelDir, req.file)
    await gitService.commitAll(req.novelDir, `archived chapter deleted: ${basename(req.file, '.md')}`, [])
    return { deleted: true as const }
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
        capabilities: { jsonSchema: true, toolUse: true }
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
    startChat(
      event.sender,
      req.requestId,
      req.provider,
      {
        modelId: req.modelId,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.cachePrefixChars !== undefined ? { cachePrefixChars: req.cachePrefixChars } : {})
      },
      req.novelDir
        ? {
            novelDir: req.novelDir,
            activeFile: req.activeFile ?? null,
            toolUse: req.toolUse ?? false,
            ...(req.conversationId ? { conversationId: req.conversationId } : {})
          }
        : undefined
    )
    return { started: true as const }
  })

  handle('app:rendererError', (req) => {
    logError('renderer', `${req.source ?? 'error'}: ${req.message}`, req.stack)
    return { logged: true as const }
  })

  handle('menu:setContext', async (req) => {
    await refreshAppMenu(req)
    return { updated: true as const }
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
    // The window is recorded by the worker's contextResolved listener, not
    // here — that covers the chat path too, which no warm load precedes.
    void llmWorkerHost.loadModel(entry.path, contextCeilingFor(entry)).catch(() => {})
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

  // Passed through wholesale rather than field-by-field: the request schema in
  // ipc.ts already permits exactly the settable prefs and strips anything else,
  // and an explicit list silently drops any pref added without editing it here.
  handle('prefs:set', (req) => writePrefs(definedOnly(req)))

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

  handle('project:setChatInstructions', async (req) => {
    const manifest = await project.readNovelManifest(req.novelDir)
    if (req.instructions.trim()) manifest.chatInstructions = req.instructions.trim()
    else delete manifest.chatInstructions
    await project.writeNovelManifest(req.novelDir, manifest)
    gitService.scheduleAutocommit(req.novelDir, 'novel: AI instructions updated', ['novel.yaml'])
    return { dir: req.novelDir, manifest }
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

  handle('proposals:run', async (req, event) => {
    await gitService.flushAutocommit(req.novelDir)
    return runMetadataUpdate({
      novelDir: req.novelDir,
      chapterFile: req.chapterFile,
      provider: getProvider(req.provider),
      modelId: req.modelId,
      onStatus: (text) => {
        if (!event.sender.isDestroyed()) event.sender.send('pipeline:status', { text })
      }
    })
  })

  handle('review:run', async (req, event) => {
    await gitService.flushAutocommit(req.novelDir)
    return runEditingReview({
      novelDir: req.novelDir,
      scope: req.scope,
      ...(req.chapterFile ? { chapterFile: req.chapterFile } : {}),
      reviewType: req.reviewType,
      ...(req.guidance ? { guidance: req.guidance } : {}),
      provider: getProvider(req.provider),
      modelId: req.modelId,
      onStatus: (text) => {
        if (!event.sender.isDestroyed()) event.sender.send('pipeline:status', { text })
      }
    })
  })

  handle('proposals:review', async (req) => ({
    proposals: await proposalsForReview(req.novelDir)
  }))

  handle('proposals:resolve', (req) => resolveProposalItem(req))

  handle('publish:copy', async (req) => {
    // Sweep any pending autosave so the clipboard matches the editor.
    await gitService.flushAutocommit(req.novelDir)
    const manifest = await project.readNovelManifest(req.novelDir)
    const entry = manifest.chapters.find((c) => c.file === req.file)
    const body = parseFrontmatter(await project.readChapter(req.novelDir, req.file)).body
    const html = chapterHtml(body, req.platform, entry?.title)
    const text = chapterPlainText(body, entry?.title)
    clipboard.write({ html, text })
    const words = text.split(/\s+/).filter((w) => /\w/.test(w)).length
    const warning =
      entry && (entry.status === 'draft' || entry.status === 'ai-draft')
        ? `chapter status is still “${entry.status}”`
        : undefined
    return { copied: true as const, words, ...(warning ? { warning } : {}) }
  })

  handle('context:assemble', async (req) => {
    // Snapshot pending saves so the assembler reads current chapter text.
    await gitService.flushAutocommit(req.novelDir)
    const source = await gatherStorySource(req.novelDir, req.activeFile)
    const prefs = await readPrefs()
    const overhead = req.toolUse ? toolOverheadTokens(req.activeFile, estimateTokens) : 0
    return assembleContext({
      source,
      chatHistory: req.chatHistory,
      userMessage: req.userMessage,
      contextTokens: req.contextTokens,
      reservedOutput: req.reservedOutput,
      targetTokens: resolveContextTarget(prefs.contextTargetTokens, req.contextTokens),
      ...(overhead > 0 ? { toolOverheadTokens: overhead } : {}),
      toolsAvailable: req.toolUse ?? false
    })
  })
}
