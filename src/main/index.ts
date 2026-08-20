import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAllowedNavigation, isOpenableExternalUrl } from './navigation'
import { registerAssetSchemePrivileges, registerAssetProtocol } from './assets/scheme'
import { themesDir } from './themes/service'
import appIcon from '../../resources/icon.png?asset'
import { existsSync, renameSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { refreshAppMenu } from './menu'
import { legacyUserDataDir, migrateLegacyStatePaths } from './store'
import { flushAllAutocommits, awaitIdle } from './git/service'
import { requestRendererFlush, requestAllRendererFlushes } from './flush'
import { initTelemetry, shutdownTelemetry } from './telemetry'
import { logInfo, logWarn, logError } from './log'
import { backfillModelMetadata } from './llm/local'

/**
 * One-time migration from the app's original name ("pandoras-box"). Moves
 * known state files/dirs into the new userData location so recents, prefs,
 * and downloaded models survive the rename, then rewrites absolute model
 * paths stored in app state. Runs before anything reads state.
 * Note: safeStorage secrets are tied to the old keychain item and will not
 * decrypt after the rename — those keys must be re-entered once.
 */
function migrateLegacyUserData(): void {
  try {
    const newDir = app.getPath('userData')
    const oldDir = legacyUserDataDir()
    if (existsSync(oldDir) && oldDir !== newDir) {
      let moved = false
      for (const entry of ['app-state.json', 'secrets.json', 'models', 'logs']) {
        const from = join(oldDir, entry)
        const to = join(newDir, entry)
        if (existsSync(from) && !existsSync(to)) {
          renameSync(from, to)
          moved = true
        }
      }
      if (moved) logInfo('app', `migrated user data from ${oldDir}`)
    }
    // The moved app-state.json still holds absolute model paths into the old
    // dir; heal them even when the old dir itself is already gone.
    migrateLegacyStatePaths()
  } catch (err) {
    logError('app', 'user data migration failed', err)
  }
}

// Electron requires scheme privileges before the ready event fires.
registerAssetSchemePrivileges()

let quitFlushed = false

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // macOS and Windows take the icon from the packaged bundle; Linux does not,
    // so the window has to carry it.
    ...(process.platform === 'linux' ? { icon: appIcon } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // ⌘W (role: close) tears the renderer down with up to 5 s of typing only
  // in its buffer — ask it to save first, then close for real. During quit
  // the flush already ran, and preventing THIS close would cancel the whole
  // quit on macOS, leaving a headless app in the dock.
  let closeFlushed = false
  mainWindow.on('close', (event) => {
    if (quitFlushed || closeFlushed) return
    event.preventDefault()
    void (async () => {
      await requestRendererFlush(mainWindow)
      await flushAllAutocommits()
      await awaitIdle()
      closeFlushed = true
      if (!mainWindow.isDestroyed()) mainWindow.close()
    })()
  })

  // A crashed renderer must recover visibly instead of leaving a blank window.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('app', 'renderer process gone — reloading window', details)
    if (!mainWindow.isDestroyed()) mainWindow.webContents.reload()
  })

  // All external links open in the system browser, never in-app — and only
  // web/mail URLs reach the OS: file://, javascript:, and custom schemes are
  // dropped rather than handed to shell.openExternal.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isOpenableExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // The window may only ever navigate back to its own entry document (see
  // navigation.ts for why the old file:// prefix check was a takeover path).
  const entryFile = join(__dirname, '../renderer/index.html')
  const entryUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(entryFile).href
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, entryUrl)) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(entryFile)
  }
}

app.on('child-process-gone', (_event, details) => {
  logError('app', 'child process gone', details)
})

app.whenReady().then(() => {
  migrateLegacyUserData()
  electronApp.setAppUserModelId('com.davintaddeo.pandorasgate')

  // `electron-vite dev` runs under the Electron binary, whose bundle icon owns
  // the dock slot. Packaged builds already show the right icon.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(appIcon))
  }

  // Populates the native About panel — the macOS app menu's "About Pandora's
  // Gate" item, which is present even though the menu bar is hidden elsewhere.
  app.setAboutPanelOptions({
    applicationName: "Pandora's Gate",
    applicationVersion: app.getVersion(),
    version: '',
    copyright: '© 2026 Davin Taddeo — MIT License',
    credits: "Writer's Studio — write novels with local and remote AI assistance.",
    iconPath: appIcon
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAssetProtocol(themesDir())
  registerIpcHandlers()
  void refreshAppMenu()
  createWindow()
  logInfo('app', `started v${app.getVersion()}`)
  void initTelemetry()
  // Models registered before 0.5 carry no trained-window figure, which pins
  // them to the old flat 16k cap. Backfilled in the background: it starts the
  // worker to read GGUF headers, so it must not hold up the window.
  void backfillModelMetadata().catch((err) =>
    logWarn('llm', 'context metadata backfill failed', err)
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (quitFlushed) return
  event.preventDefault()
  void (async () => {
    // Renderer buffers first — the git flush below can only commit what the
    // renderer has written to disk.
    await requestAllRendererFlushes()
    await Promise.allSettled([flushAllAutocommits().then(() => awaitIdle()), shutdownTelemetry()])
  })().finally(() => {
    quitFlushed = true
    app.quit()
  })
})
