import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { basename } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { readAppState } from './store'
import { logsDir } from './log'
import type { IpcEventPayload } from '../shared/ipc'

/**
 * The native application menu, following platform conventions: on macOS the
 * app menu carries About and Settings…, File holds document commands, and
 * Help links out. Menu items don't act on their own — they send
 * 'menu:action' events that the renderer carries out against its stores, so
 * enablement is the only state the menu needs (synced via menu:setContext).
 */

export interface MenuContext {
  novelOpen: boolean
  /** Any editor document open (enables Save). */
  documentOpen: boolean
  /** A chapters/ file specifically (enables Copy Chapter For). */
  chapterOpen: boolean
}

const REPO_URL = 'https://github.com/tdarwin/pandoras_gate'

let current: MenuContext = { novelOpen: false, documentOpen: false, chapterOpen: false }

function send(
  action: IpcEventPayload<'menu:action'>['action'],
  extra?: Partial<Pick<IpcEventPayload<'menu:action'>, 'dir' | 'platform'>>
): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:action', { action, ...extra })
}

/** Rebuilds the menu; reads the recents list fresh every time. */
export async function refreshAppMenu(ctx: MenuContext = current): Promise<void> {
  current = ctx
  const isMac = process.platform === 'darwin'
  const recents = (await readAppState()).recentNovels

  const openRecent: MenuItemConstructorOptions[] =
    recents.length > 0
      ? recents.map((dir) => ({
          label: basename(dir),
          toolTip: dir,
          click: (): void => send('open-recent', { dir })
        }))
      : [{ label: 'No Recent Novels', enabled: false }]

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: (): void => send('preferences')
  }
  const aboutItem: MenuItemConstructorOptions = {
    label: "About Pandora's Gate",
    click: (): void => send('about')
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            // Packaged builds title this from CFBundleName; the label keeps
            // dev runs (and item text below) on the product name too.
            label: "Pandora's Gate",
            submenu: [
              aboutItem,
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: "Hide Pandora's Gate" },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: "Quit Pandora's Gate" }
            ] satisfies MenuItemConstructorOptions[]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chapter',
          accelerator: 'CmdOrCtrl+N',
          enabled: ctx.novelOpen,
          click: (): void => send('new-chapter')
        },
        { label: 'New Novel…', click: (): void => send('new-novel') },
        { type: 'separator' },
        {
          label: 'Open Novel…',
          accelerator: 'CmdOrCtrl+O',
          click: (): void => send('open-novel')
        },
        { label: 'Open Recent', submenu: openRecent },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          enabled: ctx.documentOpen,
          click: (): void => send('save')
        },
        {
          // Clipboard publishing: chapter formatted for a platform's editor.
          label: 'Copy Chapter For',
          enabled: ctx.chapterOpen,
          submenu: [
            {
              label: 'RoyalRoad',
              enabled: ctx.chapterOpen,
              click: (): void => send('copy-for', { platform: 'royalroad' })
            },
            {
              label: 'Patreon',
              enabled: ctx.chapterOpen,
              click: (): void => send('copy-for', { platform: 'patreon' })
            }
          ]
        },
        { type: 'separator' },
        { label: 'Close Novel', enabled: ctx.novelOpen, click: (): void => send('close-novel') },
        ...(isMac
          ? []
          : ([{ type: 'separator' }, settingsItem] satisfies MenuItemConstructorOptions[])),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(is.dev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' }
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : ([aboutItem, { type: 'separator' }] satisfies MenuItemConstructorOptions[])),
        {
          label: "Pandora's Gate on GitHub",
          click: (): void => void shell.openExternal(REPO_URL)
        },
        {
          label: 'Report an Issue…',
          click: (): void => void shell.openExternal(`${REPO_URL}/issues`)
        },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: (): void => void shell.openPath(logsDir()) }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
