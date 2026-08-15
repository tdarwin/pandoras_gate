import { describe, it, expect } from 'vitest'
import { chapterHtml, chapterPlainText, stripLeadingTitle } from './profiles'

const CHAPTER = [
  '# The Iron Gate',
  '',
  'Kael crept through the ruins, his *breath* shallow and his **grip** tight.',
  '',
  '---',
  '',
  '### Status',
  '',
  '| Stat | Value |',
  '| --- | --- |',
  '| STR | 12 |',
  '',
  '> The gate remembers.',
  ''
].join('\n')

describe('chapterHtml — royalroad', () => {
  it('keeps hr scene breaks and renders tables', () => {
    const html = chapterHtml(CHAPTER, 'royalroad', 'The Iron Gate')
    expect(html).toContain('<hr>')
    expect(html).toContain('<em>breath</em>')
    expect(html).toContain('<strong>grip</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<h3>Status</h3>')
  })

  it('treats raw HTML in prose as literal text', () => {
    const html = chapterHtml('a <script>alert(1)</script> tag', 'royalroad')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders the editor’s underline pairs as real underline', () => {
    const md = 'The runes ~~<u>burned cold</u>~~ tonight.\n'
    const html = chapterHtml(md, 'royalroad')
    expect(html).toContain('<u>burned cold</u>')
    expect(html).not.toContain('&lt;u&gt;')
    // Both flavors stay clean: plain text drops the tags entirely.
    expect(chapterPlainText(md)).toBe('The runes burned cold tonight.')
    // A stray unpaired tag is still literal prose, not markup.
    expect(chapterHtml('an unpaired <u> tag', 'royalroad')).toContain('&lt;u&gt;')
  })
})

describe('chapterHtml — patreon', () => {
  it('replaces hr with a * * * paragraph and demotes deep headings', () => {
    const html = chapterHtml(CHAPTER, 'patreon', 'The Iron Gate')
    expect(html).not.toContain('<hr>')
    expect(html).toContain('<p>* * *</p>')
    expect(html).not.toContain('<h3>')
    expect(html).toContain('<p><strong>Status</strong></p>')
  })

  it('keeps h1 and h2', () => {
    const html = chapterHtml('# Big\n\n## Smaller\n\n### Deep\n', 'patreon')
    expect(html).toContain('<h1>Big</h1>')
    expect(html).toContain('<h2>Smaller</h2>')
    expect(html).toContain('<p><strong>Deep</strong></p>')
  })
})

describe('stripLeadingTitle', () => {
  it('drops a leading H1 matching the chapter title, case-insensitively', () => {
    expect(stripLeadingTitle('# The Iron Gate\n\nProse.', 'the iron gate')).toBe('Prose.')
    expect(stripLeadingTitle('\n\n# The Iron Gate #\n\nProse.', 'The Iron Gate')).toBe('Prose.')
  })

  it('keeps headings that are not the title, and deeper headings', () => {
    expect(stripLeadingTitle('# Prologue\n\nProse.', 'The Iron Gate')).toContain('# Prologue')
    expect(stripLeadingTitle('## The Iron Gate\n\nProse.', 'The Iron Gate')).toContain(
      '## The Iron Gate'
    )
  })

  it('is applied by both renderers', () => {
    expect(chapterHtml('# The Iron Gate\n\nProse.', 'royalroad', 'The Iron Gate')).not.toContain(
      '<h1>'
    )
  })
})

describe('chapterPlainText', () => {
  it('produces readable text with no tags or entities', () => {
    const text = chapterPlainText(CHAPTER, 'The Iron Gate')
    expect(text).not.toMatch(/<[^>]+>/)
    expect(text).toContain('Kael crept through the ruins, his breath shallow and his grip tight.')
    expect(text).toContain('* * *')
    expect(text).toContain('The gate remembers.')
    expect(text).not.toContain('The Iron Gate')
  })

  it('renders lists as dashes and decodes entities', () => {
    const text = chapterPlainText('- first "quoted" & more\n- second\n')
    expect(text).toContain('- first "quoted" & more')
    expect(text).toContain('- second')
  })
})
