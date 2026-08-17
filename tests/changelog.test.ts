import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Repo-level release guards.
 *
 * The changelog is the release notes — `.github/workflows/release.yml` feeds the
 * matching section to `gh release create`. So a version bump without an entry
 * ships a release with nothing to read, and these run in CI before any tag can
 * be built.
 */

const root = join(import.meta.dirname, '..')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

/** `## [0.5.0] — 2026-08-17` → `0.5.0`, in file order. */
const headings = [...changelog.matchAll(/^##\s+\[([^\]]+)\](?:\s+—\s+(\S+))?/gm)].map((m) => ({
  version: m[1],
  date: m[2]
}))

const releases = headings.filter((h) => h.version !== 'Unreleased')

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

describe('CHANGELOG', () => {
  it('has an entry for the version in package.json', () => {
    expect(
      releases.map((r) => r.version),
      `package.json is ${pkg.version} with no matching CHANGELOG entry — releasing it would ship empty notes`
    ).toContain(pkg.version)
  })

  it('produces non-empty release notes for the current version', () => {
    const notes = execFileSync(
      process.execPath,
      [join(root, 'scripts/changelog-section.mjs'), pkg.version],
      { encoding: 'utf8' }
    )
    expect(notes.trim().length).toBeGreaterThan(50)
    // The heading is dropped — the release is already titled with the version.
    expect(notes).not.toMatch(/^##\s+\[/m)
    // Link-reference lines are stripped, not shipped as literal text.
    expect(notes).not.toMatch(/^\[[^\]]+\]:\s+https?:/m)
  })

  it('keeps an Unreleased section for work in flight', () => {
    expect(headings[0]?.version).toBe('Unreleased')
  })

  it('lists releases newest first', () => {
    for (let i = 1; i < releases.length; i++) {
      expect(
        compare(releases[i - 1].version, releases[i].version),
        `${releases[i - 1].version} should sort above ${releases[i].version}`
      ).toBeGreaterThan(0)
    }
  })

  it('dates every release', () => {
    for (const r of releases) {
      expect(r.date, `${r.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('gives every version a compare link', () => {
    for (const { version } of headings) {
      expect(changelog, `no link reference for [${version}]`).toContain(`[${version}]: https://`)
    }
  })

  it('exits non-zero for an unknown version so the workflow can fall back', () => {
    // The release workflow relies on this to degrade to --generate-notes
    // rather than publishing a release with no notes at all.
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/changelog-section.mjs'), '99.99.99'], {
        stdio: 'pipe'
      })
    ).toThrow()
  })
})
