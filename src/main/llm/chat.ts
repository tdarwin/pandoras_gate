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
import { DeltaCoalescer } from './coalesce'
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

/**
 * A generation a tool queued to run AFTER the chat reply finishes. Running it
 * inline would open a second stream on the same provider while the chat still
 * holds its full context — on local models that shrinks (or OOMs) the nested
 * run's window. `run` resolves to a short author-facing result line.
 */
export interface DeferredRun {
  label: string
  run: (onStatus: (text: string) => void) => Promise<string>
}

/**
 * Runs a reply's deferred generations sequentially and reports progress via
 * renderer events. The caller announces `pipeline:run {phase:'started'}` for
 * the batch BEFORE the chat's final `done`, so the proposals UI reads
 * "running" before the chat reads "idle" — no gap for auto-Codex to sneak in.
 */
export async function runDeferredJobs(
  jobs: DeferredRun[],
  emit: (channel: 'pipeline:run' | 'pipeline:status' | 'proposals:changed', payload: unknown) => void
): Promise<void> {
  const results: string[] = []
  let error: string | undefined
  for (const job of jobs) {
    emit('pipeline:status', { text: job.label })
    try {
      results.push(await job.run((text) => emit('pipeline:status', { text })))
    } catch (err) {
      logError('chat', `deferred run failed: ${job.label}`, err)
      error ??= err instanceof Error ? err.message : String(err)
    }
  }
  emit('pipeline:run', {
    phase: 'finished',
    label: jobs[0]?.label ?? '',
    ...(results.length > 0 ? { result: results.join('; ') } : {}),
    ...(error !== undefined ? { error } : {})
  })
  emit('proposals:changed', {})
}

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

  const rawSend = (event: StreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:event', { requestId, event })
  }
  // One renderer update per ~frame instead of per token — a long transcript
  // re-renders on every chat:event.
  const coalescer = new DeltaCoalescer((text) => rawSend({ type: 'delta', text }))
  const send = (event: StreamEvent): void => {
    if (event.type === 'delta') {
      coalescer.push(event.text)
      return
    }
    coalescer.flush()
    rawSend(event)
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
      const deferredRuns: DeferredRun[] = []
      const toolCtx: ToolContext | null =
        chatContext?.toolUse && chatContext.novelDir
          ? {
              novelDir: chatContext.novelDir,
              activeFile: chatContext.activeFile,
              provider,
              modelId: req.modelId,
              sender,
              conversationId,
              defer: (job) => deferredRuns.push(job)
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
            const emit = (channel: string, payload: unknown): void => {
              if (!sender.isDestroyed()) sender.send(channel, payload)
            }
            if (deferredRuns.length > 0) {
              // Announced before `done` — see runDeferredJobs.
              emit('pipeline:run', { phase: 'started', label: deferredRuns[0]!.label })
            }
            send({ type: 'done', finishReason: finished ?? 'stop' })
            if (deferredRuns.length > 0) {
              await runDeferredJobs(deferredRuns, emit)
            }
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
        coalescer.flush()
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
