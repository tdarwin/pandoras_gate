import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import bundled from './catalog.json'
import {
  CatalogFileSchema,
  CATALOG_SCHEMA_VERSION,
  STYLES,
  TIERS,
  USE_CASES,
  recommend,
  unknownVocabulary
} from '../../shared/llm/catalog'
import {
  COMFORTABLE_CONTEXT,
  memoryRequirementsGB,
  memoryVerdict,
  usableContext
} from '../../shared/llm/memory'

/**
 * Offline guards on the shipped catalog. Anything needing the network — that
 * the repos exist and the byte sizes are right — lives in
 * `npm run verify:catalog`.
 */

const parsed = CatalogFileSchema.safeParse(bundled)

// Every other test reads the parsed value, so they exercise the schema and get
// the narrow literal types (UseCase, Style, Tier) instead of raw JSON strings.
const catalog = parsed.success ? parsed.data : null

function requireCatalog(): NonNullable<typeof catalog> {
  if (!catalog) throw new Error('catalog.json failed to parse — see the schema test above')
  return catalog
}

describe('bundled catalog', () => {
  it('validates against the schema', () => {
    if (!parsed.success) {
      throw new Error(
        `catalog.json is invalid:\n${parsed.error.issues
          .map((i) => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`
      )
    }
    expect(parsed.success).toBe(true)
  })

  it('declares a version this build understands', () => {
    expect(bundled.catalogVersion).toBeLessThanOrEqual(CATALOG_SCHEMA_VERSION)
  })

  it('uses only vocabulary this build knows', () => {
    // The schema filters unknown use cases and styles so a *published* catalog
    // from a newer release still works. That leniency would hide a typo in the
    // copy we ship — "romanse" would parse fine and simply vanish — so the
    // bundled file is held to the strict list.
    expect(unknownVocabulary(bundled)).toEqual([])
  })

  it('is byte-identical to the published copy', () => {
    // site/catalog.json is what shipped apps fetch; if the two drift, the
    // fallback silently stops matching what users actually get.
    const root = join(import.meta.dirname, '../../..')
    const bundledRaw = readFileSync(join(root, 'src/main/llm/catalog.json'), 'utf8')
    const publishedRaw = readFileSync(join(root, 'site/catalog.json'), 'utf8')
    expect(publishedRaw).toBe(bundledRaw)
  })
})

