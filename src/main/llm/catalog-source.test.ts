import { describe, it, expect, vi, afterEach } from 'vitest'
import { CatalogSource } from './catalog-source'
import bundled from './catalog.json'
import { CATALOG_SCHEMA_VERSION } from '../../shared/llm/catalog'

vi.mock('../log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

/** A minimal but schema-valid published catalog, distinguishable from the bundled one. */
function publishedCatalog(over: Record<string, unknown> = {}): unknown {
  return {
    catalogVersion: CATALOG_SCHEMA_VERSION,
    models: [
      {
        id: 'published-only',
        name: 'Published Only',
        params: '7B',
        bestFor: 'Proving the fetch path works.',
        tradeoff: 'Does not exist.',
        useCases: ['drafting'],
        styles: ['genre'],
        unfiltered: false,
        hfUri: 'hf:example/Example-GGUF/example-Q4_K_M.gguf',
        filename: 'example-Q4_K_M.gguf',
        sizeBytes: 1234,
        memory: {
          weightsBytes: 2000,
          trainContextLength: 8192,
          contextCost: [
            { contextSize: 4096, bytes: 500 },
            { contextSize: 8192, bytes: 900 }
          ]
        },
        contextLength: 8192,
        license: 'Apache 2.0',
        tier: 'light',
        popular: false
      }
    ],
    hosted: [],
    ...over
  }
}

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CatalogSource', () => {
  it('uses the published catalog when it fetches and validates', async () => {
    mockFetch(() => jsonResponse(publishedCatalog()))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.map((m) => m.id)).toEqual(['published-only'])
  })

  it('falls back to the bundled catalog when the network fails', async () => {
    mockFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND pandorasgate.app')
    })
    const catalog = await new CatalogSource().load()
    expect(catalog.models.length).toBe(bundled.models.length)
    expect(catalog.models[0].id).toBe(bundled.models[0].id)
  })

  it('falls back on a non-OK response', async () => {
    mockFetch(() => jsonResponse({}, 503))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.length).toBe(bundled.models.length)
  })

  it('falls back when the published catalog is malformed', async () => {
    mockFetch(() => new Response('<!doctype html><h1>404</h1>', { status: 200 }))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.length).toBe(bundled.models.length)
  })

  it('falls back when the published catalog fails schema validation', async () => {
    // A model missing `bestFor` — the kind of thing a hand-edit produces.
    const broken = publishedCatalog()
    delete (broken as { models: Record<string, unknown>[] }).models[0].bestFor
    mockFetch(() => jsonResponse(broken))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.length).toBe(bundled.models.length)
  })

  it('falls back when the published catalog targets a newer schema', async () => {
    // Forward compatibility: an old app must not choke on a new catalog.
    mockFetch(() => jsonResponse(publishedCatalog({ catalogVersion: CATALOG_SCHEMA_VERSION + 1 })))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.map((m) => m.id)).not.toContain('published-only')
    expect(catalog.models.length).toBe(bundled.models.length)
  })

  it('accepts a catalog published against an older schema', async () => {
    mockFetch(() => jsonResponse(publishedCatalog({ catalogVersion: 1 })))
    const catalog = await new CatalogSource().load()
    expect(catalog.models.map((m) => m.id)).toEqual(['published-only'])
  })

  it('serves the cache within the TTL instead of re-fetching', async () => {
    mockFetch(() => jsonResponse(publishedCatalog()))
    const source = new CatalogSource('https://example.test/catalog.json', 60_000)
    await source.load()
    await source.load()
    await source.load()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the TTL has expired', async () => {
    mockFetch(() => jsonResponse(publishedCatalog()))
    const source = new CatalogSource('https://example.test/catalog.json', 0)
    await source.load()
    await source.load()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('caches the fallback too, so an outage is not re-probed on every open', async () => {
    mockFetch(() => {
      throw new Error('offline')
    })
    const source = new CatalogSource('https://example.test/catalog.json', 60_000)
    await source.load()
    await source.load()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('gives up on a hung request rather than blocking the Models manager', async () => {
    mockFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          // Simulate the AbortSignal.timeout firing.
          setTimeout(() => reject(new DOMException('The operation timed out.', 'TimeoutError')), 1)
        })
    )
    const catalog = await new CatalogSource().load()
    expect(catalog.models.length).toBe(bundled.models.length)
  })
})
