import { describe, it, expect } from 'vitest'
import {
  recommend,
  recommendationReason,
  type Fit,
  type RecommendFilters,
  type Scorable,
  type Style,
  type Tier,
  type UseCase
} from './catalog'

function entry(id: string, over: Partial<Scorable> = {}): Scorable {
  return {
    id,
    useCases: ['drafting'],
    styles: [],
    unfiltered: false,
    tier: 'mid',
    fit: 'recommended',
    ...over
  }
}

const NO_FILTERS: RecommendFilters = { useCase: null, style: null, showUnfiltered: false }

describe('recommend', () => {
  it('returns everything runnable when no use case is chosen', () => {
    const entries = [entry('a'), entry('b', { useCases: ['codex'] })]
    expect(recommend(entries, NO_FILTERS).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('hard-filters on the chosen use case', () => {
    const entries = [entry('drafter'), entry('editor', { useCases: ['copyEdit'] })]
    const got = recommend(entries, { ...NO_FILTERS, useCase: 'copyEdit' })
    expect(got.map((e) => e.id)).toEqual(['editor'])
  })

  it('returns an empty list rather than an off-target match', () => {
    const entries = [entry('drafter', { useCases: ['drafting'] })]
    expect(recommend(entries, { ...NO_FILTERS, useCase: 'codex' })).toEqual([])
  })

  it('treats style as a soft signal that re-ranks but never excludes', () => {
    const entries = [entry('plain'), entry('romantic', { styles: ['romance'] })]
    const got = recommend(entries, { ...NO_FILTERS, style: 'romance' })
    expect(got.map((e) => e.id)).toEqual(['romantic', 'plain'])
  })

  it('excludes models too large for the machine', () => {
    const entries = [entry('fits'), entry('huge', { fit: 'too-large' })]
    expect(recommend(entries, NO_FILTERS).map((e) => e.id)).toEqual(['fits'])
  })

  it('hides unfiltered models until opted in', () => {
    const entries = [entry('safe'), entry('spicy', { unfiltered: true })]
    expect(recommend(entries, NO_FILTERS).map((e) => e.id)).toEqual(['safe'])
    expect(
      recommend(entries, { ...NO_FILTERS, showUnfiltered: true }).map((e) => e.id)
    ).toEqual(['safe', 'spicy'])
  })

  it('ranks a style match above machine fit', () => {
    // Deliberate: the user told us what they write, `too-large` is already
    // excluded so "slow" is still usable, and the card labels the fit anyway.
    const entries = [
      entry('styled-but-slow', { styles: ['romance'], fit: 'slow' }),
      entry('plain-but-fits', { fit: 'recommended' })
    ]
    const got = recommend(entries, { ...NO_FILTERS, style: 'romance' })
    expect(got.map((e) => e.id)).toEqual(['styled-but-slow', 'plain-but-fits'])
  })

  it('ranks machine fit above tier, so a big slow model loses to a small fast one', () => {
    const entries = [
      entry('slow-large', { fit: 'slow', tier: 'large' }),
      entry('fast-light', { fit: 'recommended', tier: 'light' })
    ]
    expect(recommend(entries, NO_FILTERS)[0].id).toBe('fast-light')
  })

  it('uses tier only to break ties between otherwise equal candidates', () => {
    const entries = [
      entry('light', { tier: 'light' }),
      entry('large', { tier: 'large' }),
      entry('mid', { tier: 'mid' })
    ]
    expect(recommend(entries, NO_FILTERS).map((e) => e.id)).toEqual(['large', 'mid', 'light'])
  })

  it('breaks ties on id so the order is stable across renders', () => {
    const entries = [entry('zebra'), entry('alpha'), entry('mango')]
    expect(recommend(entries, NO_FILTERS).map((e) => e.id)).toEqual(['alpha', 'mango', 'zebra'])
    // Same input in a different order produces the same output.
    expect(recommend([...entries].reverse(), NO_FILTERS).map((e) => e.id)).toEqual([
      'alpha',
      'mango',
      'zebra'
    ])
  })

  it('ranks hosted picks, which carry neither tier nor fit', () => {
    const hosted: Scorable[] = [
      { id: 'plain', useCases: ['drafting'], styles: [], unfiltered: false },
      { id: 'styled', useCases: ['drafting'], styles: ['literary'], unfiltered: false }
    ]
    const got = recommend(hosted, { ...NO_FILTERS, style: 'literary' })
    expect(got.map((e) => e.id)).toEqual(['styled', 'plain'])
  })

  it('does not mutate the input array', () => {
    const entries = [entry('z'), entry('a')]
    const snapshot = entries.map((e) => e.id)
    recommend(entries, NO_FILTERS)
    expect(entries.map((e) => e.id)).toEqual(snapshot)
  })
})

describe('recommendationReason', () => {
  it('names the task, the style match, and the fit', () => {
    const reason = recommendationReason(entry('a', { styles: ['romance'] }), {
      useCase: 'drafting',
      style: 'romance',
      showUnfiltered: true
    })
    expect(reason).toBe('Good at draft prose, tuned for romance, comfortably fits your machine.')
  })

  it('omits a style it does not actually match', () => {
    const reason = recommendationReason(entry('a'), {
      useCase: 'copyEdit',
      style: 'romance',
      showUnfiltered: false
    })
    expect(reason).not.toContain('romance')
    expect(reason).toContain('Good at copy edit')
  })

  it('is honest about a slow fit', () => {
    expect(recommendationReason(entry('a', { fit: 'slow' }), NO_FILTERS)).toBe(
      'Runs on your machine, but slowly.'
    )
  })

  it('returns empty when there is nothing to say', () => {
    const hosted: Scorable = { id: 'h', useCases: ['chat'], styles: [], unfiltered: false }
    expect(recommendationReason(hosted, NO_FILTERS)).toBe('')
  })
})

describe('type surface', () => {
  it('keeps the exported unions usable as literal types', () => {
    // Compile-time guard: these must stay assignable from string literals so
    // catalog.json and the picker chips can't drift from the schema.
    const useCase: UseCase = 'developmental'
    const style: Style = 'grimdark'
    const tier: Tier = 'large'
    const fit: Fit = 'slow'
    expect([useCase, style, tier, fit]).toHaveLength(4)
  })
})
