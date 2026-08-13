import type { WebContents } from 'electron'
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolCallRef
} from '../../shared/llm/types'
import { context as otelContext } from '@opentelemetry/api'
import { openRouterProvider } from './openrouter'
import { localProvider } from './local'
import { chatToolDefinitions, executeTool, TOOL_SYSTEM_NOTE, type ToolContext } from './tools'
import { tracedChatStream } from './genai-otel'
import { logInfo, logError } from '../log'
import { withSpan, flushTelemetry } from '../telemetry'

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
  /** Session id shared by every span of this conversation (gen_ai.conversation.id). */
  conversationId?: string
}

const MAX_TOOL_ROUNDS = 4

function toolStatusText(name: string): string {
  switch (name) {
    case 'update_codex':
      return 'Updating the Codex…'
    case 'generate_outline':
      return 'Generating an outline…'
    case 'edit_chapter':
    case 'edit_chapter_section':
      return 'Revising the chapter…'
    case 'create_chapter':
      return 'Creating a chapter…'
    case 'append_to_chapter':
      return 'Adding to a chapter…'
    default:
      return `Running ${name}…`
  }
}

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

  const conversationId = chatContext?.conversationId ?? requestId

  void withSpan(
    'invoke_agent pandora',
    {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'pandora',
      'gen_ai.provider.name': providerId === 'local' ? 'llama_cpp' : providerId,
      'gen_ai.request.model': req.modelId,
      'gen_ai.conversation.id': conversationId,
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
              sender,
              conversationId
            }
          : null
      const tools = toolCtx ? chatToolDefinitions(toolCtx) : []

      const messages: ChatMessage[] = [...req.messages]
      // The tool note is static text — splice it into the cacheable prefix
      // (before the volatile chapter/chat-matched sections) so enabling tools
      // doesn't break prompt caching.
      let cachePrefixChars = req.cachePrefixChars
      if (tools.length > 0 && messages[0]?.role === 'system') {
        const content = messages[0].content
        const at = Math.min(cachePrefixChars ?? content.length, content.length)
        messages[0] = {
          ...messages[0],
          content: content.slice(0, at) + TOOL_SYSTEM_NOTE + content.slice(at)
        }
        if (cachePrefixChars !== undefined) cachePrefixChars = at + TOOL_SYSTEM_NOTE.length
      }

      // Duplicate/abort guards shared by both providers' tool paths.
      const seenCalls = new Set<string>()
      const guardedExecute = async (name: string, argsJson: string): Promise<string> => {
        if (controller.signal.aborted) return 'Cancelled by the author. Stop immediately.'
        const key = `${name}:${argsJson}`
        if (seenCalls.has(key)) {
          return 'You already called this tool with identical arguments in this reply and have its result. Do not repeat tool calls — answer the author now.'
        }
        seenCalls.add(key)
        return executeTool(toolCtx!, name, argsJson)
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
            ...(cachePrefixChars !== undefined ? { cachePrefixChars } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            // Local models run the tool loop inside the worker; give it a
            // bridge back to the same executor (with UI status updates).
            ...(toolCtx
              ? {
                  // context.bind: local-model tool calls arrive via the worker's
                  // message handler (a different async chain) — bind them to this
                  // agent span so execute_tool spans nest correctly.
                  toolExecutor: otelContext.bind(
                    otelContext.active(),
                    async (name: string, argsJson: string): Promise<string> => {
                      if (!controller.signal.aborted) {
                        send({ type: 'toolStatus', text: toolStatusText(name) })
                      }
                      return guardedExecute(name, argsJson)
                    }
                  )
                }
              : {})
          }

          for await (const event of tracedChatStream(provider, request, controller.signal, {
            conversationId,
            providerId
          })) {
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
            send({ type: 'toolStatus', text: toolStatusText(call.name) })
            logInfo('chat', `tool round ${toolRounds}: ${call.name}`)
            const result = await guardedExecute(call.name, call.arguments)
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
  )
    .catch(() => {
      // withSpan re-throws after recording; errors were already sent above.
    })
    .finally(() => {
      // Agent turns are the app's top-level GenAI invocations — flush so the
      // whole trace survives an early quit.
      void flushTelemetry()
    })
}

export function cancelChat(requestId: string): boolean {
  const controller = active.get(requestId)
  if (!controller) return false
  controller.abort()
  active.delete(requestId)
  return true
}
