import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { resolveInside } from './paths'

let root: string
let outside: string

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'pandora-paths-'))
  root = join(base, 'novel')
  outside = join(base, 'outside')
  await mkdir(join(root, 'chapters'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'chapters', 'one.md'), '# one', 'utf8')
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
})

afterEach(async () => {
  await rm(resolve(root, '..'), { recursive: true, force: true })
})

describe('resolveInside', () => {
  it('resolves ordinary relative paths, existing or not', () => {
    expect(resolveInside(root, 'chapters/one.md')).toBe(join(root, 'chapters', 'one.md'))
    expect(resolveInside(root, 'chapters/not-yet-written.md')).toBe(
      join(root, 'chapters', 'not-yet-written.md')
    )
    expect(resolveInside(root, 'assets/new-dir/image.png')).toBe(
      join(root, 'assets', 'new-dir', 'image.png')
    )
  })

  it('rejects traversal, absolute paths, backslashes, NUL, and the root itself', () => {
    expect(() => resolveInside(root, '../outside/secret.txt')).toThrow(/\.\./)
    expect(() => resolveInside(root, 'chapters/../../outside/secret.txt')).toThrow(/\.\./)
    expect(() => resolveInside(root, join(outside, 'secret.txt'))).toThrow(/absolute/)
    expect(() => resolveInside(root, 'chapters\\one.md')).toThrow(/backslash/)
    expect(() => resolveInside(root, 'chapters/\0one.md')).toThrow(/NUL/)
    expect(() => resolveInside(root, '')).toThrow(/outside/)
    expect(() => resolveInside(root, '.')).toThrow(/outside/)
  })

  it('rejects a symlink inside the root that points outside it', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'chapters', 'evil.md'))
    expect(() => resolveInside(root, 'chapters/evil.md')).toThrow(/outside/)
  })

  it('rejects a symlinked directory that leads outside the root', async () => {
    await symlink(outside, join(root, 'vault'), 'dir')
    expect(() => resolveInside(root, 'vault/secret.txt')).toThrow(/outside/)
    // Even for paths that don't exist yet under the escaping link.
    expect(() => resolveInside(root, 'vault/new-file.txt')).toThrow(/outside/)
  })

  it('accepts a root reached through a symlink (macOS /var vs /private/var)', async () => {
    // tmpdir() on macOS is /var/folders/…, whose realpath is /private/var/….
    // A root given in un-resolved form must still contain its own files.
    const linkedRoot = join(resolve(root, '..'), 'novel-link')
    await symlink(root, linkedRoot, 'dir')
    expect(resolveInside(linkedRoot, 'chapters/one.md')).toBe(
      join(linkedRoot, 'chapters', 'one.md')
    )
    // And the same file via the resolved form of the root.
    const realRoot = realpathSync.native(root)
    expect(resolveInside(realRoot, 'chapters/one.md')).toBe(join(realRoot, 'chapters', 'one.md'))
  })
})
