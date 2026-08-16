import { z } from 'zod'

/**
 * How much context a given machine can actually give a given model.
 *
 * The old model was a single constant — every local model registered at 16k
 * regardless of its size or the machine's memory. That is wrong in both
 * directions: a 4B model on a 16GB laptop can hold well over 100k tokens, while
 * a 20B model on the same machine has room for about 4k. For an app whose whole
 * premise is that novels outgrow the context window, guessing here is expensive.
 *
 * The real constraint is simple: weights and KV cache share one pool.
 *
 *     available  =  memory − (OS + app)
 *     context    =  the largest window whose KV cache fits in available − weights
 *
 * KV cache is not a rounding error. A 4B model at its trained 262k window needs
 * ~17GB of cache against 2.5GB of weights — nearly seven times the model itself.
 *
 * These are estimates for *advice*: which model to download, and what to tell
 * the user they will get. The authority at load time is node-llama-cpp, which
 * resolves the real size against live VRAM state.
 */

const GB = 1024 ** 3

export const ContextCostSampleSchema = z.object({
  contextSize: z.number().int().positive(),
  /** Total bytes (weights excluded) to hold a context this size. */
  bytes: z.number().int().positive()
})

export type ContextCostSample = z.infer<typeof ContextCostSampleSchema>

export const MemoryProfileSchema = z.object({
  /** Bytes the weights occupy once loaded. */
  weightsBytes: z.number().int().positive(),
  /** The window the model was trained on — the ceiling on any of this. */
  trainContextLength: z.number().int().positive(),
  /**
   * Measured cost at sampled window sizes, ascending. Sampled rather than
   * computed from a formula because KV cost is not linear in context and
   * varies with sliding-window attention, MoE routing, and quantized caches —
   * node-llama-cpp's estimator knows all of that and we do not.
   */
  contextCost: z.array(ContextCostSampleSchema).min(1)
})

export type MemoryProfile = z.infer<typeof MemoryProfileSchema>

/** The window sizes profiles are sampled at. */
export const CONTEXT_SAMPLES = [
  4096, 8192, 16384, 32768, 65536, 131072, 262144
] as const

/**
 * Two limits, whichever binds first.
 *
 * `SYSTEM_RESERVE_BYTES` is roughly constant — macOS plus this Electron app
 * need about the same few gigabytes whatever the machine. `MAX_FRACTION` stops
 * one model from swallowing a large machine that the user also works on.
 *
 * Applying both as a *minimum* rather than subtracting one from the other
 * matters at the low end: reserving a fraction *and* a fixed floor took half
 * of an 8GB machine and concluded no local model could run at all, which is
 * both wrong and useless advice.
 *
 * Sized against *total* rather than free memory deliberately — free memory
 * swings by gigabytes minute to minute, and advice that changes every time you
 * open the dialog is worse than advice that is slightly pessimistic.
 */
const SYSTEM_RESERVE_BYTES = 3.5 * GB
const MAX_FRACTION = 0.85

/** Below this the app cannot do its job — no room for context and a reply. */
export const MINIMUM_CONTEXT = 4096

/** Works, but tight enough that the user should consider a hosted model. */
export const CRAMPED_CONTEXT = 8192

/** At or below this the assembler goes retrieval-first (LEAN_CONTEXT_BUDGET_MAX). */
export const COMFORTABLE_CONTEXT = 16384

/**
 * Default ceiling on the window we will ask for. Past this the KV cache costs
 * far more memory than the extra reach is worth for chapter-scale work, and
 * the context assembler targets ~12-24k anyway.
 */
export const DEFAULT_CONTEXT_CEILING = 65536

/** Memory one model may use, after the OS and the rest of the app. */
export function usableMemoryBytes(totalMemoryBytes: number): number {
  return Math.max(
    0,
    Math.min(totalMemoryBytes - SYSTEM_RESERVE_BYTES, totalMemoryBytes * MAX_FRACTION)
  )
}

/**
 * Largest sampled window this machine can give this model, or 0 if it cannot
 * even hold the minimum. Only sampled sizes are returned — interpolating would
 * imply precision the estimate does not have.
 */
export function usableContext(
  profile: MemoryProfile,
  totalMemoryBytes: number,
  ceiling: number = DEFAULT_CONTEXT_CEILING
): number {
  const forContext = usableMemoryBytes(totalMemoryBytes) - profile.weightsBytes
  if (forContext <= 0) return 0

  let best = 0
  for (const sample of profile.contextCost) {
    if (sample.contextSize > ceiling) break
    if (sample.contextSize > profile.trainContextLength) break
    if (sample.bytes <= forContext) best = sample.contextSize
    else break
  }
  return best >= MINIMUM_CONTEXT ? best : 0
}

export type MemoryFit = 'recommended' | 'slow' | 'too-large'

export interface MemoryVerdict {
  fit: MemoryFit
  /** Tokens this machine can actually give the model; 0 when it cannot run. */
  usableContext: number
  /**
   * Runs, but with so little room that the app will struggle — the picker
   * warns and points at hosted models instead.
   */
  cramped: boolean
}

/**
 * Whether this model is worth recommending on this machine, and what the user
 * will actually get if they download it.
 */
export function memoryVerdict(
  profile: MemoryProfile,
  totalMemoryBytes: number,
  ceiling: number = DEFAULT_CONTEXT_CEILING
): MemoryVerdict {
  const context = usableContext(profile, totalMemoryBytes, ceiling)
  if (context === 0) return { fit: 'too-large', usableContext: 0, cramped: false }
  return {
    fit: context < COMFORTABLE_CONTEXT ? 'slow' : 'recommended',
    usableContext: context,
    cramped: context < CRAMPED_CONTEXT
  }
}

/**
 * Total memory at which a model first becomes usable / comfortable. Derived
 * from the profile rather than hand-authored per model, so the two can't drift.
 */
export function memoryRequirementsGB(profile: MemoryProfile): {
  minimumGB: number
  comfortableGB: number
} {
  const costAt = (want: number): number => {
    const sample =
      profile.contextCost.find((s) => s.contextSize >= want) ?? profile.contextCost.at(-1)
    return sample?.bytes ?? 0
  }
  // Invert usableMemoryBytes: both limits must clear the requirement, so the
  // answer is whichever demands the larger machine.
  const totalFor = (contextBytes: number): number => {
    const need = profile.weightsBytes + contextBytes
    return Math.max(need + SYSTEM_RESERVE_BYTES, need / MAX_FRACTION) / GB
  }

  return {
    minimumGB: Math.ceil(totalFor(costAt(MINIMUM_CONTEXT))),
    comfortableGB: Math.ceil(totalFor(costAt(COMFORTABLE_CONTEXT)))
  }
}

/** "96k" / "8k" — for card copy. */
export function formatContext(tokens: number): string {
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`
  return String(tokens)
}
