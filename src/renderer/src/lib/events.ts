import { ipcEvents, type IpcEventChannel, type IpcEventPayload } from '@shared/ipc'

/**
 * Subscribe to a main-process event with the payload validated against its
 * `ipcEvents` schema. A payload that doesn't parse is dropped with a console
 * warning instead of reaching a listener that would destructure it — this is
 * the receipt-side half of the "both sides validate" contract.
 */
export function onIpcEvent<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void
): () => void {
  return window.pandora.on(channel, (raw) => {
    const parsed = ipcEvents[channel].safeParse(raw)
    if (!parsed.success) {
      console.warn(`[ipc] dropped malformed "${channel}" event:`, parsed.error.message)
      return
    }
    // The indexed schema lookup erases the channel-specific type; the parse
    // above is what actually guarantees it.
    listener(parsed.data as IpcEventPayload<C>)
  })
}
