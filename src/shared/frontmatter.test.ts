import { describe, it, expect } from 'vitest'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import { slugify, chapterPrefix } from './slug'

describe('parseFrontmatter', () => {
  it('splits frontmatter and body', () => {
    const doc = parseFrontmatter('---\ntitle: Hi\nstatus: draft\n---\nBody text.\n')
    expect(doc.data).toEqual({ title: 'Hi', status: 'draft' })
    expect(doc.body).toBe('Body text.\n')
  })

  it('returns whole text as body when no frontmatter', () => {
    const doc = parseFrontmatter('Just prose.')
    expect(doc.data).toEqual({})
    expect(doc.body).toBe('Just prose.')
  })

  it('keeps malformed YAML in the body instead of dropping it', () => {
    const raw = '---\n: not [valid yaml\n  ]: {\n---\nBody.'
    const doc = parseFrontmatter(raw)
    expect(doc.body).toBe(raw)
  })

  it('roundtrips through serialize', () => {
    const original = '---\ntitle: Roundtrip\nstatus: final\n---\nSome **markdown**.\n'
    const doc = parseFrontmatter(original)
    expect(serializeFrontmatter(doc)).toBe(original)
  })

  it('serializes empty data as bare body', () => {
    expect(serializeFrontmatter({ data: {}, body: 'plain' })).toBe('plain')
  })
})

describe('slugify', () => {
  it('lowercases, strips punctuation, and hyphenates', () => {
    expect(slugify('The Iron Gate!')).toBe('the-iron-gate')
    expect(slugify('  Chapter #12: Rise & Fall  ')).toBe('chapter-12-rise-fall')
  })

  it('strips diacritics', () => {
    expect(slugify('Café Été')).toBe('cafe-ete')
  })

  it('falls back to "untitled"', () => {
    expect(slugify('!!!')).toBe('untitled')
  })
})

describe('chapterPrefix', () => {
  it('zero-pads to three digits', () => {
    expect(chapterPrefix(1)).toBe('001')
    expect(chapterPrefix(42)).toBe('042')
    expect(chapterPrefix(1000)).toBe('1000')
  })
})
