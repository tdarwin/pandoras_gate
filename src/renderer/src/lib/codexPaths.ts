/**
 * Where a Codex path belongs in the browser, and in what order.
 *
 * Shared so the sidebar and "Next suggestion" cannot disagree about what comes
 * after what — walking the novel in one order while the rows are drawn in
 * another is the kind of thing nobody notices until it feels broken.
 */

export type CodexSection =
  | 'story'
  | 'outlines'
  | 'characters'
  | 'world'
  | 'summaries'
  | 'reviews'
  | 'other'

/** Section for a Codex path, or null when it is not a Codex document. */
export function codexSection(path: string): CodexSection | null {
  if (path === 'metadata/synopsis.md') return 'story'
  if (path === 'metadata/glossary.md') return 'story'
  if (path === 'metadata/timeline.yaml') return 'story'
  if (path.startsWith('outlines/')) return 'outlines'
  if (path.startsWith('metadata/characters/')) return 'characters'
  if (path.startsWith('metadata/world/')) return 'world'
  if (path.startsWith('metadata/summaries/')) return 'summaries'
  if (path.startsWith('metadata/reviews/')) return 'reviews'
  // Anything else the proposal allowlist accepts (metadata/notes.md,
  // metadata/locations/x.md). Without a home it would be counted in the badge
  // but drawn nowhere and skipped by the walk — a dot you cannot reach.
  if (path.startsWith('metadata/')) return 'other'
  return null
}

export const CODEX_SECTIONS: CodexSection[] = [
  'story',
  'outlines',
  'characters',
  'world',
  'summaries',
  'reviews',
  'other'
]

export interface CodexListing {
  characters: { file: string }[]
  world: { file: string }[]
  summaries: { file: string }[]
  outlines: { file: string }[]
  reviews: { file: string }[]
  hasSynopsis: boolean
  hasGlossary: boolean
  hasTimeline: boolean
}

/**
 * Every Codex row in render order, with pending paths the listing does not
 * enumerate — documents that do not exist yet, and anything in "other", which
 * `metadata:list` has no bucket for — slotted into their section after the
 * real files.
 */
export function codexOrder(listing: CodexListing, pending: readonly string[]): string[] {
  const real: Record<CodexSection, string[]> = {
    story: [
      ...(listing.hasSynopsis ? ['metadata/synopsis.md'] : []),
      ...(listing.hasGlossary ? ['metadata/glossary.md'] : []),
      ...(listing.hasTimeline ? ['metadata/timeline.yaml'] : [])
    ],
    outlines: listing.outlines.map((o) => o.file),
    characters: listing.characters.map((c) => c.file),
    world: listing.world.map((w) => w.file),
    summaries: listing.summaries.map((s) => s.file),
    reviews: listing.reviews.map((r) => r.file),
    other: []
  }
  const known = new Set(Object.values(real).flat())
  const out: string[] = []
  for (const section of CODEX_SECTIONS) {
    out.push(...real[section])
    out.push(...pending.filter((p) => !known.has(p) && codexSection(p) === section))
  }
  return out
}

/**
 * The order "Next suggestion" walks: chapters as the manifest lists them, then
 * the Codex as the browser draws it.
 */
export function novelOrder(
  chapters: readonly { file: string }[],
  listing: CodexListing | null,
  pending: readonly string[]
): string[] {
  const codex = listing ? codexOrder(listing, pending) : [...pending].sort()
  return [...chapters.map((c) => c.file), ...codex]
}

/** The next path after `from` that has something pending, wrapping. */
export function nextPendingPath(
  order: readonly string[],
  pending: ReadonlySet<string>,
  from: string | null
): string | null {
  const candidates = order.filter((p) => pending.has(p))
  if (candidates.length === 0) return null
  if (from === null) return candidates[0]!
  const at = order.indexOf(from)
  if (at === -1) return candidates[0]!
  for (let i = 1; i <= order.length; i++) {
    const path = order[(at + i) % order.length]!
    if (pending.has(path)) return path
  }
  return candidates[0]!
}
