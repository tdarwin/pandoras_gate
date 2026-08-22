import { describe, it, expect } from 'vitest'
import {
  parseEntries,
  entryKey,
  serializeEntries,
  diffEntries,
  applyChange,
  entryLabel
} from './timelineEntries'

const A = { id: 'e1', when: 'Day 1', summary: 'The gate opens.' }
const B = { id: 'e2', when: 'Day 3', summary: 'Kael leaves.' }

describe('parseEntries', () => {
  it('reads a list of events, and an empty timeline', () => {
    expect(parseEntries('- id: e1\n  when: Day 1\n')).toEqual([{ id: 'e1', when: 'Day 1' }])
    expect(parseEntries('[]\n')).toEqual([])
    expect(parseEntries('# just a comment\n')).toEqual([])
  })

  it('refuses anything that is not a list of records, rather than guessing', () => {
    // These fall back to the byte-preserving plain editor: the author is
    // invited to hand-edit this file, and a structured view that cannot show
    // what is there would be worse than the raw text.
    expect(parseEntries('not: a list\n')).toBeNull()
    expect(parseEntries('- one\n- two\n')).toBeNull()
    expect(parseEntries('- id: e1\n   bad indent: [\n')).toBeNull()
  })
})

describe('entryKey', () => {
  it('prefers a stable field, and falls back to position', () => {
    expect(entryKey({ id: 'e1', when: 'Day 1' }, 0)).toBe('id:e1')
    expect(entryKey({ when: 'Day 1' }, 0)).toBe('when:Day 1')
    expect(entryKey({ summary: 'x' }, 3)).toBe('#3')
  })
})

describe('diffEntries', () => {
  it('finds additions, changes, and removals', () => {
    const changed = { ...B, summary: 'Kael leaves at dawn.' }
    const C = { id: 'e3', when: 'Day 9', summary: 'The gate closes.' }
    const out = diffEntries([A, B], [A, changed, C])
    expect(out.map((c) => c.kind).sort()).toEqual(['added', 'changed'])
    expect(out.find((c) => c.kind === 'changed')).toMatchObject({ current: B, proposed: changed })
    expect(out.find((c) => c.kind === 'added')).toMatchObject({ proposed: C })

    const removed = diffEntries([A, B], [A])
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ kind: 'removed', current: B })
  })

  it('says nothing when the two agree', () => {
    expect(diffEntries([A, B], [A, B])).toEqual([])
  })

  it('matches by identity, not position, so an insertion is one change', () => {
    const C = { id: 'e0', when: 'Day 0', summary: 'Before.' }
    // C is prepended: A and B move, but neither has changed.
    const out = diffEntries([A, B], [C, A, B])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'added', proposed: C })
  })
})

describe('entries that share an identity', () => {
  // Several events on one in-world day is ordinary in a hand-written timeline,
  // and the model cannot be relied on to emit ids. Keyed only by `when`, they
  // all collapsed to one — and accepting a change to the last silently deleted
  // the others.
  const D1 = { when: 'Day 1', summary: 'a' }
  const D2 = { when: 'Day 1', summary: 'b' }
  const D3 = { when: 'Day 1', summary: 'c' }

  it('keeps them distinct', () => {
    const changes = diffEntries([D1, D2], [D1, D2, D3])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'added' })
  })

  it('accepts the addition without eating an existing event', () => {
    const changes = diffEntries([D1, D2], [D1, D2, D3])
    expect(changes.reduce(applyChange, [D1, D2])).toEqual([D1, D2, D3])
  })

  it('edits the right one of a repeated day', () => {
    const edited = { when: 'Day 1', summary: 'b, revised' }
    const changes = diffEntries([D1, D2], [D1, edited])
    expect(changes).toHaveLength(1)
    expect(changes.reduce(applyChange, [D1, D2])).toEqual([D1, edited])
  })
})

