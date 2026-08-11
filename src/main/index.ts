import { app, shell, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { flushAllAutocommits } from './git/service'
import { initTelemetry, shutdownTelemetry } from './telemetry'
import { logInfo, logError } from './log'

/**
 * One-time migration from the app's original name ("pandoras-box"). Moves
 * known state files/dirs into the new userData location so recents, prefs,
 * and downloaded models survive the rename. Runs before anything reads state.
 * Note: safeStorage secrets are tied to the old keychain item and will not
 * decrypt after the rename — those keys must be re-entered once.
 */
function migrateLegacyUserData(): void {
  try {
    const newDir = app.getPath('userData')
    const oldDir = join(dirname(newDir), 'pandoras-box')
    if (!existsSync(oldDir) || oldDir === newDir) return
    for (const entry of ['app-state.json', 'secrets.json', 'models', 'logs']) {
      const from = join(oldDir, entry)
      const to = join(newDir, entry)
      if (existsSync(from) && !existsSync(to)) {
        renameSync(from, to)
      }
    }
    logInfo('app', `migrated user data from ${oldDir}`)
  } catch (err) {
    logError('app', 'user data migration failed', err)
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
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

  // A crashed renderer must recover visibly instead of leaving a blank window.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('app', 'renderer process gone — reloading window', details)
    if (!mainWindow.isDestroyed()) mainWindow.webContents.reload()
  })

  // All external links open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'file://')) {
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('child-process-gone', (_event, details) => {
  logError('app', 'child process gone', details)
})

app.whenReady().then(() => {
  migrateLegacyUserData()
  electronApp.setAppUserModelId('com.davintaddeo.pandorasgate')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()
  logInfo('app', `started v${app.getVersion()}`)
  void initTelemetry()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitFlushed = false
app.on('before-quit', (event) => {
  if (quitFlushed) return
  event.preventDefault()
  void Promise.allSettled([flushAllAutocommits(), shutdownTelemetry()]).finally(() => {
    quitFlushed = true
    app.quit()
  })
})
