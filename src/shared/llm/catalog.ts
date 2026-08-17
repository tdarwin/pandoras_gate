import { z } from 'zod'
import { MemoryProfileSchema } from './memory'

/**
 * The model catalog and the vocabulary it is organized by.
 *
 * Novelists picking a model don't know what a 12B is, so the catalog is keyed
 * to intent instead of size: what the user wants help with (`UseCase`) and what
 * they write (`Style`). Both axes are shared with the rest of the app — a
 * `UseCase` is a model role plus chat — so a recommendation can be turned
 * straight into a role assignment.
 *
 * This module is the single source of truth for the catalog shape. `ipc.ts`
 * imports these schemas rather than restating them, and both processes derive
 * their types from here.
 */

/**
 * AI task roles a model can be assigned to. Unassigned roles fall back to the
 * chat panel's model, so nothing here is required configuration.
 */
export const MODEL_ROLES = ['drafting', 'copyEdit', 'developmental', 'codex'] as const
export type ModelRole = (typeof MODEL_ROLES)[number]
export type ModelRoleMap = Record<ModelRole, string | null>

/**
 * What a user might want help with. The four model roles plus chat — chat has
 * no role of its own because the chat panel's own picker selects it, but a
 * model can still be good or bad at open-ended conversation.
 */
export const USE_CASES = [...MODEL_ROLES, 'chat'] as const
export type UseCase = (typeof USE_CASES)[number]

/** Plain-language labels; these are the picker chips. */
export const USE_CASE_LABELS: Record<UseCase, string> = {
  drafting: 'Draft prose',
  copyEdit: 'Copy edit',
  developmental: 'Notes & continuity',
  codex: 'Keep the Codex',
  chat: 'Talk it through'
}

/** What the user writes. A soft signal — it re-ranks, it never excludes. */
export const STYLES = ['literary', 'genre', 'romance', 'grimdark', 'rpg'] as const
export type Style = (typeof STYLES)[number]

export const STYLE_LABELS: Record<Style, string> = {
  literary: 'Literary',
  genre: 'Genre fiction',
  romance: 'Romance',
  grimdark: 'Horror & grimdark',
  rpg: 'RPG & interactive'
}

export const TIERS = ['light', 'mid', 'large'] as const
export type Tier = (typeof TIERS)[number]

export const FITS = ['recommended', 'slow', 'too-large'] as const
export type Fit = (typeof FITS)[number]

/**
 * Schema version this build understands. A catalog published with a higher
 * version is ignored in favour of the bundled copy, so adding required fields
 * later can't break an already-installed app.
 *
 * Bump it only for changes an old build genuinely cannot cope with — the cost
 * is that every installed app stops taking published updates until its users
 * upgrade. Adding a use case, style or tier does *not* need a bump: unknown
 * vocabulary is filtered out on read (see `knownValues` below), so an older
 * app keeps receiving the picks it can still understand.
 */
export const CATALOG_SCHEMA_VERSION = 2

/**
 * Accepts a list of vocabulary values, dropping any this build doesn't know.
 *
 * Strict enums here would make publishing a catalog that uses a new style or
 * use case silently freeze every older install on its bundled copy — the whole
 * point of publishing the catalog is that it reaches those installs.
 */
function knownValues<const T extends readonly string[]>(
  values: T
): z.ZodType<T[number][], unknown> {
  return z
    .array(z.unknown())
    .transform((raw) =>
      raw.filter((v): v is T[number] => typeof v === 'string' && values.includes(v))
    )
}

