import bundledJson from './catalog.json'
import {
  CatalogFileSchema,
  CATALOG_SCHEMA_VERSION,
  parseCatalogLenient,
  type CatalogFile
} from '../../shared/llm/catalog'
import { logInfo, logWarn } from '../log'

/**
 * Where the catalog comes from.
 *
 * Model recommendations rot fast — the previous hard-coded list was two model
 * generations out of date after a single release cycle, and there was no way
 * to fix it without shipping a new build. So the live catalog is published
 * alongside the marketing site and fetched at runtime, with the copy compiled
 * into the app as the fallback.
 *
 * The fallback is load-bearing, not a formality: it covers being offline, the
 * site being down, a truncated response, a hand-mangled file, and a catalog
 * published against a newer schema than this build understands. In every one
 * of those cases the user gets slightly stale recommendations instead of an
 * empty screen.
 */

const CATALOG_URL = 'https://pandorasgate.app/catalog.json'
const TTL_MS = 24 * 60 * 60 * 1000
/** A hung request must not stall the Models manager opening. */
const FETCH_TIMEOUT_MS = 5000

export class CatalogSource {
  private cache: { at: number; catalog: CatalogFile } | null = null
  /** Logged once per process so a persistent outage doesn't spam the log. */
  private loggedFallback = false

  constructor(
    private readonly url: string = CATALOG_URL,
    private readonly ttlMs: number = TTL_MS
  ) {}

  async load(): Promise<CatalogFile> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.catalog

    const remote = await this.fetchRemote()
    const catalog = remote ?? this.bundled()
    // Cache the fallback too: without this, every open of the Models manager
    // would re-attempt a fetch that is probably still failing.
    this.cache = { at: Date.now(), catalog }
    return catalog
  }

  private async fetchRemote(): Promise<CatalogFile | null> {
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' }
      })
      if (!res.ok) return this.fallback(`HTTP ${res.status}`)

      const parsed = parseCatalogLenient(await res.json())
      if ('error' in parsed) {
        return this.fallback(`published catalog failed validation: ${parsed.error}`)
      }
      // Forward compatibility: a catalog written for a later schema may rely on
      // fields this build ignores, so prefer the copy we were built against.
      if (parsed.catalog.catalogVersion > CATALOG_SCHEMA_VERSION) {
        return this.fallback(
          `published catalog is version ${parsed.catalog.catalogVersion}, this build understands ${CATALOG_SCHEMA_VERSION}`
        )
      }

      logInfo(
        'llm',
        `loaded published model catalog (${parsed.catalog.models.length} models` +
          `${parsed.dropped > 0 ? `, ${parsed.dropped} entry/entries this build can't use` : ''})`
      )
      return parsed.catalog
    } catch (err) {
      return this.fallback(err instanceof Error ? err.message : String(err))
    }
  }

  private fallback(reason: string): null {
    if (!this.loggedFallback) {
      this.loggedFallback = true
      logWarn('llm', `using bundled model catalog — ${reason}`)
    }
    return null
  }

  private bundled(): CatalogFile {
    const parsed = CatalogFileSchema.safeParse(bundledJson)
    if (!parsed.success) {
      // Only reachable if the bundled file was edited badly; the offline test
      // in catalog.test.ts is what normally catches this.
      throw new Error(
        `Bundled model catalog is invalid: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`
      )
    }
    return parsed.data
  }
}

export const catalogSource = new CatalogSource()
