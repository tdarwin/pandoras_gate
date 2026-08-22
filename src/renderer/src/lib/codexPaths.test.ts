import { describe, it, expect } from 'vitest'
import { codexSection, codexOrder, novelOrder, nextPendingPath } from './codexPaths'

const LISTING = {
  characters: [{ file: 'metadata/characters/kael-voss.md' }],
  world: [{ file: 'metadata/world/cultivation.md' }],
  summaries: [{ file: 'metadata/summaries/001-the-iron-gate.md' }],
  outlines: [{ file: 'outlines/novel.md' }, { file: 'outlines/001-the-iron-gate.md' }],
  reviews: [{ file: 'metadata/reviews/2026-08-21-fact-check-001.md' }],
  hasSynopsis: true,
  hasGlossary: true,
  hasTimeline: true
}

describe('codexSection', () => {
  it('places every path shape the Codex browser draws', () => {
    expect(codexSection('metadata/synopsis.md')).toBe('story')
    expect(codexSection('metadata/glossary.md')).toBe('story')
    expect(codexSection('metadata/timeline.yaml')).toBe('story')
    expect(codexSection('outlines/novel.md')).toBe('outlines')
    expect(codexSection('outlines/001-the-iron-gate.md')).toBe('outlines')
    expect(codexSection('metadata/characters/kael-voss.md')).toBe('characters')
    expect(codexSection('metadata/world/cultivation.md')).toBe('world')
    expect(codexSection('metadata/summaries/001-the-iron-gate.md')).toBe('summaries')
    expect(codexSection('metadata/reviews/2026-08-21-fact-check-001.md')).toBe('reviews')
  })

  it('is null for chapters and for anything else', () => {
    expect(codexSection('chapters/001-the-iron-gate.md')).toBeNull()
    expect(codexSection('novel.yaml')).toBeNull()
  })

  it('gives every path the proposal allowlist accepts somewhere to live', () => {
    // isAllowedProposalPath permits any metadata/*.md or metadata/<dir>/*.md.
    // A path counted in the badges but drawn nowhere is a dot you cannot
    // reach: no row, and the walk skips straight past it.
    for (const path of [
      'metadata/notes.md',
      'metadata/locations/the-gate.md',
      'metadata/factions/the-order.md'
    ]) {
      expect(codexSection(path)).not.toBeNull()
    }
  })
})

describe('codexOrder', () => {
  it('renders sections in browser order', () => {
    expect(codexOrder(LISTING, [])).toEqual([
      'metadata/synopsis.md',
      'metadata/glossary.md',
      'metadata/timeline.yaml',
      'outlines/novel.md',
      'outlines/001-the-iron-gate.md',
      'metadata/characters/kael-voss.md',
      'metadata/world/cultivation.md',
      'metadata/summaries/001-the-iron-gate.md',
      'metadata/reviews/2026-08-21-fact-check-001.md'
    ])
  })

  it('draws a path with no section of its own under Other', () => {
    const order = codexOrder(LISTING, ['metadata/locations/the-gate.md'])
    expect(order).toContain('metadata/locations/the-gate.md')
    // Last, after every named section.
    expect(order[order.length - 1]).toBe('metadata/locations/the-gate.md')
  })

  it('walks an UPDATE at such a path, not only a create', () => {
    // metadata:list has no bucket for these, so the listing never mentions
    // them whether or not the file exists — the pending set is the only
    // source, and dropping updates left a badge nothing could reach.
    const order = codexOrder(LISTING, ['metadata/notes.md'])
    expect(nextPendingPath(order, new Set(['metadata/notes.md']), null)).toBe('metadata/notes.md')
  })

  it('slots a not-yet-created document into its own section', () => {
    const order = codexOrder(LISTING, ['metadata/characters/mara-din.md'])
    expect(order.indexOf('metadata/characters/mara-din.md')).toBe(
      order.indexOf('metadata/characters/kael-voss.md') + 1
    )
  })

  it('does not duplicate a path that already exists on disk', () => {
    const order = codexOrder(LISTING, ['metadata/characters/kael-voss.md'])
    expect(order.filter((p) => p === 'metadata/characters/kael-voss.md')).toHaveLength(1)
  })

  it('omits sections the novel has nothing in', () => {
    const order = codexOrder(
      { ...LISTING, hasGlossary: false, hasTimeline: false, reviews: [] },
      []
    )
    expect(order).not.toContain('metadata/glossary.md')
    expect(order).not.toContain('metadata/timeline.yaml')
  })
})

describe('nextPendingPath', () => {
  const CHAPTERS = [{ file: 'chapters/001-a.md' }, { file: 'chapters/002-b.md' }]
  const order = novelOrder(CHAPTERS, LISTING, [])

  it('walks chapters before the Codex', () => {
    expect(order[0]).toBe('chapters/001-a.md')
    expect(order[2]).toBe('metadata/synopsis.md')
  })

  it('finds the next document after the one open', () => {
    const pending = new Set(['chapters/002-b.md', 'metadata/synopsis.md'])
    expect(nextPendingPath(order, pending, 'chapters/001-a.md')).toBe('chapters/002-b.md')
    expect(nextPendingPath(order, pending, 'chapters/002-b.md')).toBe('metadata/synopsis.md')
  })

  it('wraps to the beginning past the last one', () => {
    const pending = new Set(['chapters/001-a.md', 'metadata/synopsis.md'])
    expect(nextPendingPath(order, pending, 'metadata/synopsis.md')).toBe('chapters/001-a.md')
  })

  it('returns the only pending document even when it is the one open', () => {
    const pending = new Set(['chapters/001-a.md'])
    expect(nextPendingPath(order, pending, 'chapters/001-a.md')).toBe('chapters/001-a.md')
  })

  it('starts from the top when nothing is open, and gives up when nothing is pending', () => {
    expect(nextPendingPath(order, new Set(['metadata/synopsis.md']), null)).toBe(
      'metadata/synopsis.md'
    )
    expect(nextPendingPath(order, new Set(), 'chapters/001-a.md')).toBeNull()
  })

  it('still finds a pending document that is not in the order (a stale listing)', () => {
    const pending = new Set(['metadata/characters/mara-din.md'])
    expect(nextPendingPath([...order, 'metadata/characters/mara-din.md'], pending, 'nowhere.md')).toBe(
      'metadata/characters/mara-din.md'
    )
  })
})
