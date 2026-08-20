import { contextBridge, ipcRenderer } from 'electron'
import {
  ipcContract,
  ipcEvents,
  type IpcChannel,
  type IpcEventChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult
} from '../shared/ipc'

/*
 * Runtime channel allowlists. The types alone vanish at compile time, so a
 * compromised or navigated renderer could otherwise invoke arbitrary channel
 * names; keeping the check here means the contract holds even then.
 */
const INVOKE_CHANNELS = new Set<string>(Object.keys(ipcContract))
const EVENT_CHANNELS = new Set<string>(Object.keys(ipcEvents))

/**
 * The complete surface exposed to the renderer. The renderer never sees
 * ipcRenderer directly — only these typed wrappers.
 */
const api = {
  invoke: <C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>
  ): Promise<IpcResult<IpcResponse<C>>> => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: `Unknown IPC channel: ${channel}` }
      })
    }
    return ipcRenderer.invoke(channel, payload)
  },

  on: (channel: IpcEventChannel, listener: (payload: unknown) => void): (() => void) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {}
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type PandoraApi = typeof api

contextBridge.exposeInMainWorld('pandora', api)
