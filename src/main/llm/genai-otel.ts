import { context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolDefinition
} from '../../shared/llm/types'
import { getTracer } from '../telemetry'
import { logError } from '../log'

/**
 * GenAI semantic-convention instrumentation (OTel semconv v1.40, Development).
 *
 * Span model:
 *   invoke_agent pandora            — one agentic chat turn (chat.ts)
 *     chat {model}                  — each model round (this module wraps the stream)
 *     execute_tool {tool}           — each tool call (tools.ts)
 *       invoke_workflow {name}      — Codex/outline/edit pipelines (pipeline.ts)
 *         chat {model}              — the pipeline's own model call
 *
 * Conversation/prompt content is captured ONLY when the standard
 * OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT env var opts in
 * (span_only / span_and_event / true) — and telemetry itself only runs in dev.
 */

/** Attribute values stay under Honeycomb's per-attribute limits. */
const MAX_CONTENT_CHARS = 30_000

export function contentCaptureEnabled(): boolean {
  const mode = process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']?.toLowerCase()
  return mode === 'span_only' || mode === 'span_and_event' || mode === 'true'
}

export function truncate(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? `${text.slice(0, MAX_CONTENT_CHARS)}…[truncated]`
    : text
}

/* ------------------------------------------------------------------ */
/* Message mapping to the semconv JSON schema (role + parts)           */
/* ------------------------------------------------------------------ */

interface MessagePart {
  type: 'text' | 'tool_call' | 'tool_call_response'
  content?: string
  id?: string
  name?: string
  arguments?: string
  response?: string
}

interface GenAiMessage {
  role: string
  parts: MessagePart[]
  finish_reason?: string
}

/** Non-system messages -> gen_ai.input.messages JSON. */
export function toInputMessages(messages: ChatMessage[]): GenAiMessage[] {
  const out: GenAiMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        parts: [
          { type: 'tool_call_response', id: m.toolCallId ?? '', response: m.content }
        ]
      })
      continue
    }
    const parts: MessagePart[] = []
    if (m.content) parts.push({ type: 'text', content: m.content })
    for (const call of m.toolCalls ?? []) {
      parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
    }
    if (parts.length > 0) out.push({ role: m.role, parts })
  }
  return out
}

/** System messages -> gen_ai.system_instructions JSON. */
export function toSystemInstructions(messages: ChatMessage[]): MessagePart[] {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => ({ type: 'text' as const, content: m.content }))
}

/** The streamed assistant reply -> gen_ai.output.messages JSON. */
export function toOutputMessages(
  text: string,
  toolCalls: { id: string; name: string; arguments: string }[],
  finishReason: string
): GenAiMessage[] {
  const parts: MessagePart[] = []
  if (text) parts.push({ type: 'text', content: text })
  for (const call of toolCalls) {
    parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
  }
  return [{ role: 'assistant', parts, finish_reason: finishReason }]
}

export function toToolDefinitions(tools: ToolDefinition[]): object[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}

/* ------------------------------------------------------------------ */
/* Traced chat stream                                                  */
/* ------------------------------------------------------------------ */

export interface ChatSpanMeta {
  conversationId: string
  providerId: string
}

function providerName(providerId: string): string {
  return providerId === 'local' ? 'llama_cpp' : providerId
}

/**
 * Wraps a provider stream in a semconv `chat {model}` CLIENT span: request
 * params and (opt-in) input messages up front; tokens, finish reasons,
 * time-to-first-chunk, and (opt-in) output messages when the stream ends.
 * Used by the chat agent loop and by every pipeline model call.
 */
export async function* tracedChatStream(
  provider: LLMProvider,
  req: ChatRequest,
  signal: AbortSignal,
  meta: ChatSpanMeta
): AsyncGenerator<StreamEvent> {
  const tracer = getTracer()
  const span = tracer.startSpan(
    `chat ${req.modelId}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': providerName(meta.providerId),
        'gen_ai.request.model': req.modelId,
        'gen_ai.conversation.id': meta.conversationId,
        ...(req.temperature !== undefined ? { 'gen_ai.request.temperature': req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { 'gen_ai.request.max_tokens': req.maxTokens } : {}),
        ...(meta.providerId === 'openrouter' ? { 'server.address': 'openrouter.ai' } : {})
      }
    },
    otelContext.active()
  )
  if (contentCaptureEnabled()) {
    span.setAttribute('gen_ai.input.messages', truncate(JSON.stringify(toInputMessages(req.messages))))
    const system = toSystemInstructions(req.messages)
    if (system.length > 0) {
      span.setAttribute('gen_ai.system_instructions', truncate(JSON.stringify(system)))
    }
  }
  if (req.tools?.length) {
    span.setAttribute('gen_ai.tool.definitions', truncate(JSON.stringify(toToolDefinitions(req.tools))))
  }

  const started = Date.now()
  let firstChunkAt: number | null = null
  let outputText = ''
  const toolCalls: { id: string; name: string; arguments: string }[] = []
  let finishReason = 'stop'
  let errored = false

  try {
    for await (const event of provider.chatStream(req, signal)) {
      switch (event.type) {
        case 'delta':
          if (firstChunkAt === null) firstChunkAt = Date.now()
          outputText += event.text
          break
        case 'toolCall':
          if (firstChunkAt === null) firstChunkAt = Date.now()
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
          break
        case 'usage':
          span.setAttribute('gen_ai.usage.input_tokens', event.promptTokens)
          span.setAttribute('gen_ai.usage.output_tokens', event.completionTokens)
          break
        case 'done':
          finishReason = event.finishReason
          break
        case 'error':
          errored = true
          span.setStatus({ code: SpanStatusCode.ERROR, message: event.message })
          span.setAttribute('error.type', 'provider_error')
          span.setAttribute('error.message', truncate(event.message))
          logError('llm', `provider error (${meta.providerId}/${req.modelId})`, event.message)
          break
        default:
          break
      }
      yield event
    }
  } catch (err) {
    errored = true
    const message = err instanceof Error ? err.message : String(err)
    span.setStatus({ code: SpanStatusCode.ERROR, message })
    span.setAttribute('error.type', err instanceof Error ? err.name : 'Error')
    span.setAttribute('error.message', truncate(message))
    logError('llm', `stream failed (${meta.providerId}/${req.modelId})`, err)
    throw err
  } finally {
    if (signal.aborted) finishReason = 'cancelled'
    span.setAttribute('gen_ai.response.finish_reasons', [finishReason])
    if (firstChunkAt !== null) {
      span.setAttribute('app.time_to_first_chunk_ms', firstChunkAt - started)
    }
    if (contentCaptureEnabled() && !errored) {
      span.setAttribute(
        'gen_ai.output.messages',
        truncate(JSON.stringify(toOutputMessages(outputText, toolCalls, finishReason)))
      )
    }
    if (!errored) span.setStatus({ code: SpanStatusCode.OK })
    span.end()
  }
}
