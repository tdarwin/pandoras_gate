import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { baseExtensions } from './extensions'
import { markdownToDoc, docToMarkdown } from './markdown'

const schema = getSchema(baseExtensions())

/** One full normalize pass. */
const roundTrip = (md: string): string => docToMarkdown(markdownToDoc(schema, md))

describe('markdown bridge', () => {
  it('round-trips normalized prose byte-for-byte', () => {
    const md = [
      '# Chapter One',
      '',
      'The wind howled over the **iron** gate, and *Kael* stepped through. His ~~fear~~ resolve held.',
      '',
      'She whispered the word `qi` and the [gate](https://example.com) shuddered.',
      '',
      '> A prophecy spoken in the dark.',
      '',
      '---',
      '',
      '- first omen',
      '- second omen',
      '',
      '1. wake',
      '2. climb',
      '',
      '```txt',
      'STR 12',
      'AGI 9',
      '```',
      ''
    ].join('\n')
    expect(roundTrip(md)).toBe(md)
  })

  it('is idempotent even when input needs normalizing', () => {
    const messy = [
      'Heading',
      '=======',
      '',
      '* star bullet',
      '* another',
      '',
      'Emphasis with _underscores_ and __double__.',
      '',
      'A literal 3 * 4 stays put.'
    ].join('\n')
    const once = roundTrip(messy)
    const twice = roundTrip(once)
    expect(twice).toBe(once)
    // Normalization lands on house style.
    expect(once).toContain('# Heading')
    expect(once).toContain('- star bullet')
    expect(once).toContain('*underscores*')
    expect(once).toContain('**double**')
  })

  it('keeps hard breaks and images', () => {
    const md = 'line one\\\nline two\n\n![the gate](gate.png)\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('preserves ordered-list start numbers', () => {
    const md = '3. third\n4. fourth\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('widens code fences around embedded backticks', () => {
    const doc = markdownToDoc(schema, '```\ncode\n```\n')
    expect(docToMarkdown(doc)).toBe('```\ncode\n```\n')
    const nested = roundTrip('````\na ``` fence inside\n````\n')
    expect(nested).toBe('````\na ``` fence inside\n````\n')
  })

  it('treats raw HTML as literal text, not markup', () => {
    const out = roundTrip('a <b>tag</b> here\n')
    expect(out).toContain('tag')
    expect(markdownToDoc(schema, '<div>block</div>').textContent).toContain('block')
  })

  it('round-trips underline as literal <u> tags', () => {
    const md = 'He said it <u>mattered</u> to him.\n'
    expect(roundTrip(md)).toBe(md)
    const doc = markdownToDoc(schema, md)
    let underlined = ''
    doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'underline')) {
        underlined += node.text
      }
    })
    expect(underlined).toBe('mattered')
  })

  it('keeps a stray <u> without a closer as plain text', () => {
    const out = roundTrip('an unpaired <u> tag\n')
    expect(out).toContain('<u>')
    expect(markdownToDoc(schema, 'an unpaired <u> tag').textContent).toContain('<u>')
  })

  it('round-trips GFM tables byte-for-byte', () => {
    const md = [
      '| Stat | Value |',
      '| --- | --- |',
      '| STR | 12 |',
      '| AGI | 9 |',
      ''
    ].join('\n')
    expect(roundTrip(md)).toBe(md)
    expect(roundTrip(roundTrip(md))).toBe(md)
  })

  it('parses tables into real table nodes with header cells', () => {
    const doc = markdownToDoc(schema, '| a | b |\n| --- | --- |\n| **1** | 2 |\n')
    let tables = 0
    let headers = 0
    doc.descendants((node) => {
      if (node.type.name === 'table') tables += 1
      if (node.type.name === 'tableHeader') headers += 1
    })
    expect(tables).toBe(1)
    expect(headers).toBe(2)
    // Inline marks inside cells survive.
    expect(roundTrip('| a | b |\n| --- | --- |\n| **1** | 2 |\n')).toContain('**1**')
  })

  it('escapes pipes inside table cells', () => {
    const md = '| a | b |\n| --- | --- |\n| one \\| two | 2 |\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('handles empty documents', () => {
    expect(docToMarkdown(markdownToDoc(schema, ''))).toBe('')
    expect(docToMarkdown(markdownToDoc(schema, '   \n'))).toBe('')
  })

  it('never loses text when parsing fails structurally', () => {
    // Whatever happens, the words survive somewhere in the document.
    const weird = '```\nan unclosed fence swallows the rest\n\nplain closing line'
    const doc = markdownToDoc(schema, weird)
    expect(doc.textContent).toContain('plain closing line')
  })
})

