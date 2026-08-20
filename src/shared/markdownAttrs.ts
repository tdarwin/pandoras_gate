/**
 * The attribute list of the Pandora dialect: `{align=center bg=note
 * font="Iowan Old Style"}` on fenced styled blocks, `{font="…"}` on spans.
 *
 * Round-trip byte-stability requires ONE canonical form, produced by
 * serializeAttrs: fixed key order (align, bg, font, then unrecognized
 * attrs verbatim), named tints bare, hex lowercase double-quoted, fonts
 * double-quoted, `align=left` never emitted (it is the default). Anything
 * unrecognized parses into `extra` and re-emits verbatim — nothing a user
 * wrote is ever dropped.
 */

export const NAMED_TINTS = ['note', 'success', 'warning', 'danger', 'neutral'] as const
export type NamedTint = (typeof NAMED_TINTS)[number]

export interface StyledAttrs {
  align: 'center' | 'right' | null
  /** A named tint, or lowercase #hex. */
  bg: string | null
  font: string | null
  /** Unrecognized attrs, verbatim and order-preserved. */
  extra: string | null
}

export const EMPTY_ATTRS: StyledAttrs = { align: null, bg: null, font: null, extra: null }

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** Font values land in CSS font-family — keep metacharacters out. */
const FONT_RE = /^[^;{}"\\]+$/

export function isNamedTint(value: string): value is NamedTint {
  return (NAMED_TINTS as readonly string[]).includes(value)
}

export function isValidBg(value: string): boolean {
  return isNamedTint(value) || HEX_RE.test(value)
}

/** One `key=value` or `key="value"` pair. */
const PAIR_RE = /^([a-zA-Z][a-zA-Z0-9-]*)=(?:"([^"]*)"|([^\s"]+))/

/**
 * Parses the text between the braces. Returns null when it isn't an
 * attribute list at all (the construct then stays literal text); an empty
 * or all-unrecognized list still parses, into `extra`.
 */
export function parseAttrs(raw: string): StyledAttrs | null {
  const attrs: StyledAttrs = { ...EMPTY_ATTRS }
  const extras: string[] = []
  let rest = raw.trim()
  while (rest !== '') {
    const m = PAIR_RE.exec(rest)
    if (!m) return null
    const [pair, key, quoted, bare] = m
    const value = quoted ?? bare ?? ''
    if (key === 'align' && attrs.align === null && (value === 'center' || value === 'right')) {
      attrs.align = value
    } else if (key === 'align' && value === 'left') {
      // The default — normalized away.
    } else if (key === 'bg' && attrs.bg === null && isValidBg(value)) {
      attrs.bg = isNamedTint(value) ? value : value.toLowerCase()
    } else if (key === 'font' && attrs.font === null && value.trim() !== '' && FONT_RE.test(value)) {
      attrs.font = value.trim()
    } else {
      extras.push(pair!)
    }
    rest = rest.slice(pair!.length).trimStart()
  }
  attrs.extra = extras.length > 0 ? extras.join(' ') : null
  return attrs
}

/** The canonical on-disk form; '' when every field is null. */
export function serializeAttrs(attrs: StyledAttrs): string {
  const parts: string[] = []
  if (attrs.align) parts.push(`align=${attrs.align}`)
  if (attrs.bg) parts.push(isNamedTint(attrs.bg) ? `bg=${attrs.bg}` : `bg="${attrs.bg}"`)
  if (attrs.font) parts.push(`font="${attrs.font}"`)
  if (attrs.extra) parts.push(attrs.extra)
  return parts.join(' ')
}

export function hasAnyAttr(attrs: StyledAttrs): boolean {
  return attrs.align !== null || attrs.bg !== null || attrs.font !== null || attrs.extra !== null
}
