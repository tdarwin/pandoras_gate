import { describe, it, expect } from 'vitest'
import bundled from '../../main/llm/catalog.json'
import {
  parseCatalogLenient,
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

describe('parseCatalogLenient', () => {
  function model(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'm1',
      name: 'Model One',
      params: '9B',
      bestFor: 'Drafting scenes on a modest machine.',
      tradeoff: 'Slower than the smaller options.',
      useCases: ['drafting'],
      styles: ['genre'],
      unfiltered: false,
      hfUri: 'hf:owner/repo/model-Q4_K_M.gguf',
      filename: 'model-Q4_K_M.gguf',
      sizeBytes: 100,
      memory: {
        weightsBytes: 120,
        trainContextLength: 8192,
        contextCost: [{ contextSize: 4096, bytes: 50 }]
      },
      contextLength: 8192,
      license: 'Apache 2.0',
      tier: 'light',
      popular: false,
      ...over
    }
  }
  const file = (models: unknown[], hosted: unknown[] = []): unknown => ({
    catalogVersion: 2,
    models,
    hosted
  })

  it('drops vocabulary this build does not know instead of rejecting the entry', () => {
    // The regression that matters: publishing a catalog with a new style used
    // to fail validation outright, freezing every older install on its bundled
    // copy — which defeats the point of publishing the catalog at all.
    const got = parseCatalogLenient(
      file([model({ styles: ['genre', 'cyberpunk'], useCases: ['drafting', 'worldbuilding'] })])
    )
    expect('catalog' in got).toBe(true)
    if (!('catalog' in got)) return
    expect(got.catalog.models[0].styles).toEqual(['genre'])
    expect(got.catalog.models[0].useCases).toEqual(['drafting'])
  })

  it('drops only the entries it cannot use, keeping the rest', () => {
    const got = parseCatalogLenient(
      file([model({ id: 'good' }), model({ id: 'bad', sizeBytes: 'enormous' })])
    )
    expect('catalog' in got).toBe(true)
    if (!('catalog' in got)) return
    expect(got.catalog.models.map((m) => m.id)).toEqual(['good'])
    expect(got.dropped).toBe(1)
  })

  it('drops an entry left with no use case this build recognizes', () => {
    const got = parseCatalogLenient(file([model({ id: 'alien', useCases: ['worldbuilding'] })]))
    expect(got).toEqual({ error: 'no usable entries' })
  })

  it('reports an error only when nothing at all survives', () => {
    expect(parseCatalogLenient(file([{ nope: true }]))).toEqual({ error: 'no usable entries' })
    expect(parseCatalogLenient({ not: 'a catalog' })).toHaveProperty('error')
  })

  it('accepts the shipped catalog unchanged', () => {
    // Lenient parsing must not quietly discard anything we actually ship.
    const got = parseCatalogLenient(bundled)
    expect('catalog' in got).toBe(true)
    if (!('catalog' in got)) return
    expect(got.dropped).toBe(0)
    expect(got.catalog.models).toHaveLength(bundled.models.length)
    expect(got.catalog.hosted).toHaveLength(bundled.hosted.length)
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
