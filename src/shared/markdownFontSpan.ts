/* Structural types: the slice of markdown-it inline state this rule uses.
 * Method syntax keeps them bivariant, so the real markdown-it state stays
 * assignable despite the recursive `md.inline.tokenize` reference. */
interface TokenLike {
  attrSet(name: string, value: string): void
}
interface InlineStateLike {
  src: string
  pos: number
  posMax: number
  push(type: string, tag: string, nesting: 1 | 0 | -1): TokenLike
  md: { inline: { tokenize(state: InlineStateLike): void } }
}
interface MarkdownItLike {
  inline: {
    ruler: {
      push(name: string, fn: (state: InlineStateLike, silent: boolean) => boolean): unknown
    }
  }
}

/** The canonical suffix — font only, always double-quoted. */
const SUFFIX_RE = /^\{font="([^";{}\\]+)"\}/

/**
 * Pandoc-style bracketed span carrying a font: `[text]{font="Garamond"}`.
 * Registered after the built-ins, so real links (`[x](url)`, `[x][ref]`)
 * win first and only leftover bracket pairs are considered. An unpaired
 * bracket or a missing/malformed suffix stays literal text.
 */
export function fontSpans(md: MarkdownItLike): void {
  md.inline.ruler.push('pandora_font_span', (state, silent) => {
    // Nested spans would need silent-mode label scanning; like the link
    // rule, this construct simply doesn't match inside another's label.
    if (silent) return false
    const { src, pos } = state
    if (src.charCodeAt(pos) !== 0x5b /* [ */) return false

    // Find the matching close bracket, honoring nesting and backslashes.
    let depth = 0
    let close = -1
    for (let i = pos; i < state.posMax; i++) {
      const ch = src.charCodeAt(i)
      if (ch === 0x5c /* \ */) {
        i++
      } else if (ch === 0x5b) {
        depth++
      } else if (ch === 0x5d /* ] */) {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1 || close === pos + 1) return false

    const suffix = SUFFIX_RE.exec(src.slice(close + 1, state.posMax))
    if (!suffix) return false
    const font = suffix[1]!.trim()
    if (font === '') return false

    const open = state.push('pandora_font_open', 'span', 1)
    open.attrSet('font', font)
    const oldPos = state.pos
    const oldPosMax = state.posMax
    state.pos = pos + 1
    state.posMax = close
    state.md.inline.tokenize(state)
    state.pos = oldPos
    state.posMax = oldPosMax
    state.push('pandora_font_close', 'span', -1)
    state.pos = close + 1 + suffix[0].length
    return true
  })
}
