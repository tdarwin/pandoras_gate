import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureRepo,
  commitAll,
  history,
  fileAtCommit,
  diffAgainstWorkdir,
  restoreFile
} from './service'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-git-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('git service', () => {
  it('initializes a repo and commits changes', async () => {
    await writeFile(join(dir, 'a.md'), 'hello')
    const oid = await commitAll(dir, 'first')
    expect(oid).toBeTruthy()
    const log = await history(dir)
    expect(log).toHaveLength(1)
    expect(log[0]!.message).toBe('first')
  })

  it('returns null when there is nothing to commit', async () => {
    await writeFile(join(dir, 'a.md'), 'hello')
    await commitAll(dir, 'first', ['a.md'])
    expect(await commitAll(dir, 'noop', ['a.md'])).toBeNull()
  })

  it('detects same-size sub-second rewrites via touchedPaths', async () => {
    await writeFile(join(dir, 'a.md'), 'aa')
    await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'bb') // same size, same mtime second
    const oid = await commitAll(dir, 'v2', ['a.md'])
    expect(oid).toBeTruthy()
    const log = await history(dir)
    expect(log).toHaveLength(2)
  })

  it('tracks per-file history', async () => {
    await mkdir(join(dir, 'chapters'), { recursive: true })
    await writeFile(join(dir, 'chapters/001.md'), 'v1')
    await commitAll(dir, 'chapter: one v1', ['chapters/001.md'])
    await writeFile(join(dir, 'other.md'), 'unrelated')
    await commitAll(dir, 'other change', ['other.md'])
    await writeFile(join(dir, 'chapters/001.md'), 'v2')
    await commitAll(dir, 'chapter: one v2', ['chapters/001.md'])

    const all = await history(dir)
    expect(all).toHaveLength(3)
    const chapterOnly = await history(dir, 'chapters/001.md')
    expect(chapterOnly.map((c) => c.message)).toEqual(['chapter: one v2', 'chapter: one v1'])
  })

  it('reads file content at a historical commit', async () => {
    await writeFile(join(dir, 'a.md'), 'version one')
    const first = await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'version two')
    await commitAll(dir, 'v2', ['a.md'])
    expect(await fileAtCommit(dir, first!, 'a.md')).toBe('version one')
    expect(await fileAtCommit(dir, first!, 'missing.md')).toBeNull()
  })

  it('diffs a commit against the working tree', async () => {
    await writeFile(join(dir, 'a.md'), 'line one\nline two\n')
    const first = await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'line one\nline 2\nline three\n')
    const diff = await diffAgainstWorkdir(dir, first!, 'a.md')
    expect(diff.additions).toBe(2)
    expect(diff.deletions).toBe(1)
    expect(diff.hunks.length).toBeGreaterThan(0)
  })

  it('restores a file as a new commit without moving HEAD backward', async () => {
    await writeFile(join(dir, 'a.md'), 'original')
    const first = await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'changed')
    await commitAll(dir, 'v2', ['a.md'])

    const restoreOid = await restoreFile(dir, first!, 'a.md', 'a.md')
    expect(restoreOid).toBeTruthy()
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('original')

    const log = await history(dir)
    expect(log).toHaveLength(3)
    expect(log[0]!.message).toContain('restore')
    // The pre-restore version is still reachable.
    expect(await fileAtCommit(dir, log[1]!.oid, 'a.md')).toBe('changed')
  })

  it('ensureRepo is idempotent', async () => {
    await ensureRepo(dir)
    await ensureRepo(dir)
    await writeFile(join(dir, 'a.md'), 'x')
    expect(await commitAll(dir, 'ok')).toBeTruthy()
  })

  it('respects .gitignore', async () => {
    await writeFile(join(dir, '.gitignore'), 'private/\n')
    await mkdir(join(dir, 'private'), { recursive: true })
    await writeFile(join(dir, 'private/secret.json'), '{}')
    await writeFile(join(dir, 'a.md'), 'public')
    await commitAll(dir, 'first')
    const log = await history(dir, 'private/secret.json')
    expect(log).toHaveLength(0)
  })
})
