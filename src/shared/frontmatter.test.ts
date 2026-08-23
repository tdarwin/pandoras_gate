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
    expect(doc.rawFrontmatter).toBeNull()
  })

  it('keeps an unreadable block out of the body and round-trips it verbatim', () => {
    const inner = ': not [valid yaml\n  ]: {'
    const raw = `---\n${inner}\n---\nBody.`
    const doc = parseFrontmatter(raw)
    expect(doc.data).toEqual({})
    expect(doc.rawFrontmatter).toBe(inner)
    // The block must not reach the writing surface as prose...
    expect(doc.body).toBe('Body.')
    // ...and must come back exactly as the author left it.
    expect(serializeFrontmatter(doc)).toBe(raw)
  })

  it('treats an unquoted colon as unreadable rather than as prose', () => {
    const doc = parseFrontmatter('---\ntitle: Chapter 1: The Gate\nstatus: draft\n---\nBody.')
    expect(doc.data).toEqual({})
    expect(doc.rawFrontmatter).toBe('title: Chapter 1: The Gate\nstatus: draft')
    expect(doc.body).toBe('Body.')
  })

  it('treats a list block as unreadable, not as frontmatter', () => {
    const doc = parseFrontmatter('---\n- one\n- two\n---\nBody.')
    expect(doc.data).toEqual({})
    expect(doc.rawFrontmatter).toBe('- one\n- two')
  })

  it('reads frontmatter behind a UTF-8 BOM, and drops the BOM', () => {
    const doc = parseFrontmatter('\uFEFF---\ntitle: Hi\n---\nBody.')
    expect(doc.data).toEqual({ title: 'Hi' })
    expect(doc.rawFrontmatter).toBeNull()
    expect(doc.body).toBe('Body.')
    expect(serializeFrontmatter(doc)).toBe('---\ntitle: Hi\n---\nBody.')
  })

  it('drops a BOM on a file with no frontmatter', () => {
    expect(parseFrontmatter('\uFEFFJust prose.').body).toBe('Just prose.')
  })

  it('re-reads a fixed block as fields', () => {
    const broken = parseFrontmatter('---\ntitle: Chapter 1: The Gate\n---\nBody.')
    const fixed = serializeFrontmatter({
      data: {},
      body: broken.body,
      rawFrontmatter: 'title: "Chapter 1: The Gate"'
    })
    const doc = parseFrontmatter(fixed)
    expect(doc.rawFrontmatter).toBeNull()
    expect(doc.data).toEqual({ title: 'Chapter 1: The Gate' })
  })

  it('treats an empty block as no details, not as an unreadable one', () => {
    const doc = parseFrontmatter('---\n\n---\nBody.')
    expect(doc.data).toEqual({})
    expect(doc.rawFrontmatter).toBeNull()
    expect(doc.body).toBe('Body.')
    // …and it drops out on write rather than round-tripping bare fences.
    expect(serializeFrontmatter(doc)).toBe('Body.')
  })

  it('recognizes tight empty fences as a block, not as prose', () => {
    const doc = parseFrontmatter('---\n---\nBody.')
    expect(doc.data).toEqual({})
    expect(doc.rawFrontmatter).toBeNull()
    expect(doc.body).toBe('Body.')
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
