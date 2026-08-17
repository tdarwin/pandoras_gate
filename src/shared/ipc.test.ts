import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ipcContract } from './ipc'
import { MODEL_ROLES } from './llm/catalog'

/**
 * Contract-shape guards.
 *
 * These exist because a pref added to the read side but not the write side
 * fails silently: the toggle flips, the round-trip returns the old value, and
 * the control snaps back with no error anywhere. That happened once during
 * development; this is the check that would have caught it.
 */

function keysOf(schema: z.ZodTypeAny): string[] {
  return Object.keys((schema as unknown as z.ZodObject<z.ZodRawShape>).shape).sort()
}

describe('prefs channels', () => {
  const readable = keysOf(ipcContract['prefs:get'].response)
  const writable = keysOf(ipcContract['prefs:set'].request)

  it('lets the renderer write every pref it can read', () => {
    expect(writable).toEqual(readable)
  })

  it('returns the full pref set from a write, so the store can replace state', () => {
    expect(keysOf(ipcContract['prefs:set'].response)).toEqual(readable)
  })

  it('accepts a partial write — the UI sends one changed field at a time', () => {
    const parsed = ipcContract['prefs:set'].request.safeParse({ showUnfilteredModels: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ showUnfilteredModels: true })
  })

  it('strips unknown keys rather than passing them through to writePrefs', () => {
    // The handler spreads the parsed request straight into stored prefs, so
    // this stripping is what keeps that safe.
    const parsed = ipcContract['prefs:set'].request.safeParse({
      theme: 'dark',
      somethingElse: 'nope'
    })
    expect(parsed.success && parsed.data).toEqual({ theme: 'dark' })
  })

  it('covers every model role in the roles schema', () => {
    const roleKeys = keysOf(
      (ipcContract['prefs:get'].response as unknown as z.ZodObject<z.ZodRawShape>).shape
        .modelRoles as z.ZodTypeAny
    )
    expect(roleKeys).toEqual([...MODEL_ROLES].sort())
  })
})

describe('models:catalog channel', () => {
  it('returns hardware, local entries, and hosted picks', () => {
    expect(keysOf(ipcContract['models:catalog'].response)).toEqual([
      'entries',
      'hardware',
      'hosted'
    ])
  })
})
