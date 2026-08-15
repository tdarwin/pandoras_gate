/* Structural types: just the slice of markdown-it this plugin touches —
 * keeps the module usable from both the main and renderer tsconfigs
 * without depending on markdown-it's type interop. */
interface InlineStateLike {
  src: string
  pos: number
  push: (type: string, tag: string, nesting: 1 | 0 | -1) => unknown
}
interface MarkdownItLike {
  inline: {
    ruler: {
      push: (name: string, fn: (state: InlineStateLike, silent: boolean) => boolean) => unknown
    }
  }
}

/**
 * Underline has no native markdown syntax; the editor round-trips it as
 * literal <u>…</u> pairs. This plugin makes a markdown-it instance treat
 * those pairs as real underline tokens even with html:false, so every
 * consumer of chapter markdown (the editor bridge, publishing) agrees on
 * the dialect. A "<u>" only opens when a "</u>" exists ahead — a stray tag
 * stays visible text; a stray closer is consumed harmlessly.
 */
export function underlineTags(md: MarkdownItLike): void {
  md.inline.ruler.push('u_tag', (state, silent) => {
    const { src, pos } = state
    if (src.charCodeAt(pos) !== 0x3c /* < */) return false
    if (src.startsWith('<u>', pos)) {
      if (!src.includes('</u>', pos + 3)) return false
      if (!silent) state.push('u_open', 'u', 1)
      state.pos += 3
      return true
    }
    if (src.startsWith('</u>', pos)) {
      if (!silent) state.push('u_close', 'u', -1)
      state.pos += 4
      return true
    }
    return false
  })
}