/** Fields every recommendable model carries, local or hosted. */
const recommendableFields = {
  id: z.string().min(1),
  name: z.string().min(1),
  /** One plain sentence: what this model is *for*. */
  bestFor: z.string().min(1),
  /** The honest downside. Every model has one; saying it builds trust. */
  tradeoff: z.string().min(1),
  // An entry left with no recognizable use case can't be recommended by this
  // build, so it fails validation and gets dropped — one entry, not the catalog.
  useCases: knownValues(USE_CASES).refine((v) => v.length > 0, {
    message: 'no use case this build recognizes'
  }),
  styles: knownValues(STYLES),
  /**
   * Writes explicit content on request. The same property makes it less likely
   * to refuse anything else, which is why it's surfaced rather than inferred.
   */
  unfiltered: z.boolean(),
  contextLength: z.number().int().positive(),
  /** Drives the "Popular" pill — widely used, not necessarily best. */
  popular: z.boolean()
}

const catalogModelFields = {
  ...recommendableFields,
  /** Human-readable parameter count; "30B-A3B" for mixture-of-experts. */
  params: z.string().min(1),
  hfUri: z.string().startsWith('hf:'),
  filename: z.string().endsWith('.gguf'),
  sizeBytes: z.number().int().positive(),
  /**
   * Measured weights and KV-cache cost, so the app can work out what context
   * window *this* machine can give the model before downloading it. Written by
   * `npm run verify:catalog`, which reads the GGUF header over HTTP — never
   * hand-authored, because guessing memory is what the old
   * minMemoryGB/recommendedMemoryGB fields did badly.
   */
  memory: MemoryProfileSchema,
  license: z.string().min(1),
  tier: z.enum(TIERS)
}

export const CatalogModelSchema = z.object(catalogModelFields)

export type CatalogModel = z.infer<typeof CatalogModelSchema>

/**
 * A hosted pick is an OpenRouter slug, not a download — no file, no size, no
 * memory requirement. It still carries the same intent metadata so the picker
 * can rank local and hosted options against the same question.
 */
export const HostedPickSchema = z.object({
  ...recommendableFields,
  /** Indicative USD per million tokens; OpenRouter is authoritative at runtime. */
  approxCostPerMTok: z.object({ prompt: z.number().min(0), completion: z.number().min(0) })
})

export type HostedPick = z.infer<typeof HostedPickSchema>

export const CatalogFileSchema = z.object({
  catalogVersion: z.number().int().positive(),
  models: z.array(CatalogModelSchema),
  hosted: z.array(HostedPickSchema)
})

export type CatalogFile = z.infer<typeof CatalogFileSchema>

/**
 * Parses a catalog leniently: entries that don't validate are dropped and the
 * rest are kept.
 *
 * All-or-nothing validation means one malformed or forward-looking entry costs
 * the user every other recommendation in the file. Since the catalog is fetched
 * from the network and may be written by a newer release than the one reading
 * it, partial acceptance is the useful behaviour — the same "degrade with a
 * readable message" rule the app applies to hand-edited novel files.
 */
export function parseCatalogLenient(
  raw: unknown
): { catalog: CatalogFile; dropped: number } | { error: string } {
  const envelope = z
    .object({
      catalogVersion: z.number().int().positive(),
      models: z.array(z.unknown()),
      hosted: z.array(z.unknown())
    })
    .safeParse(raw)
  if (!envelope.success) {
    return { error: envelope.error.issues[0]?.message ?? 'not a catalog' }
  }

  const models: CatalogModel[] = []
  const hosted: HostedPick[] = []
  let dropped = 0
  for (const entry of envelope.data.models) {
    const parsed = CatalogModelSchema.safeParse(entry)
    if (parsed.success) models.push(parsed.data)
    else dropped++
  }
  for (const entry of envelope.data.hosted) {
    const parsed = HostedPickSchema.safeParse(entry)
    if (parsed.success) hosted.push(parsed.data)
    else dropped++
  }

  if (models.length === 0 && hosted.length === 0) {
    return { error: 'no usable entries' }
  }
  return { catalog: { catalogVersion: envelope.data.catalogVersion, models, hosted }, dropped }
}

