import { z } from 'zod'

/**
 * theme.yaml — a custom theme, one folder per theme under userData/themes.
 * Every field is optional: `base` names the built-in palette that fills in
 * whatever the file omits, so a two-line theme is legal and useful. Unknown
 * keys are ignored (hand-edited files must degrade, never crash).
 */

/** #rgb, #rgba, #rrggbb, or #rrggbbaa. */
const Hex = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'colors are hex, like #1d2021')

const UiColors = z.object({
  surface: Hex.optional(),
  panel: Hex.optional(),
  raised: Hex.optional(),
  line: Hex.optional(),
  lineStrong: Hex.optional(),
  ink: Hex.optional(),
  inkStrong: Hex.optional(),
  inkMuted: Hex.optional(),
  inkFaint: Hex.optional()
})

const EditorColors = z.object({
  caret: Hex.optional(),
  selection: Hex.optional(),
  heading: Hex.optional(),
  strike: Hex.optional(),
  codeBg: Hex.optional(),
  link: Hex.optional(),
  bullet: Hex.optional(),
  quote: Hex.optional(),
  quoteText: Hex.optional(),
  hr: Hex.optional()
})

const ChatColors = z.object({
  head: Hex.optional(),
  codeBg: Hex.optional(),
  preBg: Hex.optional(),
  quote: Hex.optional(),
  quoteText: Hex.optional(),
  link: Hex.optional()
})

/** Font family names are emitted into CSS — keep CSS metacharacters out. */
const FontFamily = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^;{}"\\]+$/, 'font family names cannot contain ; { } " or \\')

const EditorFont = z.object({
  family: FontFamily.optional(),
  /** px */
  size: z.number().min(10).max(28).optional(),
  lineHeight: z.number().min(1).max(3).optional(),
  /** Max line width, in rem. */
  measure: z.number().min(20).max(80).optional()
})

const Background = z.object({
  /** A file inside the theme's own folder — a bare name, no paths. */
  image: z
    .string()
    .min(1)
    .regex(/^[^/\\]+$/, 'background image must be a file in the theme folder')
    .optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** px */
  blur: z.number().min(0).max(20).optional(),
  tint: Hex.optional()
})

export const ThemeFileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  /** The built-in palette every omitted token falls back to. */
  base: z.enum(['dark', 'light']).default('dark'),
  colors: UiColors.optional(),
  editor: z
    .object({
      colors: EditorColors.optional(),
      font: EditorFont.optional(),
      background: Background.optional()
    })
    .optional(),
  ui: z.object({ font: z.object({ family: FontFamily.optional() }).optional() }).optional(),
  chat: z
    .object({
      colors: ChatColors.optional(),
      font: z.object({ family: FontFamily.optional() }).optional(),
      background: Background.optional()
    })
    .optional()
})
export type ThemeFile = z.infer<typeof ThemeFileSchema>

/** One row in the theme picker; invalid themes stay listed, disabled. */
export const ThemeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  base: z.enum(['dark', 'light']),
  valid: z.boolean(),
  /** Short, readable reason when valid is false. */
  problem: z.string().optional()
})
export type ThemeSummary = z.infer<typeof ThemeSummarySchema>

/**
 * A theme resolved to CSS custom properties, ready to inject. Keys and
 * values are shape-constrained at the IPC boundary so a hostile theme file
 * cannot smuggle CSS out of the declaration it lands in.
 */
export const ResolvedThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  base: z.enum(['dark', 'light']),
  vars: z.record(z.string().regex(/^--[a-z][a-z0-9-]*$/), z.string().regex(/^[^;{}]*$/))
})
export type ResolvedTheme = z.infer<typeof ResolvedThemeSchema>
