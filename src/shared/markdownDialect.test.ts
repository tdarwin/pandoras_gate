import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { parseAttrs, serializeAttrs, EMPTY_ATTRS } from './markdownAttrs'
import { styledBlockFences } from './markdownStyledBlock'
import { fontSpans } from './markdownFontSpan'
import { underlineTags } from './markdownUnderline'

/** The app's dialect, as both the editor bridge and publisher configure it. */
function tokenizer(): ReturnType<typeof MarkdownIt> {
  return MarkdownIt('commonmark', { html: false })
    .enable(['strikethrough', 'table'])
    .use(underlineTags)
    .use(styledBlockFences)
    .use(fontSpans)
}

const types = (md: string): string[] => tokenizer().parse(md, {}).map((t) => t.type)

describe('parseAttrs / serializeAttrs', () => {
  it('parses and canonicalizes the recognized attrs', () => {
    expect(parseAttrs('align=center bg=note font="Iowan Old Style"')).toEqual({
      align: 'center',
      bg: 'note',
      font: 'Iowan Old Style',
      extra: null
    })
    // Order-independent parse; canonical order on serialize.
    const shuffled = parseAttrs('font="Garamond" align=right bg="#FFF3CD"')!
    expect(serializeAttrs(shuffled)).toBe('align=right bg="#fff3cd" font="Garamond"')
  })

  it('align=left is the default and never survives', () => {
    const attrs = parseAttrs('align=left bg=note')!
    expect(attrs.align).toBeNull()
    expect(serializeAttrs(attrs)).toBe('bg=note')
  })

  it('unrecognized attrs pass through verbatim, in order, after the known ones', () => {
    const attrs = parseAttrs('foo=bar align=center baz="q x"')!
    expect(attrs.align).toBe('center')
    expect(attrs.extra).toBe('foo=bar baz="q x"')
    expect(serializeAttrs(attrs)).toBe('align=center foo=bar baz="q x"')
  })

  it('invalid values for known keys become extra rather than vanishing', () => {
    const attrs = parseAttrs('bg=chartreuse align=diagonal')!
    expect(attrs.bg).toBeNull()
    expect(attrs.align).toBeNull()
    expect(attrs.extra).toBe('bg=chartreuse align=diagonal')
  })

  it('rejects non-attr-list text outright', () => {
    expect(parseAttrs('just some words')).toBeNull()
    expect(parseAttrs('key="unclosed')).toBeNull()
  })

  it('round-trips its own canonical output', () => {
    for (const raw of ['align=center', 'bg="#aabbcc"', 'align=right bg=warning font="A B"']) {
      expect(serializeAttrs(parseAttrs(raw)!)).toBe(raw)
    }
    expect(serializeAttrs(EMPTY_ATTRS)).toBe('')
  })
})

describe('styledBlockFences', () => {
  it('tokenizes a fenced block with attrs around its content', () => {
    const tokens = tokenizer().parse('::: {align=center bg=note}\nCentered.\n:::\n', {})
    const open = tokens.find((t) => t.type === 'styled_block_open')!
    expect(open.attrGet('align')).toBe('center')
    expect(open.attrGet('bg')).toBe('note')
    expect(types('::: {align=center}\nX.\n:::\n')).toEqual([
      'styled_block_open',
      'paragraph_open',
      'inline',
      'paragraph_close',
      'styled_block_close'
    ])
  })

  it('holds arbitrary block content', () => {
    const t = types('::: {bg=note}\n# Head\n\n- a\n- b\n:::\n')
    expect(t).toContain('heading_open')
    expect(t).toContain('bullet_list_open')
  })

  it('degrades without a closer, without attrs, or with empty braces', () => {
    // Both lines join one lazy-continuation paragraph — visible, harmless.
    expect(types('::: {align=center}\nno closer\n')).toEqual([
      'paragraph_open',
      'inline',
      'paragraph_close'
    ])
    expect(types(':::\ntext\n:::\n')).not.toContain('styled_block_open')
    expect(types('::: {}\ntext\n:::\n')).not.toContain('styled_block_open')
    expect(types('::: {not an attr list}\ntext\n:::\n')).not.toContain('styled_block_open')
  })

  it('does not nest: the first bare closer wins, the inner opener stays text', () => {
    const t = types('::: {bg=note}\na\n::: {align=center}\nb\n:::\nc\n:::\n')
    expect(t.filter((x) => x === 'styled_block_open')).toHaveLength(1)
  })

  it('leaves code fences and thematic breaks alone', () => {
    expect(types('```\n::: {bg=note}\n```\n')).toEqual(['fence'])
    expect(types('    ::: {bg=note}\n    x\n    :::\n')).toEqual(['code_block'])
  })
})

describe('fontSpans', () => {
  const inlineChildren = (md: string): string[] =>
    tokenizer()
      .parse(md, {})
      .find((t) => t.type === 'inline')!
      .children!.map((t) => t.type)

  it('tokenizes a bracketed span with a font', () => {
    const children = inlineChildren('Set in [small caps]{font="Garamond"} here.\n')
    expect(children).toEqual([
      'text',
      'pandora_font_open',
      'text',
      'pandora_font_close',
      'text'
    ])
    const inline = tokenizer()
      .parse('[x]{font="Garamond"}\n', {})
      .find((t) => t.type === 'inline')!
    const open = inline.children!.find((t) => t.type === 'pandora_font_open')!
    expect(open.attrGet('font')).toBe('Garamond')
  })

  it('keeps emphasis working inside the label', () => {
    const children = inlineChildren('[some *emphasis*]{font="Charter"}\n')
    expect(children).toContain('em_open')
    expect(children).toContain('pandora_font_open')
  })

  it('never captures real links or plain brackets', () => {
    expect(inlineChildren('[a link](https://x.example)\n')).toContain('link_open')
    expect(inlineChildren('[a link](https://x.example)\n')).not.toContain('pandora_font_open')
    expect(inlineChildren('just [brackets] here\n')).not.toContain('pandora_font_open')
    expect(inlineChildren('[label]{font=unquoted}\n')).not.toContain('pandora_font_open')
    expect(inlineChildren('[]{font="X"}\n')).not.toContain('pandora_font_open')
  })
})
