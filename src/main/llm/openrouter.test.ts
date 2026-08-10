import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../secrets', () => ({
  getSecret: vi.fn().mockResolvedValue('sk-or-test'),
  hasSecret: vi.fn().mockResolvedValue(true)
}))

import { OpenRouterProvider } from './openrouter'
import type { StreamEvent } from '../../shared/llm/types'

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const e of iter) events.push(e)
  return events
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('OpenRouterProvider.chatStream', () => {
  it('yields deltas, usage, and done from an SSE stream', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)))

    const provider = new OpenRouterProvider()
    const events = await collect(
      provider.chatStream(
        { modelId: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
    )

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hello')
    expect(events.some((e) => e.type === 'usage' && e.promptTokens === 10)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('surfaces HTTP errors as error events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
      )
    )
    const provider = new OpenRouterProvider()
    const events = await collect(
      provider.chatStream(
        { modelId: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('Invalid API key')
  })

  it('surfaces network failures as error events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const provider = new OpenRouterProvider()
    const events = await collect(
      provider.chatStream(
        { modelId: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
    )
    expect(events[0]!.type).toBe('error')
  })

  it('accumulates streamed tool calls and emits them before done', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"update_"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"codex","arguments":"{"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)))
    const provider = new OpenRouterProvider()
    const events = await collect(
      provider.chatStream(
        {
          modelId: 'test/model',
          messages: [{ role: 'user', content: 'update the codex' }],
          tools: [{ name: 'update_codex', description: 'x', parameters: { type: 'object' } }]
        },
        new AbortController().signal
      )
    )
    const toolCall = events.find((e) => e.type === 'toolCall')
    expect(toolCall).toEqual({
      type: 'toolCall',
      id: 'call_1',
      name: 'update_codex',
      arguments: '{}'
    })
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('maps tool messages to the OpenAI wire format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenRouterProvider()
    await collect(
      provider.chatStream(
        {
          modelId: 'test/model',
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', name: 'update_codex', arguments: '{}' }]
            },
            { role: 'tool', content: 'Done: 3 suggestions queued', toolCallId: 'call_1' }
          ]
        },
        new AbortController().signal
      )
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      messages: Record<string, unknown>[]
    }
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function' }]
    })
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
  })

  it('surfaces mid-stream error payloads', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Par"}}]}\n\n',
      'data: {"error":{"message":"rate limited"}}\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)))
    const provider = new OpenRouterProvider()
    const events = await collect(
      provider.chatStream(
        { modelId: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
    )
    expect(events.at(-1)).toEqual({ type: 'error', message: 'rate limited' })
  })
})

describe('OpenRouterProvider.listModels', () => {
  it('maps and caches the model list', async () => {
    const body = {
      data: [
        {
          id: 'acme/prose-1',
          name: 'Prose One',
          context_length: 32768,
          pricing: { prompt: '0.000001', completion: '0.000002' },
          supported_parameters: ['response_format']
        }
      ]
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenRouterProvider()
    const models = await provider.listModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'acme/prose-1',
      contextLength: 32768,
      capabilities: { jsonSchema: true, toolUse: false }
    })
    expect(models[0]!.pricing!.promptPerMTok).toBeCloseTo(1)

    await provider.listModels()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
