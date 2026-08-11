import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { flushAllAutocommits } from './git/service'
import { initTelemetry, shutdownTelemetry } from './telemetry'
import { logInfo, logError } from './log'

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
  electronApp.setAppUserModelId('com.davintaddeo.pandorasbox')

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
