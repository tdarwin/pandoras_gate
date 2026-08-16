import { describe, it, expect } from 'vitest'
import {
  CONTEXT_SAMPLES,
  COMFORTABLE_CONTEXT,
  MINIMUM_CONTEXT,
  formatContext,
  memoryRequirementsGB,
  memoryVerdict,
  usableContext,
  usableMemoryBytes,
  type MemoryProfile
} from './memory'

const GB = 1024 ** 3

/**
 * Profiles shaped like the real measurements taken from GGUF headers, so the
 * thresholds are exercised against plausible numbers rather than round ones.
 */
function profile(weightsGB: number, kvGbAt16k: number, trainContext = 262144): MemoryProfile {
  return {
    weightsBytes: Math.round(weightsGB * GB),
    trainContextLength: trainContext,
    // KV cost grows roughly with window size; sampled the way the real
    // profiles are.
    contextCost: CONTEXT_SAMPLES.filter((c) => c <= trainContext).map((contextSize) => ({
      contextSize,
      bytes: Math.round((kvGbAt16k * GB * contextSize) / 16384)
    }))
  }
}

/** Qwen 3.5 4B, measured: 3.0GB weights, ~1.56GB of cache at 16k. */
const small = profile(3.0, 1.56)
/** GPT-OSS 20B, measured: 11.2GB weights. */
const large = profile(11.2, 2.2)

describe('usableMemoryBytes', () => {
  it('is limited by the fixed OS reserve on a small machine', () => {
    expect(usableMemoryBytes(8 * GB) / GB).toBeCloseTo(4.5, 1)
    expect(usableMemoryBytes(16 * GB) / GB).toBeCloseTo(12.5, 1)
  })

  it('is limited by the fraction on a large machine, so one model cannot hog it', () => {
    expect(usableMemoryBytes(64 * GB) / GB).toBeCloseTo(54.4, 1)
    expect(usableMemoryBytes(128 * GB) / GB).toBeCloseTo(108.8, 1)
  })

  it('never goes negative on a tiny machine', () => {
    expect(usableMemoryBytes(2 * GB)).toBe(0)
  })

  it('leaves an 8GB machine enough for a small model — the reserve is not doubled', () => {
    // Regression: reserving a fraction *and* a fixed floor took half of an 8GB
    // machine and wrongly concluded nothing could run locally.
    expect(usableContext(small, 8 * GB)).toBeGreaterThanOrEqual(MINIMUM_CONTEXT)
  })
})

describe('usableContext', () => {
  it('gives a small model a large window on a modest machine', () => {
    // The headline failure of the old flat 16k cap: this model could have had
    // far more all along.
    const got = usableContext(small, 16 * GB)
    expect(got).toBeGreaterThan(COMFORTABLE_CONTEXT)
  })

  it('returns zero when the weights alone do not fit', () => {
    expect(usableContext(large, 8 * GB)).toBe(0)
  })

  it('returns zero rather than a useless sliver below the minimum', () => {
    // Room for the weights (12GB of 12.5GB usable), but not for even the
    // smallest usable window on top.
    const tight = profile(12, 4)
    expect(usableContext(tight, 16 * GB)).toBe(0)
  })

  it('respects the ceiling', () => {
    expect(usableContext(small, 256 * GB, 32768)).toBe(32768)
  })

  it('never exceeds the window the model was trained on', () => {
    const shortTrained = profile(1, 0.2, 8192)
    expect(usableContext(shortTrained, 256 * GB, 262144)).toBe(8192)
  })

  it('only ever returns a sampled size', () => {
    for (const total of [8, 16, 24, 32, 48, 64, 128]) {
      const got = usableContext(small, total * GB, 262144)
      expect(got === 0 || (CONTEXT_SAMPLES as readonly number[]).includes(got)).toBe(true)
    }
  })

  it('grows monotonically with machine memory', () => {
    let previous = 0
    for (const total of [8, 16, 24, 32, 48, 64, 128, 256]) {
      const got = usableContext(small, total * GB, 262144)
      expect(got).toBeGreaterThanOrEqual(previous)
      previous = got
    }
  })

  it('gives a bigger model less room than a smaller one on the same machine', () => {
    // Ceiling lifted, or both models simply clamp to it and the comparison
    // proves nothing.
    expect(usableContext(large, 32 * GB, 262144)).toBeLessThan(
      usableContext(small, 32 * GB, 262144)
    )
  })

  it('clamps both large and small models to the ceiling when memory is ample', () => {
    expect(usableContext(large, 128 * GB)).toBe(usableContext(small, 128 * GB))
  })
})

describe('memoryVerdict', () => {
  it('recommends a model with a comfortable window', () => {
    const v = memoryVerdict(small, 32 * GB)
    expect(v.fit).toBe('recommended')
    expect(v.cramped).toBe(false)
    expect(v.usableContext).toBeGreaterThanOrEqual(COMFORTABLE_CONTEXT)
  })

  it('rules out a model that cannot hold the minimum window', () => {
    const v = memoryVerdict(large, 8 * GB)
    expect(v).toEqual({ fit: 'too-large', usableContext: 0, cramped: false })
  })

  it('flags a model that runs but only just', () => {
    // 12.5GB usable on a 16GB machine, 10.5GB of weights: the 4k sample (1.5GB)
    // fits, the 8k one (3GB) does not.
    const squeezed = profile(10.5, 6)
    const v = memoryVerdict(squeezed, 16 * GB)
    expect(v.usableContext).toBe(MINIMUM_CONTEXT)
    expect(v.fit).toBe('slow')
    expect(v.cramped).toBe(true)
  })

  it('boundary: exactly the comfortable window is not slow and not cramped', () => {
    const v = memoryVerdict(profile(2, 1), 32 * GB, COMFORTABLE_CONTEXT)
    expect(v.usableContext).toBe(COMFORTABLE_CONTEXT)
    expect(v.fit).toBe('recommended')
    expect(v.cramped).toBe(false)
  })

  it('a cramped verdict is always also a running one', () => {
    for (const weights of [1, 3, 5, 7, 9, 11, 13]) {
      const v = memoryVerdict(profile(weights, 2), 16 * GB)
      if (v.cramped) {
        expect(v.usableContext).toBeGreaterThan(0)
        expect(v.fit).not.toBe('too-large')
      }
    }
  })
})

describe('memoryRequirementsGB', () => {
  it('derives sane, ordered requirements', () => {
    const { minimumGB, comfortableGB } = memoryRequirementsGB(small)
    expect(minimumGB).toBeLessThan(comfortableGB)
    expect(minimumGB).toBeGreaterThan(3) // can't need less than the weights
  })

  it('agrees with the verdict it describes', () => {
    // A machine at the stated comfortable size must actually get a comfortable
    // window — otherwise the number on the card is a lie.
    for (const p of [small, large, profile(6, 1.2), profile(20, 3)]) {
      const { minimumGB, comfortableGB } = memoryRequirementsGB(p)
      expect(memoryVerdict(p, comfortableGB * GB).usableContext).toBeGreaterThanOrEqual(
        COMFORTABLE_CONTEXT
      )
      expect(memoryVerdict(p, minimumGB * GB).fit).not.toBe('too-large')
    }
  })
})

describe('formatContext', () => {
  it('reads the way a person would say it', () => {
    expect(formatContext(98304)).toBe('96k')
    expect(formatContext(16384)).toBe('16k')
    expect(formatContext(4096)).toBe('4k')
    expect(formatContext(512)).toBe('512')
  })
})
