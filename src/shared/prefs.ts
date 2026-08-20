import { z } from 'zod'

/**
 * The single source of truth for preference value sets. Main's store, the IPC
 * contract, and the Preferences UI all derive from these arrays — adding a
 * value here is the whole change; nothing else can silently drift.
 */

/** 0 = no interval (snapshot only on save/blur/switch). */
export const SNAPSHOT_INTERVALS = [0, 5, 10, 15, 20] as const

/** 0 = automatic (lean target that scales gently with the model window). */
export const CONTEXT_TARGETS = [0, 8192, 16384, 32768] as const

/** Built-in palettes; custom themes fall back to one of these. */
export const THEME_BASES = ['dark', 'light', 'system'] as const

export type SnapshotInterval = (typeof SNAPSHOT_INTERVALS)[number]
export type ContextTarget = (typeof CONTEXT_TARGETS)[number]
export type ThemeBase = (typeof THEME_BASES)[number]

/** A built-in base, or `custom:<id>` naming a folder in the themes dir. */
export type ThemePref = ThemeBase | `custom:${string}`

/** Theme folder ids are slugs; the `custom:` prefix keeps the pref one field. */
export const CUSTOM_THEME_RE = /^custom:[a-z0-9][a-z0-9-]*$/

export const SnapshotIntervalSchema = z.literal(
  SNAPSHOT_INTERVALS
) satisfies z.ZodType<SnapshotInterval>

export const ContextTargetSchema = z.literal(CONTEXT_TARGETS) satisfies z.ZodType<ContextTarget>

export const ThemePrefSchema = z.union([
  z.enum(THEME_BASES),
  z.custom<`custom:${string}`>((v) => typeof v === 'string' && CUSTOM_THEME_RE.test(v), {
    message: 'expected dark, light, system, or custom:<theme-id>'
  })
]) satisfies z.ZodType<ThemePref>

/*
 * Appearance overrides: null = use the active theme's value. They sit on top
 * of whatever theme is selected, so built-in-theme users can set fonts too.
 * Values are emitted into CSS — the family regex keeps metacharacters out.
 */
export const EditorFontFamilySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^;{}"\\]+$/, 'font family names cannot contain ; { } " or \\')
  .nullable()
/** px */
export const EditorFontSizeSchema = z.number().min(10).max(28).nullable()
export const EditorLineHeightSchema = z.number().min(1).max(3).nullable()
/** Max line width, in rem. */
export const EditorMeasureSchema = z.number().min(20).max(80).nullable()