describe('pandora dialect', () => {
  it('round-trips every styled-block form byte-for-byte, twice', () => {
    const cases = [
      '::: {align=center}\nA centered epigraph.\n:::\n',
      '::: {align=right}\n— K.V.\n:::\n',
      '::: {bg=note}\nSystem message.\n:::\n',
      '::: {bg="#fff3cd"}\nExact tint.\n:::\n',
      '::: {align=center bg=warning font="Iowan Old Style"}\nAll three.\n:::\n',
      '::: {bg=note}\n# Head inside\n\n- a list\n- item\n:::\n',
      'Before.\n\n::: {align=center}\nBoxed.\n:::\n\nAfter.\n'
    ]
    for (const md of cases) {
      expect(roundTrip(md)).toBe(md)
      expect(roundTrip(roundTrip(md))).toBe(md)
    }
  })

  it('parses a styled block into a real node with its attrs', () => {
    const doc = markdownToDoc(schema, '::: {align=center bg=note}\nText.\n:::\n')
    let found: Record<string, unknown> | null = null
    doc.descendants((node) => {
      if (node.type.name === 'styledBlock') found = node.attrs
    })
    expect(found).toMatchObject({ align: 'center', bg: 'note', font: null })
    // The regression guard: the dialect must never trip the plain-text
    // fallback — that would degrade a whole chapter to bare paragraphs.
    expect(doc.firstChild!.type.name).toBe('styledBlock')
  })

  it('normalizes non-canonical attr forms on the first pass, then holds', () => {
    const messy = '::: {font="Garamond" align=left bg="#FFF3CD"}\nText.\n:::\n'
    const once = roundTrip(messy)
    expect(once).toBe('::: {bg="#fff3cd" font="Garamond"}\nText.\n:::\n')
    expect(roundTrip(once)).toBe(once)
  })

  it('passes unknown attrs through verbatim', () => {
    const md = '::: {align=center epigraph=true}\nKept.\n:::\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('leaves degenerate fences as literal text', () => {
    for (const md of [
      '::: {align=center}\nno closer here\n',
      ':::\nbare fences\n:::\n',
      '::: {}\nempty braces\n:::\n'
    ]) {
      const doc = markdownToDoc(schema, md)
      let styled = 0
      doc.descendants((node) => {
        if (node.type.name === 'styledBlock') styled += 1
      })
      expect(styled).toBe(0)
      expect(doc.textContent).toContain(md.includes('closer') ? 'no closer' : md.split('\n')[1]!)
    }
  })

  it('round-trips font spans, alone and with inner emphasis', () => {
    for (const md of [
      'Set in [small caps]{font="Garamond"} mid-sentence.\n',
      '[A *styled* run]{font="Charter"}\n'
    ]) {
      expect(roundTrip(md)).toBe(md)
      expect(roundTrip(roundTrip(md))).toBe(md)
    }
  })

  it('font spans coexist with links and plain brackets', () => {
    const md = 'A [link](https://x.example) and [plain] brackets.\n'
    const out = roundTrip(md)
    expect(out).toContain('[link](https://x.example)')
    expect(out).toContain('plain')
    expect(roundTrip(out)).toBe(out)
  })

  it('documents without the dialect are untouched', () => {
    const md = '# Plain\n\nJust prose with **bold** and a [link](https://x.example).\n'
    expect(roundTrip(md)).toBe(md)
  })
})
