import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRemoteUrl, setRemoteUrl, getRemoteUrl } from './sync'
import { ensureRepo, commitAll } from './service'

describe('normalizeRemoteUrl', () => {
  it('passes https urls through', () => {
    expect(normalizeRemoteUrl('https://github.com/me/novel.git')).toBe(
      'https://github.com/me/novel.git'
    )
    expect(normalizeRemoteUrl('  https://gitlab.com/me/novel  ')).toBe(
      'https://gitlab.com/me/novel'
    )
  })

  it('converts ssh forms to https', () => {
    expect(normalizeRemoteUrl('git@github.com:me/novel.git')).toBe(
      'https://github.com/me/novel.git'
    )
    expect(normalizeRemoteUrl('git@gitlab.com:group/sub/novel')).toBe(
      'https://gitlab.com/group/sub/novel.git'
    )
    expect(normalizeRemoteUrl('ssh://git@github.com/me/novel.git')).toBe(
      'https://github.com/me/novel.git'
    )
  })

  it('rejects everything else', () => {
    expect(() => normalizeRemoteUrl('ftp://example.com/repo')).toThrow()
    expect(() => normalizeRemoteUrl('not a url')).toThrow()
  })
})

describe('remote config', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pandora-sync-'))
    await ensureRepo(dir)
    await writeFile(join(dir, 'a.md'), 'x')
    await commitAll(dir, 'init', ['a.md'])
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores and reads back the origin remote, replacing on change', async () => {
    expect(await getRemoteUrl(dir)).toBeNull()
    await setRemoteUrl(dir, 'git@github.com:me/novel.git')
    expect(await getRemoteUrl(dir)).toBe('https://github.com/me/novel.git')
    await setRemoteUrl(dir, 'https://gitlab.com/me/other.git')
    expect(await getRemoteUrl(dir)).toBe('https://gitlab.com/me/other.git')
  })
})
