import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeltaCoalescer } from './coalesce'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DeltaCoalescer', () => {
  it('batches pushes within the window into one emit', () => {
    const out: string[] = []
    const c = new DeltaCoalescer((t) => out.push(t), 40)
    c.push('a')
    c.push('b')
    c.push('c')
    expect(out).toEqual([])
    vi.advanceTimersByTime(40)
    expect(out).toEqual(['abc'])
  })

  it('flush() emits pending text immediately and cancels the timer', () => {
    const out: string[] = []
    const c = new DeltaCoalescer((t) => out.push(t), 40)
    c.push('hello ')
    c.push('world')
    c.flush()
    expect(out).toEqual(['hello world'])
    vi.advanceTimersByTime(100)
    expect(out).toEqual(['hello world'])
  })

  it('flush() with nothing buffered emits nothing', () => {
    const out: string[] = []
    const c = new DeltaCoalescer((t) => out.push(t), 40)
    c.flush()
    expect(out).toEqual([])
  })

  it('keeps batching across windows', () => {
    const out: string[] = []
    const c = new DeltaCoalescer((t) => out.push(t), 40)
    c.push('one')
    vi.advanceTimersByTime(40)
    c.push('two')
    vi.advanceTimersByTime(40)
    expect(out).toEqual(['one', 'two'])
  })
})
