import type { WebContents } from 'electron'
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolCallRef
} from '../../shared/llm/types'
import { openRouterProvider } from './openrouter'
import { localProvider } from './local'
import { chatToolDefinitions, executeTool, TOOL_SYSTEM_NOTE, type ToolContext } from './tools'
import { logInfo, logError } from '../log'
import { withSpan } from '../telemetry'

/**
 * Chat orchestration: streams generations to the renderer and, when the
 * novel context allows it, runs an agentic tool loop — the model can call
 * update_codex / generate_outline, whose results land in the proposal queue.
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

export interface ChatContext {
  novelDir: string
  activeFile: string | null
  /** Whether the selected model supports tool calling. */
  toolUse: boolean
}

const MAX_TOOL_ROUNDS = 4

export function startChat(
  sender: WebContents,
  requestId: string,
  providerId: string,
  req: ChatRequest,
  chatContext?: ChatContext
): void {
  const provider = getProvider(providerId)
  const controller = new AbortController()
  active.set(requestId, controller)

  const send = (event: StreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:event', { requestId, event })
  }

  void withSpan(
    'chat generation',
    {
      'llm.provider': providerId,
      'llm.model': req.modelId,
      'chat.tools_enabled': Boolean(chatContext?.toolUse)
    },
    async (span) => {
      const toolCtx: ToolContext | null =
        chatContext?.toolUse && chatContext.novelDir
          ? {
              novelDir: chatContext.novelDir,
              activeFile: chatContext.activeFile,
              provider,
              modelId: req.modelId,
              sender
            }
          : null
      const tools = toolCtx ? chatToolDefinitions(toolCtx) : []

      const messages: ChatMessage[] = [...req.messages]
      if (tools.length > 0 && messages[0]?.role === 'system') {
        messages[0] = { ...messages[0], content: messages[0].content + TOOL_SYSTEM_NOTE }
      }

      let toolRounds = 0
      try {
        for (;;) {
          const pendingCalls: ToolCallRef[] = []
          let assistantText = ''
          let finished: string | null = null

          const request: ChatRequest = {
            ...req,
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            // Local models run the tool loop inside the worker; give it a
            // bridge back to the same executor (with UI status updates).
            ...(toolCtx
              ? {
                  toolExecutor: async (name: string, argsJson: string): Promise<string> => {
                    send({
                      type: 'toolStatus',
                      text:
                        name === 'update_codex'
                          ? 'Updating the Codex…'
                          : name === 'generate_outline'
                            ? 'Generating an outline…'
                            : `Running ${name}…`
                    })
                    return executeTool(toolCtx, name, argsJson)
                  }
                }
              : {})
          }

          for await (const event of provider.chatStream(request, controller.signal)) {
            if (controller.signal.aborted) break
            switch (event.type) {
              case 'delta':
                assistantText += event.text
                send(event)
                break
              case 'toolCall':
                pendingCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
                break
              case 'error':
                send(event)
                return
              case 'done':
                finished = event.finishReason
                break
              default:
                send(event)
            }
          }

          if (controller.signal.aborted) {
            send({ type: 'done', finishReason: 'cancelled' })
            return
          }

          if (pendingCalls.length === 0 || !toolCtx || toolRounds >= MAX_TOOL_ROUNDS) {
            span.setAttribute('chat.tool_rounds', toolRounds)
            send({ type: 'done', finishReason: finished ?? 'stop' })
            return
          }

          // Tool round: execute, append results, and let the model continue.
          toolRounds += 1
          messages.push({ role: 'assistant', content: assistantText, toolCalls: pendingCalls })
          for (const call of pendingCalls) {
            send({
              type: 'toolStatus',
              text:
                call.name === 'update_codex'
                  ? 'Updating the Codex…'
                  : call.name === 'generate_outline'
                    ? 'Generating an outline…'
                    : `Running ${call.name}…`
            })
            logInfo('chat', `tool round ${toolRounds}: ${call.name}`)
            const result = await executeTool(toolCtx, call.name, call.arguments)
            messages.push({ role: 'tool', content: result, toolCallId: call.id })
          }
        }
      } catch (err) {
        logError('chat', 'generation failed', err)
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        active.delete(requestId)
      }
    }
  ).catch(() => {
    // withSpan re-throws after recording; errors were already sent above.
  })
}

export function cancelChat(requestId: string): boolean {
  const controller = active.get(requestId)
  if (!controller) return false
  controller.abort()
  active.delete(requestId)
  return true
}
