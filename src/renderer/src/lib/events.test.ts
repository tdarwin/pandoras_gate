// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { onIpcEvent } from './events'

type RawListener = (payload: unknown) => void

let listeners: Map<string, RawListener>
let unsubscribed: string[]

beforeEach(() => {
  listeners = new Map()
  unsubscribed = []
  const stub = {
    invoke: () => Promise.reject(new Error('not under test')),
    on: (channel: string, listener: RawListener): (() => void) => {
      listeners.set(channel, listener)
      return () => unsubscribed.push(channel)
    }
  }
  Object.defineProperty(window, 'pandora', {
    value: stub as unknown as Window['pandora'],
    configurable: true
  })
})

describe('onIpcEvent', () => {
  it('delivers payloads that match the channel schema', () => {
    const seen: unknown[] = []
    onIpcEvent('pipeline:status', (p) => seen.push(p))
    listeners.get('pipeline:status')!({ text: 'analyzing chapter 3' })
    expect(seen).toEqual([{ text: 'analyzing chapter 3' }])
  })

  it('drops malformed payloads with a warning instead of calling the listener', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: unknown[] = []
    onIpcEvent('pipeline:status', (p) => seen.push(p))
    listeners.get('pipeline:status')!({ text: 42 })
    listeners.get('pipeline:status')!(undefined)
    expect(seen).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('returns the underlying unsubscribe', () => {
    const off = onIpcEvent('proposals:changed', () => {})
    off()
    expect(unsubscribed).toEqual(['proposals:changed'])
  })
})
