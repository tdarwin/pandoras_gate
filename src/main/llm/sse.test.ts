import { describe, it, expect } from 'vitest'
import { SseParser } from './sse'

describe('SseParser', () => {
  it('parses a complete event', () => {
    const p = new SseParser()
    expect(p.push('data: {"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  it('handles events split across chunks at any boundary', () => {
    const full = 'data: {"hello":"world"}\n\ndata: [DONE]\n\n'
    for (let split = 1; split < full.length - 1; split++) {
      const p = new SseParser()
      const events = [...p.push(full.slice(0, split)), ...p.push(full.slice(split))]
      expect(events).toEqual(['{"hello":"world"}', '[DONE]'])
    }
  })

  it('handles multiple events in one chunk', () => {
    const p = new SseParser()
    expect(p.push('data: one\n\ndata: two\n\ndata: three\n\n')).toEqual(['one', 'two', 'three'])
  })

  it('ignores comment lines and event fields', () => {
    const p = new SseParser()
    expect(p.push(': keep-alive\n\nevent: message\ndata: payload\n\n')).toEqual(['payload'])
  })

  it('handles CRLF line endings', () => {
    const p = new SseParser()
    expect(p.push('data: crlf\r\n\r\n')).toEqual(['crlf'])
  })

  it('joins multi-line data fields', () => {
    const p = new SseParser()
    expect(p.push('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2'])
  })

  it('buffers incomplete events', () => {
    const p = new SseParser()
    expect(p.push('data: partial')).toEqual([])
    expect(p.push(' more\n\n')).toEqual(['partial more'])
  })
})
