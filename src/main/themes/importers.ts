import { ThemeFileSchema, type ThemeFile } from '../../shared/schemas/theme'

/**
 * Importers: other editors' theme formats → a Pandora theme file. Each takes
 * the raw file text and returns a ThemeFile, or throws a one-line readable
 * error. Only what maps cleanly is mapped; everything else falls back to the
 * base palette chosen from the theme's background luminance.
 */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function hexOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim().toLowerCase() : undefined
}

/** dark|light from the background's relative luminance. */
function baseFromBackground(hex: string | undefined): 'dark' | 'light' {
  if (!hex) return 'dark'
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum < 0.5 ? 'dark' : 'light'
}

/**
 * VS Code (and Sublime) theme files are routinely JSONC: comments and
 * trailing commas. A char-walk keeps string contents intact.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // Trailing commas before a closing brace/bracket.
  return out.replace(/,\s*([}\]])/g, '$1')
}

function parseJsonc(text: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`Couldn't read this file as a ${what} — is it the right format?`)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Foreground for the first tokenColors entry whose scope mentions `needle`. */
function scopeForeground(tokenColors: unknown, needle: string): string | undefined {
  if (!Array.isArray(tokenColors)) return undefined
  for (const entry of tokenColors) {
    const e = record(entry)
    const scope = e['scope']
    const scopes =
      typeof scope === 'string' ? [scope] : Array.isArray(scope) ? scope.filter((s) => typeof s === 'string') : []
    if (scopes.some((s) => (s as string).includes(needle))) {
      const fg = record(e['settings'])['foreground']
      const hex = hexOrUndefined(fg)
      if (hex) return hex
    }
  }
  return undefined
}

function prune<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined
}

function buildTheme(input: {
  name: string | undefined
  surface: string | undefined
  colors: Record<string, string | undefined>
  editorColors: Record<string, string | undefined>
}): ThemeFile {
  const candidate = {
    ...(input.name ? { name: input.name } : {}),
    base: baseFromBackground(input.surface),
    ...(prune(input.colors) ? { colors: prune(input.colors) } : {}),
    ...(prune(input.editorColors) ? { editor: { colors: prune(input.editorColors) } } : {}),
    ...(input.editorColors['link'] ? { chat: { colors: { link: input.editorColors['link'] } } } : {})
  }
  const parsed = ThemeFileSchema.safeParse(candidate)
  if (!parsed.success) throw new Error('The imported colors did not map to a usable theme.')
  return parsed.data
}

/** VS Code .json color theme. */
export function fromVsCode(text: string): ThemeFile {
  const json = parseJsonc(text, 'VS Code color theme')
  const colors = record(json['colors'])
  const surface = hexOrUndefined(colors['editor.background'])
  if (!surface && !hexOrUndefined(colors['editor.foreground'])) {
    throw new Error("This JSON has no editor colors — it doesn't look like a VS Code color theme.")
  }
  return buildTheme({
    name: typeof json['name'] === 'string' ? json['name'] : undefined,
    surface,
    colors: {
      surface,
      ink: hexOrUndefined(colors['editor.foreground']),
      panel: hexOrUndefined(colors['sideBar.background']),
      raised: hexOrUndefined(colors['panel.background']),
      line: hexOrUndefined(colors['editorGroup.border']) ?? hexOrUndefined(colors['panel.border']),
      lineStrong: hexOrUndefined(colors['focusBorder']),
      inkMuted: hexOrUndefined(colors['descriptionForeground']),
      inkFaint: hexOrUndefined(colors['editorLineNumber.foreground'])
    },
    editorColors: {
      caret: hexOrUndefined(colors['editorCursor.foreground']),
      selection: hexOrUndefined(colors['editor.selectionBackground']),
      link: hexOrUndefined(colors['textLink.foreground']),
      heading: scopeForeground(json['tokenColors'], 'markup.heading'),
      quoteText: scopeForeground(json['tokenColors'], 'markup.quote')
    }
  })
}

/** Sublime .sublime-color-scheme (JSON with a `globals` map). */
export function fromSublime(text: string): ThemeFile {
  const json = parseJsonc(text, 'Sublime color scheme')
  const globals = record(json['globals'])
  const surface = hexOrUndefined(globals['background'])
  if (!surface && !hexOrUndefined(globals['foreground'])) {
    throw new Error("This JSON has no globals colors — it doesn't look like a Sublime color scheme.")
  }
  const accent = hexOrUndefined(globals['accent'])
  return buildTheme({
    name: typeof json['name'] === 'string' ? json['name'] : undefined,
    surface,
    colors: {
      surface,
      ink: hexOrUndefined(globals['foreground']),
      panel: hexOrUndefined(globals['gutter']),
      raised: hexOrUndefined(globals['line_highlight'])
    },
    editorColors: {
      caret: hexOrUndefined(globals['caret']),
      selection: hexOrUndefined(globals['selection']),
      link: accent,
      bullet: accent
    }
  })
}

