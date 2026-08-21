import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const secrets = vi.hoisted(() => ({ getSecret: vi.fn(), setSecret: vi.fn() }))
vi.mock('../secrets', () => secrets)

import fs from 'node:fs'
import git from 'isomorphic-git'
import { normalizeRemoteUrl, setRemoteUrl, getRemoteUrl, pushToRemote } from './sync'
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

  it('rejects plain http (the token would travel in cleartext)', () => {
    expect(() => normalizeRemoteUrl('http://github.com/me/novel.git')).toThrow()
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

  it('binds the sync host when a remote is configured', async () => {
    secrets.setSecret.mockClear()
    await setRemoteUrl(dir, 'https://github.com/me/novel.git')
    expect(secrets.setSecret).toHaveBeenCalledWith('git-sync-host', 'github.com')
  })
})

describe('pushToRemote host binding', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pandora-push-'))
    await ensureRepo(dir)
    await writeFile(join(dir, 'a.md'), 'x')
    await commitAll(dir, 'init', ['a.md'])
    secrets.getSecret.mockReset()
    secrets.setSecret.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to send the token when origin is not the authorized host', async () => {
    // A novel folder that arrived with a foreign origin in its .git/config —
    // written directly, not through setRemoteUrl (which would authorize it).
    await git.addRemote({ fs, dir, remote: 'origin', url: 'https://evil.example/me/novel.git' })
    secrets.getSecret.mockImplementation(async (name: string) =>
      name === 'git-sync-token' ? 'ghp_secret' : name === 'git-sync-host' ? 'github.com' : null
    )
    await expect(pushToRemote(dir)).rejects.toThrow(/evil\.example.*github\.com/s)
    // Guard fired before any token binding was (re)written.
    expect(secrets.setSecret).not.toHaveBeenCalled()
  })

  it('refuses an http:// origin read from .git/config (never sends the token in cleartext)', async () => {
    // normalizeRemoteUrl only guards the Sync form; the origin here bypasses it.
    // Even on the authorized host, http:// must be rejected before git.push.
    await git.addRemote({ fs, dir, remote: 'origin', url: 'http://github.com/me/novel.git' })
    secrets.getSecret.mockImplementation(async (name: string) =>
      name === 'git-sync-token' ? 'ghp_secret' : name === 'git-sync-host' ? 'github.com' : null
    )
    await expect(pushToRemote(dir)).rejects.toThrow(/https:\/\/|cleartext/)
    // No token binding written, and the token was never resolved for a push.
    expect(secrets.setSecret).not.toHaveBeenCalled()
  })
})