/** A catalog model plus this machine's view of it. */
export const CatalogEntryStatusSchema = z.object({
  ...catalogModelFields,
  fit: z.enum(FITS),
  /** Tokens this machine can actually give the model; 0 when it cannot run. */
  usableContext: z.number().int().nonnegative(),
  /** Runs, but with too little room for the app to work well. */
  cramped: z.boolean(),
  /** Total memory at which the model becomes usable / comfortable. */
  minimumGB: z.number().positive(),
  comfortableGB: z.number().positive(),
  installedPath: z.string().nullable(),
  downloading: z.boolean(),
  downloadedBytes: z.number()
})

export type CatalogEntryStatus = z.infer<typeof CatalogEntryStatusSchema>

/* ------------------------------------------------------------------ *
 * Recommendation
 * ------------------------------------------------------------------ */

/** The minimum an entry needs to be ranked; local and hosted both satisfy it. */
export interface Scorable {
  id: string
  useCases: readonly UseCase[]
  styles: readonly Style[]
  unfiltered: boolean
  /** Absent for hosted picks, which have no local memory footprint. */
  tier?: Tier
  /** Absent for hosted picks, which always "fit". */
  fit?: Fit
}

export interface RecommendFilters {
  /** What the user wants help with. Null = no task chosen; nothing is excluded. */
  useCase: UseCase | null
  /** What they write. Always optional — it re-ranks, never excludes. */
  style: Style | null
  /** Unfiltered models stay hidden until the user opts in. */
  showUnfiltered: boolean
}

/**
 * Weights are deliberately far apart so ordering is readable rather than
 * emergent: a style match can never outrank machine fit, and tier only breaks
 * ties between otherwise equal candidates.
 */
const STYLE_MATCH = 40
const FIT_BONUS: Record<Fit, number> = { recommended: 20, slow: 0, 'too-large': 0 }
const TIER_BONUS: Record<Tier, number> = { large: 6, mid: 3, light: 0 }

function score(entry: Scorable, filters: RecommendFilters): number {
  let total = 0
  if (filters.style && entry.styles.includes(filters.style)) total += STYLE_MATCH
  if (entry.fit) total += FIT_BONUS[entry.fit]
  if (entry.tier) total += TIER_BONUS[entry.tier]
  return total
}

/**
 * Ranks catalog entries against what the user said they want.
 *
 * A chosen use case is a hard filter: offering a model that is bad at drafting
 * under the heading "for drafting" would be worse than offering nothing, and
 * the UI has a "Show all" escape hatch for the empty case. Style is soft, so a
 * romance writer still sees strong general models when no romance-tuned one
 * fits their machine.
 *
 * Ties break on id so the list never reshuffles between renders.
 */
export function recommend<T extends Scorable>(entries: readonly T[], filters: RecommendFilters): T[] {
  return entries
    .filter((e) => e.fit !== 'too-large')
    .filter((e) => filters.showUnfiltered || !e.unfiltered)
    .filter((e) => !filters.useCase || e.useCases.includes(filters.useCase))
    .map((entry) => ({ entry, points: score(entry, filters) }))
    .sort((a, b) => b.points - a.points || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry)
}

/**
 * Why this entry surfaced, for the "Why this one" line under a recommendation.
 * Mirrors the scoring above — if that changes, this must too.
 */
export function recommendationReason(entry: Scorable, filters: RecommendFilters): string {
  const reasons: string[] = []
  if (filters.useCase) reasons.push(`good at ${USE_CASE_LABELS[filters.useCase].toLowerCase()}`)
  if (filters.style && entry.styles.includes(filters.style)) {
    reasons.push(`tuned for ${STYLE_LABELS[filters.style].toLowerCase()}`)
  }
  if (entry.fit === 'recommended') reasons.push('comfortably fits your machine')
  else if (entry.fit === 'slow') reasons.push('runs on your machine, but slowly')
  if (reasons.length === 0) return ''
  const text = reasons.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1) + '.'
}
