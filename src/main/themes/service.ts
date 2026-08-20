import { app } from 'electron'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  ThemeFileSchema,
  type ThemeFile,
  type ThemeSummary,
  type ResolvedTheme
} from '../../shared/schemas/theme'
import { slugify } from '../../shared/slug'
import { fromVsCode, fromSublime, fromTmTheme } from './importers'
import { logWarn } from '../log'

/**
 * Custom themes live as folders under userData/themes — one folder per theme
 * (the folder name is the theme id), holding theme.yaml plus any image
 * assets, served to the renderer through the pandora-asset:// scheme.
 *
 * Every function takes an optional dir override so tests run on temp dirs
 * without electron.
 */

let cachedDir: string | null = null

export function themesDir(): string {
  if (!cachedDir) {
    cachedDir = join(app.getPath('userData'), 'themes')
    mkdirSync(cachedDir, { recursive: true })
  }
  return cachedDir
}

const THEME_FILE = 'theme.yaml'

/* ------------------------------------------------------------------ */
/* Reading and listing                                                 */
/* ------------------------------------------------------------------ */

function shortProblem(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0]!.slice(0, 200)
  return String(err).slice(0, 200)
}

async function readThemeFile(dir: string, id: string): Promise<ThemeFile> {
  let raw: string
  try {
    raw = await readFile(join(dir, id, THEME_FILE), 'utf8')
  } catch {
    throw new Error(`theme.yaml is missing`)
  }
  let data: unknown
  try {
    data = parseYaml(raw)
  } catch (err) {
    throw new Error(`theme.yaml is not valid YAML — ${shortProblem(err)}`)
  }
  const parsed = ThemeFileSchema.safeParse(data)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
    throw new Error(`theme.yaml — ${where}${first?.message ?? 'invalid'}`)
  }
  return parsed.data
}

