import { describe, it, expect } from 'vitest'
import { nextSpeed, etaSeconds, formatSpeed, formatEta } from './downloads'

describe('nextSpeed', () => {
  it('uses the instantaneous speed for the first sample', () => {
    // 1 MB in 1s
    expect(nextSpeed(0, 1024 ** 2, 1000)).toBe(1024 ** 2)
  })

  it('smooths subsequent samples', () => {
    const prev = 1000
    const next = nextSpeed(prev, 2000, 1000) // instant = 2000 B/s
    expect(next).toBeGreaterThan(prev)
    expect(next).toBeLessThan(2000)
    expect(next).toBeCloseTo(0.3 * 2000 + 0.7 * 1000)
  })

  it('ignores zero/negative time deltas and byte regressions', () => {
    expect(nextSpeed(500, 1000, 0)).toBe(500)
    expect(nextSpeed(500, -100, 1000)).toBe(500)
  })
})

describe('etaSeconds', () => {
  it('computes remaining time from speed', () => {
    expect(etaSeconds({ downloadedBytes: 500, totalBytes: 1500, speedBps: 100 })).toBe(10)
  })

  it('returns null without a speed or total', () => {
    expect(etaSeconds({ downloadedBytes: 0, totalBytes: 100, speedBps: 0 })).toBeNull()
    expect(etaSeconds({ downloadedBytes: 0, totalBytes: 0, speedBps: 10 })).toBeNull()
  })

  it('clamps completed downloads to zero', () => {
    expect(etaSeconds({ downloadedBytes: 200, totalBytes: 100, speedBps: 10 })).toBe(0)
  })
})

describe('formatting', () => {
  it('formats speeds by magnitude', () => {
    expect(formatSpeed(500)).toBe('500 B/s')
    expect(formatSpeed(2048)).toBe('2 KB/s')
    expect(formatSpeed(5.5 * 1024 ** 2)).toBe('5.5 MB/s')
  })

  it('formats ETAs by magnitude', () => {
    expect(formatEta(null)).toBe('…')
    expect(formatEta(45)).toBe('45s')
    expect(formatEta(125)).toBe('2m 5s')
    expect(formatEta(7300)).toBe('2h 1m')
  })
})
