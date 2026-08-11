import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { computeDecorations } from './decorations'

interface DecoInfo {
  from: number
  to: number
  cls: string | null
  isReplace: boolean
  isBlock: boolean
}

function decorate(doc: string, cursor = doc.length): DecoInfo[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.min(cursor, doc.length) },
    extensions: [markdown({ base: markdownLanguage })]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  const set = computeDecorations(state, [{ from: 0, to: doc.length }]).decorations
  const out: DecoInfo[] = []
  const iter = set.iter()
  while (iter.value) {
    const spec = iter.value.spec as Record<string, unknown>
    out.push({
      from: iter.from,
      to: iter.to,
      cls: (spec['class'] as string | undefined) ?? null,
      isReplace: iter.value.constructor.name.includes('Replace') || spec['widget'] !== undefined,
      isBlock: spec['block'] === true
    })
    iter.next()
  }
  return out
}

const hidden = (d: DecoInfo[]): DecoInfo[] => d.filter((x) => x.cls === null && x.from < x.to)
const byClass = (d: DecoInfo[], cls: string): DecoInfo[] =>
  d.filter((x) => x.cls?.includes(cls) ?? false)

describe('live preview decorations', () => {
  it('styles a heading and hides its "# " prefix when the cursor is elsewhere', () => {
    const doc = '# Title\n\nBody text here.'
    const decos = decorate(doc, doc.length)
    expect(byClass(decos, 'cm-lp-h1')).toHaveLength(1)
    // "# " occupies 0..2
    expect(hidden(decos).some((d) => d.from === 0 && d.to === 2)).toBe(true)
  })

  it('reveals heading syntax when the cursor is on its line', () => {
    const doc = '# Title\n\nBody text here.'
    const decos = decorate(doc, 3)
    expect(byClass(decos, 'cm-lp-h1')).toHaveLength(1)
    expect(hidden(decos).some((d) => d.from === 0)).toBe(false)
  })

  it('styles bold and hides ** delimiters away from the cursor', () => {
    const doc = 'Some **bold** words.\n\nElsewhere.'
    const decos = decorate(doc, doc.length)
    const strongStart = doc.indexOf('**')
    expect(byClass(decos, 'cm-lp-strong')).toHaveLength(1)
    expect(hidden(decos).some((d) => d.from === strongStart && d.to === strongStart + 2)).toBe(true)
  })

  it('reveals bold delimiters when the selection touches the line', () => {
    const doc = 'Some **bold** words.\n\nElsewhere.'
    const decos = decorate(doc, 8)
    expect(byClass(decos, 'cm-lp-strong')).toHaveLength(1)
    expect(hidden(decos)).toHaveLength(0)
  })

  it('styles italics and inline code', () => {
    const doc = 'An *em* and `code` here.\n\nCursor line.'
    const decos = decorate(doc, doc.length)
    expect(byClass(decos, 'cm-lp-em')).toHaveLength(1)
    expect(byClass(decos, 'cm-lp-code')).toHaveLength(1)
  })

  it('hides link target, keeps link text styled', () => {
    const doc = 'See [the docs](https://example.com) now.\n\nCursor.'
    const decos = decorate(doc, doc.length)
    expect(byClass(decos, 'cm-lp-link')).toHaveLength(1)
    const urlStart = doc.indexOf('](')
    expect(hidden(decos).some((d) => d.from >= urlStart && d.to >= doc.indexOf(')') + 1)).toBe(true)
  })

  it('folds frontmatter into a block widget when the cursor is outside', () => {
    const doc = '---\ntitle: Test\nstatus: draft\n---\n\n# Chapter'
    const decos = decorate(doc, doc.length)
    const fm = decos.find((d) => d.isBlock)
    expect(fm).toBeDefined()
    expect(fm!.from).toBe(0)
    expect(doc.slice(0, fm!.to)).toContain('status: draft')
  })

  it('reveals raw frontmatter when the cursor is inside it', () => {
    const doc = '---\ntitle: Test\nstatus: draft\n---\n\n# Chapter'
    const decos = decorate(doc, 8)
    expect(decos.find((d) => d.isBlock)).toBeUndefined()
  })

  it('suppresses markdown styling inside the frontmatter block', () => {
    // "---" would otherwise parse as setext heading / horizontal rule.
    const doc = '---\ntitle: Test\n---\n\nBody.'
    const decos = decorate(doc, doc.length)
    expect(byClass(decos, 'cm-lp-heading')).toHaveLength(0)
  })

  it('styles blockquotes and hides the > marker away from cursor', () => {
    const doc = '> quoted wisdom\n\nCursor here.'
    const decos = decorate(doc, doc.length)
    expect(byClass(decos, 'cm-lp-blockquote').length).toBeGreaterThan(0)
    expect(hidden(decos).some((d) => d.from === 0 && d.to === 2)).toBe(true)
  })

  it('replaces --- with an hr widget away from cursor', () => {
    const doc = 'Above.\n\n---\n\nBelow, cursor here.'
    const decos = decorate(doc, doc.length)
    const hrStart = doc.indexOf('---')
    expect(decos.some((d) => d.isReplace && d.from === hrStart && d.to === hrStart + 3)).toBe(true)
  })

  it('produces no hide decorations in a plain paragraph', () => {
    const doc = 'Just ordinary prose with nothing special.'
    const decos = decorate(doc, 0)
    expect(hidden(decos)).toHaveLength(0)
  })
})
