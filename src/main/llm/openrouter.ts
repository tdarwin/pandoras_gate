import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  StreamEvent
} from '../../shared/llm/types'
import { SseParser } from './sse'
import { getSecret } from '../secrets'

const BASE_URL = 'https://openrouter.ai/api/v1'
const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/davintaddeo/pandoras-box',
  'X-Title': "Pandora's Box Writer's Studio"
}
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
}

export class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter' as const

  private modelCache: { at: number; models: ModelInfo[] } | null = null

  private async apiKey(): Promise<string> {
    const key = await getSecret('openrouter-api-key')
    if (!key) throw new Error('No OpenRouter API key configured')
    return key
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.models
    }
    const res = await fetch(`${BASE_URL}/models`, { headers: APP_HEADERS })
    if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`)
    const body = (await res.json()) as { data: OpenRouterModel[] }
    const models = body.data
      .filter((m) => m.context_length > 0)
      .map(
        (m): ModelInfo => ({
          id: m.id,
          name: m.name,
          provider: 'openrouter',
          contextLength: m.context_length,
          capabilities: {
            jsonSchema: m.supported_parameters?.includes('response_format') ?? false,
            toolUse: m.supported_parameters?.includes('tools') ?? false
          },
          pricing: {
            promptPerMTok: Number(m.pricing?.prompt ?? 0) * 1_000_000,
            completionPerMTok: Number(m.pricing?.completion ?? 0) * 1_000_000
          }
        })
      )
      .sort((a, b) => a.name.localeCompare(b.name))
    this.modelCache = { at: Date.now(), models }
    return models
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    // Map our extended messages to OpenAI wire format (tool calls/results).
    const wireMessages = req.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: t.arguments }
          }))
        }
      }
      return { role: m.role, content: m.content }
    })

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          ...APP_HEADERS,
          Authorization: `Bearer ${await this.apiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: req.modelId,
          messages: wireMessages,
          stream: true,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                  }
                }))
              }
            : {}),
          ...(req.responseFormat
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: req.responseFormat.name,
                    strict: true,
                    schema: req.responseFormat.schema
                  }
                }
              }
            : {})
        })
      })
    } catch (err) {
      if (signal.aborted) return
      yield {
        type: 'error',
        message: `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`
      }
      return
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let message = `OpenRouter error ${res.status}`
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } }
        if (parsed.error?.message) message += `: ${parsed.error.message}`
      } catch {
        if (text) message += `: ${text.slice(0, 200)}`
      }
      yield { type: 'error', message }
      return
    }

    const parser = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let finishReason = 'stop'
    // Streamed tool calls arrive as fragments keyed by index; accumulate.
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          if (payload === '[DONE]') continue
          let json: {
            choices?: {
              delta?: {
                content?: string
                tool_calls?: {
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }[]
              }
              finish_reason?: string | null
            }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
            error?: { message?: string }
          }
          try {
            json = JSON.parse(payload)
          } catch {
            continue // comment/keep-alive lines
          }
          if (json.error?.message) {
            yield { type: 'error', message: json.error.message }
            return
          }
          const choice = json.choices?.[0]
          if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0
            const acc = toolCalls.get(idx) ?? { id: '', name: '', arguments: '' }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
            toolCalls.set(idx, acc)
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
          if (json.usage) {
            yield {
              type: 'usage',
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0
            }
          }
        }
      }
      for (const [idx, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          type: 'toolCall',
          id: tc.id || `call_${idx}`,
          name: tc.name,
          arguments: tc.arguments || '{}'
        }
      }
      yield { type: 'done', finishReason }
    } catch (err) {
      if (!signal.aborted) {
        yield {
          type: 'error',
          message: `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async countTokens(_modelId: string, text: string): Promise<number> {
    // Rough estimate (~4 chars/token) plus 10% safety margin; exact counting
    // for remote models isn't worth a tokenizer dependency per model family.
    return Math.ceil((text.length / 4) * 1.1)
  }
}

export const openRouterProvider = new OpenRouterProvider()
