import { parseAttrs, hasAnyAttr, type StyledAttrs } from './markdownAttrs'

/* Structural types: just the slice of markdown-it this plugin touches —
 * keeps the module usable from both the main and renderer tsconfigs
 * without depending on markdown-it's type interop. Method syntax matters:
 * it keeps these bivariant, so the real (richer) markdown-it state type
 * remains assignable despite the recursive `md.block.tokenize` reference. */
interface TokenLike {
  attrSet(name: string, value: string): void
  map: [number, number] | null
  markup: string
  block: boolean
}
interface BlockStateLike {
  src: string
  bMarks: number[]
  eMarks: number[]
  tShift: number[]
  sCount: number[]
  blkIndent: number
  line: number
  lineMax: number
  parentType: string
  push(type: string, tag: string, nesting: 1 | 0 | -1): TokenLike
  md: { block: { tokenize(state: BlockStateLike, start: number, end: number): void } }
}
interface MarkdownItLike {
  block: {
    ruler: {
      before(
        beforeName: string,
        name: string,
        fn: (state: BlockStateLike, startLine: number, endLine: number, silent: boolean) => boolean,
        options?: unknown
      ): unknown
    }
  }
}

const OPEN_RE = /^:::\s*\{(.*)\}\s*$/
const CLOSE_RE = /^:::\s*$/

function lineText(state: BlockStateLike, line: number): string {
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!)
}

/**
 * The Pandora styled block: a Pandoc-style fenced div carrying presentation
 * attributes, one level only —
 *
 *   ::: {align=center bg=note font="Iowan Old Style"}
 *   Any block content.
 *   :::
 *
 * An opener with no valid attr list, or with no closing `:::` ahead, is not
 * a block — the lines stay ordinary text, which is also the degrade story in
 * plain markdown viewers. Nesting is unsupported by design: the first bare
 * `:::` closes the block, so an inner opener never finds a closer of its own
 * and degrades to visible text.
 */
export function styledBlockFences(md: MarkdownItLike): void {
  md.block.ruler.before(
    'fence',
    'pandora_styled_block',
    (state, startLine, endLine, silent) => {
      // Indented four+ spaces is a code block, never a fence.
      if (state.sCount[startLine]! - state.blkIndent >= 4) return false
      const opener = OPEN_RE.exec(lineText(state, startLine))
      if (!opener) return false
      const attrs = parseAttrs(opener[1]!)
      // `::: {}` and non-attr braces stay literal: a block must carry something.
      if (!attrs || !hasAnyAttr(attrs)) return false

      let closingLine = -1
      for (let line = startLine + 1; line < endLine; line++) {
        if (state.sCount[line]! - state.blkIndent >= 4) continue
        if (CLOSE_RE.test(lineText(state, line))) {
          closingLine = line
          break
        }
      }
      if (closingLine === -1) return false
      if (silent) return true

      const openToken = state.push('styled_block_open', 'div', 1)
      openToken.markup = ':::'
      openToken.block = true
      openToken.map = [startLine, closingLine + 1]
      setAttrTokens(openToken, attrs)

      const oldParent = state.parentType
      const oldLineMax = state.lineMax
      state.parentType = 'pandora_styled_block'
      state.lineMax = closingLine
      state.md.block.tokenize(state, startLine + 1, closingLine)
      state.parentType = oldParent
      state.lineMax = oldLineMax

      const closeToken = state.push('styled_block_close', 'div', -1)
      closeToken.markup = ':::'
      closeToken.block = true
      state.line = closingLine + 1
      return true
    },
    { alt: ['paragraph', 'blockquote', 'list'] }
  )
}

function setAttrTokens(token: TokenLike, attrs: StyledAttrs): void {
  if (attrs.align) token.attrSet('align', attrs.align)
  if (attrs.bg) token.attrSet('bg', attrs.bg)
  if (attrs.font) token.attrSet('font', attrs.font)
  if (attrs.extra) token.attrSet('extra', attrs.extra)
}