/* ------------------------------------------------------------------ */
/* Legacy .tmTheme (XML plist)                                         */
/* ------------------------------------------------------------------ */

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue }

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

interface Tag {
  name: string
  closing: boolean
  selfClosing: boolean
  text: string
}

/**
 * Just enough plist to read machine-generated .tmTheme files: dict, array,
 * key, string, and the scalar tags, over a flat tag scan. Not a general XML
 * parser and not meant to be one — anything surprising throws, and the
 * caller turns that into "couldn't read this theme file".
 */
export function parsePlist(xml: string): PlistValue {
  const tags: Tag[] = []
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<\?[^?]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|([^<]+)/g
  let m: RegExpExecArray | null
  let pendingText = ''
  while ((m = re.exec(xml)) !== null) {
    if (m[5] !== undefined) {
      pendingText += m[5]
      continue
    }
    if (m[2] === undefined) continue
    tags.push({ name: m[2], closing: m[1] === '/', selfClosing: m[4] === '/', text: '' })
    if (tags.length >= 2 && tags[tags.length - 1]!.closing) {
      tags[tags.length - 2]!.text = pendingText
    }
    pendingText = ''
  }

  let pos = 0
  function parseValue(): PlistValue {
    const tag = tags[pos]
    if (!tag || tag.closing) throw new Error('malformed plist')
    if (tag.name === 'plist') {
      pos++
      const value = parseValue()
      if (tags[pos]?.name === 'plist' && tags[pos]?.closing) pos++
      return value
    }
    if (tag.name === 'dict') {
      if (tag.selfClosing) {
        pos++
        return {}
      }
      pos++
      const dict: { [key: string]: PlistValue } = {}
      while (tags[pos] && !(tags[pos]!.name === 'dict' && tags[pos]!.closing)) {
        const keyTag = tags[pos]
        if (keyTag?.name !== 'key') throw new Error('malformed plist')
        pos++
        if (!(tags[pos]?.name === 'key' && tags[pos]?.closing)) throw new Error('malformed plist')
        const key = decodeEntities(keyTag.text)
        pos++
        dict[key] = parseValue()
      }
      pos++
      return dict
    }
    if (tag.name === 'array') {
      if (tag.selfClosing) {
        pos++
        return []
      }
      pos++
      const arr: PlistValue[] = []
      while (tags[pos] && !(tags[pos]!.name === 'array' && tags[pos]!.closing)) {
        arr.push(parseValue())
      }
      pos++
      return arr
    }
    if (tag.name === 'string' || tag.name === 'integer' || tag.name === 'real' || tag.name === 'data') {
      if (tag.selfClosing) {
        pos++
        return ''
      }
      pos++
      if (!(tags[pos]?.name === tag.name && tags[pos]?.closing)) throw new Error('malformed plist')
      pos++
      return decodeEntities(tag.text)
    }
    if (tag.name === 'true' || tag.name === 'false') {
      pos++
      return tag.name === 'true'
    }
    throw new Error('malformed plist')
  }

  return parseValue()
}

/** Legacy TextMate/Sublime .tmTheme. */
export function fromTmTheme(text: string): ThemeFile {
  let root: PlistValue
  try {
    root = parsePlist(text)
  } catch {
    throw new Error("Couldn't read this file as a .tmTheme — is it the right format?")
  }
  const dict = record(root)
  const settings = dict['settings']
  if (!Array.isArray(settings) || settings.length === 0) {
    throw new Error("This plist has no settings array — it doesn't look like a .tmTheme.")
  }
  const global = record(record(settings[0])['settings'])
  const surface = hexOrUndefined(global['background'])
  if (!surface && !hexOrUndefined(global['foreground'])) {
    throw new Error("This .tmTheme has no global colors — it doesn't look like a color theme.")
  }

  const scoped = (needle: string): string | undefined => {
    for (const entry of settings.slice(1)) {
      const e = record(entry)
      if (typeof e['scope'] === 'string' && e['scope'].includes(needle)) {
        const hex = hexOrUndefined(record(e['settings'])['foreground'])
        if (hex) return hex
      }
    }
    return undefined
  }

  return buildTheme({
    name: typeof dict['name'] === 'string' ? dict['name'] : undefined,
    surface,
    colors: {
      surface,
      ink: hexOrUndefined(global['foreground'])
    },
    editorColors: {
      caret: hexOrUndefined(global['caret']),
      selection: hexOrUndefined(global['selection']),
      heading: scoped('markup.heading'),
      quoteText: scoped('markup.quote')
    }
  })
}