describe('a repeated day the proposal changes the shape of', () => {
  const a = { when: 'Day 1', summary: 'a' }
  const b = { when: 'Day 1', summary: 'b' }

  it('drops the right one when the proposal removes the first', () => {
    // Positional keys made this read as "change the first, remove the second".
    // Accepting the change alone left [b, b] and lost 'a' entirely.
    const changes = diffEntries([a, b], [b])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'removed', current: a })
    expect(changes.reduce(applyChange, [a, b])).toEqual([b])
  })

  it('is not confused by a reorder within the day', () => {
    // Both entries survive, so there is nothing to decide.
    expect(diffEntries([a, b], [b, a])).toEqual([])
  })

  it('accepting one decision does not shift the others', () => {
    const c = { when: 'Day 1', summary: 'c' }
    const changes = diffEntries([a, b], [a, c])
    expect(changes).toHaveLength(1)
    // Applying it leaves the untouched entry exactly where it was.
    expect(changes.reduce(applyChange, [a, b])).toEqual([a, c])
  })
})

describe('change keys', () => {
  const a = { when: 'Day 1', summary: 'a' }
  const b = { when: 'Day 1', summary: 'b' }
  const c = { when: 'Day 1', summary: 'c' }

  it('name the change, so a rejection survives an accept beside it', () => {
    // A rejection is remembered by key. Keyed by position, accepting `b`
    // renumbered `c` and the stored rejection stopped matching — the
    // suggestion reappeared on the next save.
    const rejected = diffEntries([a], [a, b, c]).find(
      (ch) => ch.proposed?.summary === 'c'
    )!.key
    // …the author accepts `b`, so the document moves on…
    const after = diffEntries([a, b], [a, b, c])
    expect(after).toHaveLength(1)
    expect(after[0]!.key).toBe(rejected)
  })

  it('do not depend on key order within an entry', () => {
    const reordered = { summary: 'a', when: 'Day 1' }
    expect(diffEntries([], [a])[0]!.key).toBe(diffEntries([], [reordered])[0]!.key)
  })
})

describe('key order', () => {
  it('is not a change', () => {
    // A model re-emitting an existing event with its fields in another order
    // produced a "changed" card whose diff showed identical text.
    expect(
      diffEntries([{ id: 'e1', when: 'Day 1' }], [{ when: 'Day 1', id: 'e1' }])
    ).toEqual([])
  })
})

describe('applyChange', () => {
  it('applies one decision at a time, keeping the others pending', () => {
    const changed = { ...B, summary: 'Kael leaves at dawn.' }
    const C = { id: 'e3', when: 'Day 9', summary: 'The gate closes.' }
    const changes = diffEntries([A, B], [A, changed, C])

    const onlyTheEdit = changes
      .filter((c) => c.kind === 'changed')
      .reduce(applyChange, [A, B])
    expect(onlyTheEdit).toEqual([A, changed])

    // Accepting everything reaches the proposal.
    expect(changes.reduce(applyChange, [A, B])).toEqual([A, changed, C])
  })

  it('keeps an edited entry in place rather than moving it to the end', () => {
    const edited = { ...A, summary: 'The gate groans open.' }
    expect(
      applyChange([A, B], { key: 'k', kind: 'changed', current: A, proposed: edited })
    ).toEqual([edited, B])
  })

  it('removes without disturbing the rest', () => {
    expect(applyChange([A, B], { key: 'k', kind: 'removed', current: A })).toEqual([B])
  })
})

describe('serializeEntries', () => {
  it('round-trips through the parser', () => {
    expect(parseEntries(serializeEntries([A, B]))).toEqual([A, B])
  })

  it('writes an empty timeline as an empty list, not as nothing', () => {
    expect(serializeEntries([])).toBe('[]\n')
    expect(parseEntries(serializeEntries([]))).toEqual([])
  })
})

describe('entryLabel', () => {
  it('names an event by the most human field it has', () => {
    expect(entryLabel(A)).toBe('Day 1')
    expect(entryLabel({ id: 'e9' })).toBe('e9')
    expect(entryLabel({ summary: 'x' })).toBe('(event)')
    expect(entryLabel(undefined)).toBe('')
  })
})
