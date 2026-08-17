/**
 * Prints one version's section of CHANGELOG.md, for use as GitHub release notes.
 *
 *   node scripts/changelog-section.mjs 0.5.0
 *
 * Exits 1 with nothing on stdout when the version has no entry, which the
 * release workflow treats as "fall back to --generate-notes". A missing
 * changelog entry should never be the reason a release fails to publish.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('usage: changelog-section.mjs <version>')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = await readFile(join(root, 'CHANGELOG.md'), 'utf8').catch(() => null)
if (text === null) {
  console.error('CHANGELOG.md not found')
  process.exit(1)
}

const lines = text.split('\n')
// Headings look like `## [0.5.0] — 2026-08-17`; match on the bracketed version
// so the date format stays free to change.
const isHeading = (line) => /^##\s+\[/.test(line)
const headingVersion = (line) => line.match(/^##\s+\[([^\]]+)\]/)?.[1]

const start = lines.findIndex((l) => isHeading(l) && headingVersion(l) === version)
if (start === -1) {
  console.error(`No CHANGELOG entry for ${version}`)
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (isHeading(lines[i])) {
    end = i
    break
  }
}

// Drop the heading itself (the release is already titled with the version) and
// the link-reference block that trails the file.
const body = lines
  .slice(start + 1, end)
  .filter((l) => !/^\[[^\]]+\]:\s+https?:/.test(l))
  .join('\n')
  .trim()

if (!body) {
  console.error(`CHANGELOG entry for ${version} is empty`)
  process.exit(1)
}

console.log(body)
