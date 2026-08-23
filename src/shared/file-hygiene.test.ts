import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * macOS Finder and iCloud make copies named "thing 2.ts" beside the original.
 * Two of them reached a commit here: one was compiled by tsconfig and doubled
 * the maintenance surface of the most safety-critical file in the branch, and
 * the other was a test file vitest never ran, because `include` is
 * `src/**​/*.test.ts` and the name ends in " 2.ts". Both were invisible until
 * someone counted the test files.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('source tree hygiene', () => {
  it('has no duplicate files left behind by the OS', () => {
    const duplicates = walk('src').filter((path) => / \d+\.[a-z]+$/.test(path))
    expect(duplicates).toEqual([])
  })
})
