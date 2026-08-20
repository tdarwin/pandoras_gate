import { describe, it, expect } from 'vitest'
import {
  SNAPSHOT_INTERVALS,
  CONTEXT_TARGETS,
  THEME_BASES,
  SnapshotIntervalSchema,
  ContextTargetSchema,
  ThemePrefSchema
} from './prefs'

describe('shared pref value sets', () => {
  it('interval schema accepts exactly the declared values', () => {
    for (const v of SNAPSHOT_INTERVALS) {
      expect(SnapshotIntervalSchema.safeParse(v).success).toBe(true)
    }
    expect(SnapshotIntervalSchema.safeParse(7).success).toBe(false)
    expect(SnapshotIntervalSchema.safeParse('5').success).toBe(false)
  })

  it('context target schema accepts exactly the declared values', () => {
    for (const v of CONTEXT_TARGETS) {
      expect(ContextTargetSchema.safeParse(v).success).toBe(true)
    }
    expect(ContextTargetSchema.safeParse(4096).success).toBe(false)
  })

  it('theme schema accepts the built-in bases', () => {
    for (const v of THEME_BASES) {
      expect(ThemePrefSchema.safeParse(v).success).toBe(true)
    }
  })

  it('theme schema accepts custom:<slug> ids', () => {
    expect(ThemePrefSchema.safeParse('custom:gruvbox').success).toBe(true)
    expect(ThemePrefSchema.safeParse('custom:gruvbox-warm-2').success).toBe(true)
  })

  it('theme schema rejects malformed values', () => {
    for (const bad of ['custom:', 'custom:Gruvbox', 'custom:-x', 'custom:a/b', 'blue', 42, null]) {
      expect(ThemePrefSchema.safeParse(bad).success).toBe(false)
    }
  })
})
