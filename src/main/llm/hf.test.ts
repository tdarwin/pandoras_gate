import { describe, it, expect, vi } from 'vitest'
import { parseGgufSiblings, quantOf, searchHfGgufModels } from './hf'
import { fitForSize, type HardwareInfo } from './hardware'

describe('quantOf', () => {
  it('extracts common quant labels', () => {
    expect(quantOf('Qwen2.5-14B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantOf('model-IQ3_XS.gguf')).toBe('IQ3_XS')
    expect(quantOf('SmolLM2-135M-Instruct-Q8_0.gguf')).toBe('Q8_0')
    expect(quantOf('model.f16.gguf')).toBe('F16')
    expect(quantOf('Llama-3.3-70B-Instruct-Q4_K_M-00001-of-00002.gguf')).toBe('Q4_K_M')
    expect(quantOf('weird-name.gguf')).toBe('unknown')
  })
})

describe('parseGgufSiblings', () => {
  it('filters non-gguf files and sorts by size', () => {
    const files = parseGgufSiblings([
      { rfilename: 'README.md', size: 100 },
      { rfilename: 'big-Q8_0.gguf', size: 900 },
      { rfilename: 'small-Q2_K.gguf', size: 100 },
      { rfilename: '.gitattributes', size: 10 }
    ])
    expect(files.map((f) => f.filename)).toEqual(['small-Q2_K.gguf', 'big-Q8_0.gguf'])
    expect(files.every((f) => f.parts === 1)).toBe(true)
  })

  it('collapses multi-part models into the first part with summed size', () => {
    const files = parseGgufSiblings([
      { rfilename: 'L-70B-Q4_K_M-00001-of-00002.gguf', size: 600 },
      { rfilename: 'L-70B-Q4_K_M-00002-of-00002.gguf', size: 400 },
      { rfilename: 'L-70B-Q2_K.gguf', size: 500 }
    ])
    expect(files).toHaveLength(2)
    const multi = files.find((f) => f.parts === 2)!
    expect(multi.filename).toBe('L-70B-Q4_K_M-00001-of-00002.gguf')
    expect(multi.sizeBytes).toBe(1000)
    expect(multi.quant).toBe('Q4_K_M')
  })

  it('drops multipart groups missing their first part', () => {
    const files = parseGgufSiblings([
      { rfilename: 'L-Q4_K_M-00002-of-00003.gguf', size: 400 },
      { rfilename: 'L-Q4_K_M-00003-of-00003.gguf', size: 400 }
    ])
    expect(files).toHaveLength(0)
  })
})

describe('fitForSize', () => {
  const mac16: HardwareInfo = {
    totalMemoryGB: 16,
    platform: 'darwin',
    arch: 'arm64',
    appleSilicon: true
  }
  const GB = 1024 ** 3

  it('small models fit well, huge models are rejected', () => {
    expect(fitForSize(mac16, 4 * GB)).toBe('recommended')
    expect(fitForSize(mac16, 30 * GB)).toBe('too-large')
  })

  it('borderline models are marked slow', () => {
    // ~10.5GB: min ≈ 13.1, recommended ≈ 17.7 → slow on 16GB
    expect(fitForSize(mac16, 10.5 * GB)).toBe('slow')
  })
})

describe('searchHfGgufModels', () => {
  it('maps and filters search results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: 'a/model', downloads: 10, likes: 2 },
            { id: 'b/private', private: true, downloads: 99 },
            { id: 'c/gated', gated: 'auto', downloads: 5, likes: 1 }
          ]),
          { status: 200 }
        )
      )
    )
    const repos = await searchHfGgufModels('test')
    expect(repos.map((r) => r.id)).toEqual(['a/model', 'c/gated'])
    expect(repos[1]!.gated).toBe(true)
    vi.unstubAllGlobals()
  })
})
