import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcRequest,
  IpcResponse,
  IpcResult
} from '../shared/ipc'

/**
 * The complete surface exposed to the renderer. The renderer never sees
 * ipcRenderer directly — only these typed wrappers.
 */
const api = {
  invoke: <C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>
  ): Promise<IpcResult<IpcResponse<C>>> => ipcRenderer.invoke(channel, payload),

  on: (channel: IpcEventChannel, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type PandoraApi = typeof api

contextBridge.exposeInMainWorld('pandora', api)