describe('catalog invariants', () => {
  const { models, hosted } = requireCatalog()

  it('has unique ids across local models', () => {
    const ids = models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has unique filenames — installs are matched by filename on disk', () => {
    const names = models.map((m) => m.filename)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has unique hosted slugs', () => {
    const ids = hosted.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('states the file the hfUri actually points at', () => {
    for (const m of models) {
      expect(m.hfUri.endsWith(m.filename), `${m.id}: hfUri does not end with filename`).toBe(true)
    }
  })

  it('covers every use case with at least two options', () => {
    for (const useCase of USE_CASES) {
      const matching = [...models, ...hosted].filter((m) => m.useCases.includes(useCase))
      expect(matching.length, `no options for use case "${useCase}"`).toBeGreaterThanOrEqual(2)
    }
  })

  it('covers every style with at least one option', () => {
    for (const style of STYLES) {
      const matching = [...models, ...hosted].filter((m) => m.styles.includes(style))
      expect(matching.length, `no options for style "${style}"`).toBeGreaterThanOrEqual(1)
    }
  })

  it('offers something at every memory tier', () => {
    for (const tier of TIERS) {
      const matching = models.filter((m) => m.tier === tier)
      expect(matching.length, `no models at tier "${tier}"`).toBeGreaterThanOrEqual(2)
    }
  })

  it('offers an unfiltered option for the styles that need one', () => {
    // Romance and grimdark are the categories mainstream models refuse; a user
    // who toggles unfiltered on must find something for them.
    for (const style of ['romance', 'grimdark', 'rpg'] as const) {
      const matching = models.filter((m) => m.unfiltered && m.styles.includes(style))
      expect(matching.length, `no unfiltered model for "${style}"`).toBeGreaterThanOrEqual(1)
    }
  })

  it('keeps a filtered default — the light tier is usable without opting in', () => {
    const safeLight = models.filter((m) => !m.unfiltered && m.tier === 'light')
    expect(safeLight.length).toBeGreaterThanOrEqual(2)
  })

  it('carries a measured memory profile, not a hand-authored guess', () => {
    for (const m of models) {
      // Weights in memory are always at least the file on disk.
      expect(m.memory.weightsBytes, `${m.id} weights`).toBeGreaterThanOrEqual(m.sizeBytes)
      expect(m.memory.trainContextLength, `${m.id} train ctx`).toBeGreaterThanOrEqual(
        m.contextLength
      )
      // Cost samples ascend in both dimensions, or the search in
      // usableContext() (which breaks on the first miss) would be wrong.
      let lastSize = 0
      let lastBytes = 0
      for (const sample of m.memory.contextCost) {
        expect(sample.contextSize, `${m.id} samples out of order`).toBeGreaterThan(lastSize)
        expect(sample.bytes, `${m.id} cost not monotonic`).toBeGreaterThan(lastBytes)
        expect(sample.contextSize).toBeLessThanOrEqual(m.memory.trainContextLength)
        lastSize = sample.contextSize
        lastBytes = sample.bytes
      }
      expect(m.memory.contextCost.length, `${m.id} too few samples`).toBeGreaterThanOrEqual(3)
    }
  })

  it('derives memory requirements consistent with its tier', () => {
    const maxComfortableByTier: Record<(typeof TIERS)[number], number> = {
      light: 24,
      mid: 40,
      large: Infinity
    }
    for (const m of models) {
      const { minimumGB, comfortableGB } = memoryRequirementsGB(m.memory)
      expect(minimumGB, `${m.id}`).toBeLessThan(comfortableGB)
      expect(comfortableGB, `${m.id} is tier ${m.tier}`).toBeLessThanOrEqual(
        maxComfortableByTier[m.tier]
      )
    }
  })

  it('writes copy a novelist can act on', () => {
    for (const m of [...models, ...hosted]) {
      // Full sentences, not fragments or truncated placeholders.
      expect(m.bestFor.length, `${m.id} bestFor`).toBeGreaterThan(20)
      expect(m.tradeoff.length, `${m.id} tradeoff`).toBeGreaterThan(20)
      expect(m.bestFor.endsWith('.'), `${m.id} bestFor should be a sentence`).toBe(true)
      expect(m.tradeoff.endsWith('.'), `${m.id} tradeoff should be a sentence`).toBe(true)
      expect(m.bestFor, `${m.id} repeats its own name`).not.toContain(m.name)
    }
  })
})

describe('catalog against real hardware profiles', () => {
  function withFit(totalMemoryGB: number) {
    return requireCatalog().models.map((m) => ({
      ...m,
      ...memoryVerdict(m.memory, totalMemoryGB * 1024 ** 3)
    }))
  }

  // The baseline Apple Silicon machine. If this comes up empty the catalog is
  // useless to most of the user base.
  it('gives a 16GB machine something for every use case', () => {
    for (const useCase of USE_CASES) {
      const got = recommend(withFit(16), { useCase, style: null, showUnfiltered: false })
      expect(got.length, `16GB machine has no option for "${useCase}"`).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives an 8GB machine at least a copy-edit and a Codex option', () => {
    const got = recommend(withFit(8), { useCase: null, style: null, showUnfiltered: false })
    expect(got.length).toBeGreaterThanOrEqual(1)
    for (const useCase of ['copyEdit', 'codex'] as const) {
      const forTask = recommend(withFit(8), { useCase, style: null, showUnfiltered: false })
      expect(forTask.length, `8GB machine has no "${useCase}" option`).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives a small model far more than the old flat 16k cap', () => {
    // The regression this whole memory model exists to prevent: a 4B model on
    // a 16GB laptop was pinned to 16k when it can hold several times that.
    const smallest = requireCatalog().models.reduce((a, b) =>
      a.memory.weightsBytes <= b.memory.weightsBytes ? a : b
    )
    expect(usableContext(smallest.memory, 16 * 1024 ** 3)).toBeGreaterThan(COMFORTABLE_CONTEXT)
  })

  it('does not offer a model that only leaves room for a sliver of context', () => {
    // Weights fitting is not the same as being usable. Anything we still show
    // on a 16GB machine must clear the minimum window.
    for (const m of withFit(16)) {
      if (m.fit !== 'too-large') expect(m.usableContext, `${m.id}`).toBeGreaterThanOrEqual(4096)
    }
  })

  it('marks the cramped models rather than presenting them as fine', () => {
    // Across the machines users actually have, any model we call
    // "recommended" must have a comfortable window.
    for (const total of [8, 16, 32, 64]) {
      for (const m of withFit(total)) {
        if (m.fit === 'recommended') {
          expect(m.usableContext, `${m.id} on ${total}GB`).toBeGreaterThanOrEqual(
            COMFORTABLE_CONTEXT
          )
          expect(m.cramped, `${m.id} on ${total}GB`).toBe(false)
        }
      }
    }
  })

  it('unlocks the large tier on a 64GB machine', () => {
    const got = recommend(withFit(64), { useCase: null, style: null, showUnfiltered: true })
    expect(got.length).toBe(requireCatalog().models.length)
    expect(got.some((m) => m.tier === 'large')).toBe(true)
  })

  it('offers a romance writer on 16GB an unfiltered option once they opt in', () => {
    const filtered = recommend(withFit(16), {
      useCase: 'drafting',
      style: 'romance',
      showUnfiltered: false
    })
    const opted = recommend(withFit(16), {
      useCase: 'drafting',
      style: 'romance',
      showUnfiltered: true
    })
    expect(opted.length).toBeGreaterThan(filtered.length)
    expect(opted[0].styles).toContain('romance')
    expect(opted[0].unfiltered).toBe(true)
  })
})
