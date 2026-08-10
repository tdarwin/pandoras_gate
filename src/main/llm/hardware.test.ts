import { describe, it, expect } from 'vitest'
import { fitForModel, type HardwareInfo } from './hardware'

const mac16: HardwareInfo = {
  totalMemoryGB: 16,
  platform: 'darwin',
  arch: 'arm64',
  appleSilicon: true
}

describe('fitForModel', () => {
  it('recommends models within the recommended memory', () => {
    expect(fitForModel(mac16, 6, 8)).toBe('recommended')
    expect(fitForModel(mac16, 12, 16)).toBe('recommended')
  })

  it('marks models runnable-but-slow between min and recommended', () => {
    expect(fitForModel(mac16, 14, 18)).toBe('slow')
  })

  it('rejects models above min memory', () => {
    expect(fitForModel(mac16, 24, 32)).toBe('too-large')
    expect(fitForModel(mac16, 48, 64)).toBe('too-large')
  })

  it('boundary: exactly min memory runs slow, exactly recommended runs well', () => {
    expect(fitForModel(mac16, 16, 24)).toBe('slow')
    expect(fitForModel(mac16, 8, 16)).toBe('recommended')
  })
})