/** Every theme folder, valid or not — one bad file never blanks the picker. */
export async function listThemes(dir: string = themesDir()): Promise<ThemeSummary[]> {
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ThemeSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    try {
      const theme = await readThemeFile(dir, id)
      out.push({ id, name: theme.name ?? id, base: theme.base, valid: true })
    } catch (err) {
      out.push({ id, name: id, base: 'dark', valid: false, problem: shortProblem(err) })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ */
/* Resolution: theme file → CSS custom properties                      */
/* ------------------------------------------------------------------ */

function assetUrl(id: string, file: string): string {
  return `url("pandora-asset://themes/${encodeURIComponent(id)}/${encodeURIComponent(file)}")`
}

/**
 * Pure mapping from a parsed theme to the CSS custom properties the renderer
 * injects. Beyond the 1:1 token mapping, a few tokens are derived when the
 * theme customizes their family but omits them — an imported theme usually
 * brings surface+ink and little else, and without derivation it would keep
 * the base palette's panels and lines, which clash hard. Derived values are
 * var()/color-mix() expressions so they follow the final token values.
 */
export function themeToVars(id: string, theme: ThemeFile): Record<string, string> {
  const vars: Record<string, string> = {}
  const c = theme.colors ?? {}
  const ed = theme.editor?.colors ?? {}
  const chat = theme.chat?.colors ?? {}

  const uiMap: [string | undefined, string][] = [
    [c.surface, '--t-surface'],
    [c.panel, '--t-panel'],
    [c.raised, '--t-raised'],
    [c.line, '--t-line'],
    [c.lineStrong, '--t-line-strong'],
    [c.ink, '--t-ink'],
    [c.inkStrong, '--t-ink-strong'],
    [c.inkMuted, '--t-ink-muted'],
    [c.inkFaint, '--t-ink-faint'],
    [ed.caret, '--ed-caret'],
    [ed.selection, '--ed-sel'],
    [ed.heading, '--ed-head'],
    [ed.strike, '--ed-strike'],
    [ed.codeBg, '--ed-code-bg'],
    [ed.link, '--ed-link'],
    [ed.bullet, '--ed-bullet'],
    [ed.quote, '--ed-quote'],
    [ed.quoteText, '--ed-quote-text'],
    [ed.hr, '--ed-hr'],
    [chat.head, '--chat-head'],
    [chat.codeBg, '--chat-code-bg'],
    [chat.preBg, '--chat-pre-bg'],
    [chat.quote, '--chat-quote'],
    [chat.quoteText, '--chat-quote-text'],
    [chat.link, '--chat-link']
  ]
  for (const [value, name] of uiMap) {
    if (value !== undefined) vars[name] = value
  }

  const derive = (name: string, value: string): void => {
    if (!(name in vars)) vars[name] = value
  }
  const towardsExtreme = theme.base === 'dark' ? '#ffffff' : '#000000'
  if (c.ink) {
    derive('--t-ink-strong', `color-mix(in srgb, var(--t-ink) 40%, ${towardsExtreme})`)
    derive('--t-ink-muted', 'color-mix(in srgb, var(--t-ink) 65%, var(--t-surface))')
    derive('--t-ink-faint', 'color-mix(in srgb, var(--t-ink) 45%, var(--t-surface))')
  }
  if (c.surface) {
    derive('--t-panel', 'color-mix(in srgb, var(--t-surface) 92%, #ffffff)')
    derive('--t-raised', 'color-mix(in srgb, var(--t-surface) 85%, var(--t-ink))')
    derive('--t-line', 'color-mix(in srgb, var(--t-surface) 85%, var(--t-ink))')
    derive('--t-line-strong', 'color-mix(in srgb, var(--t-surface) 75%, var(--t-ink))')
  }
  if (c.surface || c.ink) {
    derive('--ed-head', 'var(--t-ink-strong)')
    derive('--ed-strike', 'var(--t-ink-muted)')
    derive('--ed-quote', 'var(--t-line-strong)')
    derive('--ed-quote-text', 'var(--t-ink-muted)')
    derive('--ed-hr', 'var(--t-line-strong)')
    derive('--ed-code-bg', 'color-mix(in srgb, var(--t-ink) 10%, transparent)')
    derive('--chat-head', 'var(--t-ink-strong)')
    derive('--chat-code-bg', 'color-mix(in srgb, var(--t-ink) 10%, transparent)')
    derive('--chat-pre-bg', 'color-mix(in srgb, var(--t-surface) 92%, var(--t-ink))')
    derive('--chat-quote', 'var(--t-line-strong)')
    derive('--chat-quote-text', 'var(--t-ink-muted)')
  }
  if (ed.caret) derive('--ed-sel', 'color-mix(in srgb, var(--ed-caret) 25%, transparent)')
  if (ed.link) derive('--chat-link', 'var(--ed-link)')

  const edFont = theme.editor?.font
  if (edFont?.family) vars['--f-editor'] = edFont.family
  if (edFont?.size !== undefined) vars['--f-editor-size'] = `${edFont.size}px`
  if (edFont?.lineHeight !== undefined) vars['--f-editor-lh'] = String(edFont.lineHeight)
  if (edFont?.measure !== undefined) vars['--ed-measure'] = `${edFont.measure}rem`
  if (theme.ui?.font?.family) vars['--f-ui'] = theme.ui.font.family
  if (theme.chat?.font?.family) vars['--f-chat'] = theme.chat.font.family

  const bg = (
    prefix: '--ed-bg' | '--chat-bg',
    spec: { image?: string; opacity?: number; blur?: number; tint?: string } | undefined
  ): void => {
    if (!spec) return
    if (spec.image) {
      vars[`${prefix}-image`] = assetUrl(id, spec.image)
      // A busy image must not defeat legibility: when the theme sets an image
      // without its own tint/opacity, apply a readable default overlay.
      vars[`${prefix}-tint`] =
        spec.tint ?? (theme.base === 'dark' ? 'rgba(0 0 0 / 0.55)' : 'rgba(255 255 255 / 0.6)')
      if (spec.opacity !== undefined) vars[`${prefix}-opacity`] = String(spec.opacity)
    } else if (spec.tint) {
      vars[`${prefix}-tint`] = spec.tint
    }
    if (spec.blur !== undefined) vars[`${prefix}-blur`] = `${spec.blur}px`
  }
  bg('--ed-bg', theme.editor?.background)
  bg('--chat-bg', theme.chat?.background)

  return vars
}

/** Loads and resolves one theme; throws a readable error when it can't. */
export async function resolveTheme(id: string, dir: string = themesDir()): Promise<ResolvedTheme> {
  const theme = await readThemeFile(dir, id)
  return { id, name: theme.name ?? id, base: theme.base, vars: themeToVars(id, theme) }
}

/* ------------------------------------------------------------------ */
/* Import and creation                                                 */
/* ------------------------------------------------------------------ */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** chapters-style collision loop: gruvbox, gruvbox-2, gruvbox-3… */
async function freeThemeId(dir: string, name: string): Promise<string> {
  const base = slugify(name)
  let id = base
  let attempt = 2
  while (await exists(join(dir, id))) {
    id = `${base}-${attempt}`
    attempt += 1
  }
  return id
}

async function writeTheme(dir: string, id: string, theme: ThemeFile): Promise<void> {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, THEME_FILE), stringifyYaml(theme), 'utf8')
}

