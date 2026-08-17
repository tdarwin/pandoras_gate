import os from 'node:os'
import type { Fit } from '../../shared/llm/catalog'

// Defined with the catalog schema so main, renderer, and catalog.json can't
// disagree about what a fit label is.
export type { Fit }

export interface HardwareInfo {
  totalMemoryGB: number
  platform: 'darwin' | 'win32' | 'linux'
  arch: string
  /** Apple Silicon shares RAM with the GPU (unified memory). */
  appleSilicon: boolean
}

export function detectHardware(): HardwareInfo {
  return {
    totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
    platform: process.platform as HardwareInfo['platform'],
    arch: process.arch,
    appleSilicon: process.platform === 'darwin' && process.arch === 'arm64'
  }
}

/**
 * Sizing heuristic: the model working set (weights + KV cache headroom) should
 * stay well under total memory. Unified memory on Apple Silicon means RAM ≈
 * VRAM; on other platforms RAM is still the practical ceiling for our CPU/GPU
 * split loading.
 */
export function fitForModel(hw: HardwareInfo, minMemoryGB: number, recommendedMemoryGB: number): Fit {
  if (hw.totalMemoryGB >= recommendedMemoryGB) return 'recommended'
  if (hw.totalMemoryGB >= minMemoryGB) return 'slow'
  return 'too-large'
}

/**
 * Fit estimate for an arbitrary GGUF where all we know is the file size:
 * weights need roughly their file size in memory, plus KV-cache and runtime
 * overhead, plus room for the OS and the app itself.
 */
export function fitForSize(hw: HardwareInfo, sizeBytes: number): Fit {
  const sizeGB = sizeBytes / 1024 ** 3
  const minGB = sizeGB * 1.15 + 1
  const recommendedGB = sizeGB * 1.4 + 3
  return fitForModel(hw, minGB, recommendedGB)
}
