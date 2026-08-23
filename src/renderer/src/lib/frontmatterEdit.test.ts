import { describe, it, expect } from 'vitest'
import { fieldSuggestions, withField, remainingData } from './frontmatterEdit'

const CURRENT = { name: 'Kael Voss', role: 'protagonist', aliases: ['The Gatekeeper'] }

describe('fieldSuggestions', () => {
  it('surfaces changed, added, and removed fields', () => {
    const proposed = { name: 'Kael Voss', role: 'antagonist', status: 'alive' }
    const out = fieldSuggestions(CURRENT, proposed, [], 'Codex update')
    expect(out.map((s) => s.key).sort()).toEqual(['aliases', 'role', 'status'])
    expect(out.find((s) => s.key === 'role')).toMatchObject({
      current: 'protagonist',
      proposed: 'antagonist'
    })
    // A field only the proposal has is an addition…
    expect(out.find((s) => s.key === 'status')).toMatchObject({ proposed: 'alive' })
    expect(out.find((s) => s.key === 'status')!.current).toBeUndefined()
    // …and one only the document has is a removal.
    expect(out.find((s) => s.key === 'aliases')!.proposed).toBeUndefined()
  })

  it('says nothing about a field the document already agrees with', () => {
    expect(fieldSuggestions(CURRENT, { name: 'Kael Voss' }, ['role', 'aliases'], 'x')).toEqual([])
  })

  it('compares structured values by shape, not identity', () => {
    const out = fieldSuggestions(
      { aliases: ['a', 'b'] },
      { aliases: ['a', 'b'] },
      [],
      'x'
    )
    expect(out).toEqual([])
    expect(fieldSuggestions({ aliases: ['a'] }, { aliases: ['a', 'b'] }, [], 'x')).toHaveLength(1)
  })

  it('does not offer a structured value whose keys were merely reordered', () => {
    // The timeline side already ignored key order; frontmatter did not, so a
    // re-emitted map produced a field row and kept the item pending forever.
    expect(
      fieldSuggestions(
        { relationships: { mentor: 'Ilya', rival: 'Dren' } },
        { relationships: { rival: 'Dren', mentor: 'Ilya' } },
        [],
        'x'
      )
    ).toEqual([])
  })

  it('drops a field the author turned down', () => {
    const proposed = { ...CURRENT, role: 'antagonist' }
    expect(fieldSuggestions(CURRENT, proposed, [], 'x')).toHaveLength(1)
    expect(fieldSuggestions(CURRENT, proposed, ['role'], 'x')).toEqual([])
  })
})

describe('withField', () => {
  it('sets, overwrites, and removes', () => {
    expect(withField(CURRENT, 'status', 'alive').status).toBe('alive')
    expect(withField(CURRENT, 'role', 'antagonist').role).toBe('antagonist')
    expect('role' in withField(CURRENT, 'role', undefined)).toBe(false)
  })

  it('does not mutate the input', () => {
    withField(CURRENT, 'role', 'antagonist')
    expect(CURRENT.role).toBe('protagonist')
  })
})

describe('remainingData', () => {
  const PROPOSED = { name: 'Kael Voss', role: 'antagonist', status: 'alive' }

  it('keeps proposing what has not been decided', () => {
    expect(remainingData(CURRENT, PROPOSED, [])).toEqual({
      name: 'Kael Voss',
      role: 'antagonist',
      status: 'alive'
    })
  })

  it('stops proposing a field once the document already says it', () => {
    // Accepting `role` is an ordinary edit to the document.
    const decided = withField(CURRENT, 'role', 'antagonist')
    const remaining = remainingData(decided, PROPOSED, [])
    expect(remaining.role).toBe('antagonist')
    expect(remaining.status).toBe('alive')
  })

  it('stops proposing a field the author rejected', () => {
    const remaining = remainingData(CURRENT, PROPOSED, ['role', 'aliases'])
    expect(remaining.role).toBe('protagonist')
    expect(remaining.aliases).toEqual(['The Gatekeeper'])
    expect(remaining.status).toBe('alive')
  })

  it('equals the document once every field is decided — which resolves the item', () => {
    const decided = withField(withField(CURRENT, 'role', 'antagonist'), 'status', 'alive')
    // `aliases` would be removed by the proposal; the author kept it.
    expect(remainingData(decided, PROPOSED, ['aliases'])).toEqual(decided)
  })
})
