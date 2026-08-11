import { describe, it, expect, afterEach } from 'vitest'
import {
  contentCaptureEnabled,
  toInputMessages,
  toOutputMessages,
  toSystemInstructions,
  toToolDefinitions,
  truncate
} from './genai-otel'
import type { ChatMessage } from '../../shared/llm/types'

afterEach(() => {
  delete process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']
})

describe('contentCaptureEnabled', () => {
  it('is off by default and on for the opt-in modes', () => {
    expect(contentCaptureEnabled()).toBe(false)
    for (const mode of ['span_only', 'span_and_event', 'true', 'SPAN_ONLY']) {
      process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = mode
      expect(contentCaptureEnabled()).toBe(true)
    }
    process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'event_only'
    expect(contentCaptureEnabled()).toBe(false)
  })
})

describe('message mapping (semconv role + parts schema)', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a writing partner.' },
    { role: 'user', content: 'Update the codex.' },
    {
      role: 'assistant',
      content: 'On it.',
      toolCalls: [{ id: 'call_1', name: 'update_codex', arguments: '{}' }]
    },
    { role: 'tool', content: 'Done: 3 suggestions queued', toolCallId: 'call_1' }
  ]

  it('maps input messages: system excluded, tool calls and responses as parts', () => {
    const input = toInputMessages(messages)
    expect(input).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Update the codex.' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'On it.' },
          { type: 'tool_call', id: 'call_1', name: 'update_codex', arguments: '{}' }
        ]
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_call_response', id: 'call_1', response: 'Done: 3 suggestions queued' }
        ]
      }
    ])
  })

  it('collects system messages as system_instructions', () => {
    expect(toSystemInstructions(messages)).toEqual([
      { type: 'text', content: 'You are a writing partner.' }
    ])
  })

  it('maps the streamed output with finish reason', () => {
    const out = toOutputMessages(
      'Here you go.',
      [{ id: 'c2', name: 'generate_outline', arguments: '{"scope":"novel"}' }],
      'tool_calls'
    )
    expect(out).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'Here you go.' },
          { type: 'tool_call', id: 'c2', name: 'generate_outline', arguments: '{"scope":"novel"}' }
        ],
        finish_reason: 'tool_calls'
      }
    ])
  })

  it('maps tool definitions', () => {
    const defs = toToolDefinitions([
      { name: 'update_codex', description: 'Update it', parameters: { type: 'object' } }
    ])
    expect(defs).toEqual([
      {
        type: 'function',
        name: 'update_codex',
        description: 'Update it',
        parameters: { type: 'object' }
      }
    ])
  })

  it('truncates oversized content with a marker', () => {
    const big = 'x'.repeat(40_000)
    const cut = truncate(big)
    expect(cut.length).toBeLessThan(31_000)
    expect(cut.endsWith('…[truncated]')).toBe(true)
    expect(truncate('small')).toBe('small')
  })
})
