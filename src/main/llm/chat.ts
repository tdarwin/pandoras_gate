import type { WebContents } from 'electron'
import type { ChatRequest, LLMProvider, StreamEvent } from '../../shared/llm/types'
import { openRouterProvider } from './openrouter'
import { localProvider } from './local'

/**
 * Tracks in-flight chat generations and pumps their stream events to the
 * renderer over `chat:event`. One AbortController per requestId.
 */

const providers: Record<string, LLMProvider> = {
  openrouter: openRouterProvider,
  local: localProvider
}

export function getProvider(id: string): LLMProvider {
  const provider = providers[id]
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}

export function registerProvider(provider: LLMProvider): void {
  providers[provider.id] = provider
}

const active = new Map<string, AbortController>()

export function startChat(
  sender: WebContents,
  requestId: string,
  providerId: string,
  req: ChatRequest
): void {
  const provider = getProvider(providerId)
  const controller = new AbortController()
  active.set(requestId, controller)

  void (async () => {
    const send = (event: StreamEvent): void => {
      if (!sender.isDestroyed()) sender.send('chat:event', { requestId, event })
    }
    try {
      for await (const event of provider.chatStream(req, controller.signal)) {
        if (controller.signal.aborted) break
        send(event)
        if (event.type === 'error' || event.type === 'done') break
      }
      if (controller.signal.aborted) send({ type: 'done', finishReason: 'cancelled' })
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      active.delete(requestId)
    }
  })()
}

export function cancelChat(requestId: string): boolean {
  const controller = active.get(requestId)
  if (!controller) return false
  controller.abort()
  active.delete(requestId)
  return true
}
