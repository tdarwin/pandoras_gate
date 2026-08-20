import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveAssetUrl } from './scheme'

// resolveAssetUrl is pure; electron is only needed by the register functions.
vi.mock('electron', () => ({
  net: {},
  protocol: {}
}))

let base: string
let themes: string
let novel: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'pandora-scheme-'))
  themes = join(base, 'themes')
  novel = join(base, 'novel')
  await mkdir(join(themes, 'gruvbox'), { recursive: true })
  await mkdir(join(novel, 'assets'), { recursive: true })
  await writeFile(join(themes, 'gruvbox', 'paper.png'), 'png', 'utf8')
  await writeFile(join(novel, 'assets', 'map.png'), 'png', 'utf8')
  await writeFile(join(base, 'secret.png'), 'png', 'utf8')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const roots = (): { themes: string; novel: string | null } => ({ themes, novel })

describe('resolveAssetUrl', () => {
  it('serves theme and novel images from their roots', () => {
    expect(resolveAssetUrl('pandora-asset://themes/gruvbox/paper.png', roots())).toBe(
      join(themes, 'gruvbox', 'paper.png')
    )
    expect(resolveAssetUrl('pandora-asset://novel/assets/map.png', roots())).toBe(
      join(novel, 'assets', 'map.png')
    )
  })

  it('clamps traversal at the root — literal and percent-encoded alike', () => {
    // WHATWG URL parsing treats ".." AND "%2e%2e" segments as dot-segments
    // and clamps them at the path root, so the worst a traversal can reach
    // is the top of the SAME root — never outside it. resolveInside stays as
    // the second net for anything decodeURIComponent could still surface.
    expect(resolveAssetUrl('pandora-asset://novel/assets/../../../secret.png', roots())).toBe(
      join(novel, 'secret.png')
    )
    expect(resolveAssetUrl('pandora-asset://novel/%2e%2e/secret.png', roots())).toBe(
      join(novel, 'secret.png')
    )
    expect(resolveAssetUrl('pandora-asset://themes/%2e%2e/novel/assets/map.png', roots())).toBe(
      join(themes, 'novel', 'assets', 'map.png')
    )
  })

  it('refuses unknown hosts, schemes, and non-image extensions', () => {
    expect(resolveAssetUrl('pandora-asset://elsewhere/x.png', roots())).toBeNull()
    expect(resolveAssetUrl('file:///etc/hosts', roots())).toBeNull()
    expect(resolveAssetUrl('pandora-asset://novel/novel.yaml', roots())).toBeNull()
    expect(resolveAssetUrl('pandora-asset://novel/chapters/one.md', roots())).toBeNull()
    expect(resolveAssetUrl('pandora-asset://novel/', roots())).toBeNull()
    expect(resolveAssetUrl('not a url', roots())).toBeNull()
  })

  it('refuses novel URLs when no novel is open', () => {
    expect(
      resolveAssetUrl('pandora-asset://novel/assets/map.png', { themes, novel: null })
    ).toBeNull()
  })

  it('refuses a symlink that escapes its root even with an image extension', async () => {
    await symlink(join(base, 'secret.png'), join(novel, 'assets', 'evil.png'))
    expect(resolveAssetUrl('pandora-asset://novel/assets/evil.png', roots())).toBeNull()
  })

  it('serves through a symlinked root (macOS /var alias)', () => {
    // tmpdir() itself is usually behind /var → /private/var on macOS, so the
    // happy-path assertions above already exercise the un-resolved-root case;
    // this pins it explicitly with resolve().
    expect(
      resolveAssetUrl('pandora-asset://novel/assets/map.png', {
        themes,
        novel: resolve(novel)
      })
    ).toBe(join(novel, 'assets', 'map.png'))
  })
})