/**
 * Imports a theme file from another editor, writing a new theme folder.
 * Dispatch is by extension, with .json disambiguated by content.
 */
export async function importThemeFile(
  sourcePath: string,
  dir: string = themesDir()
): Promise<{ id: string }> {
  const raw = await readFile(sourcePath, 'utf8')
  const ext = extname(sourcePath).toLowerCase()
  let theme: ThemeFile
  if (ext === '.tmtheme') {
    theme = fromTmTheme(raw)
  } else if (ext === '.sublime-color-scheme') {
    theme = fromSublime(raw)
  } else if (ext === '.json' || ext === '.jsonc') {
    theme = raw.includes('"globals"') ? fromSublime(raw) : fromVsCode(raw)
  } else if (ext === '.yaml' || ext === '.yml') {
    // Already a Pandora theme — validate and copy it in.
    const parsed = ThemeFileSchema.safeParse(parseYaml(raw))
    if (!parsed.success) {
      throw new Error(`Not a valid Pandora theme file: ${parsed.error.issues[0]?.message ?? ''}`)
    }
    theme = parsed.data
  } else {
    throw new Error(`Unsupported theme format: ${ext || basename(sourcePath)}`)
  }
  const name = theme.name ?? basename(sourcePath, extname(sourcePath))
  const id = await freeThemeId(dir, name)
  await writeTheme(dir, id, { ...theme, name })
  return { id }
}

/**
 * "Save current as custom theme": a starting point the user can hand-edit.
 * From a built-in base this writes a minimal file (identical rendering, all
 * keys documented by the README); from a custom theme it copies the folder,
 * image assets included, which doubles as export — the folder is the
 * shareable artifact.
 */
export async function duplicateTheme(
  from: 'dark' | 'light' | `custom:${string}`,
  dir: string = themesDir()
): Promise<{ id: string }> {
  if (from === 'dark' || from === 'light') {
    const name = `My ${from} theme`
    const id = await freeThemeId(dir, name)
    await writeTheme(dir, id, ThemeFileSchema.parse({ name, base: from }))
    return { id }
  }
  const sourceId = from.slice('custom:'.length)
  const theme = await readThemeFile(dir, sourceId)
  const name = `${theme.name ?? sourceId} copy`
  const id = await freeThemeId(dir, name)
  await mkdir(join(dir, id), { recursive: true })
  for (const file of await readdir(join(dir, sourceId))) {
    await copyFile(join(dir, sourceId, file), join(dir, id, file))
  }
  await writeTheme(dir, id, { ...theme, name })
  return { id }
}

/* ------------------------------------------------------------------ */
/* Live reload                                                         */
/* ------------------------------------------------------------------ */

/**
 * Watches the themes folder so hand edits apply without a restart. Recursive
 * watch is unsupported on Linux — there the top-level watcher still catches
 * folder add/remove, and in-file edits apply on the next picker refresh.
 * Events are debounced: editors save with multiple fs events per write.
 */
export function watchThemes(onChange: () => void, dir: string = themesDir()): () => void {
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  const fire = (): void => {
    timer ??= setTimeout(() => {
      timer = null
      onChange()
    }, 250)
  }
  try {
    watcher = watch(dir, { recursive: process.platform !== 'linux' }, fire)
    watcher.on('error', (err) => logWarn('themes', 'theme watcher failed', err))
  } catch (err) {
    logWarn('themes', 'theme watcher could not start', err)
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
