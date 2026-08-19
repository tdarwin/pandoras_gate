import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('restore commits uncommitted changes before rewriting the file', async () => {
    await writeFile(join(dir, 'a.md'), 'v1')
    const first = await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'v2')
    await commitAll(dir, 'v2', ['a.md'])
    // A quiet save that never reached a commit.
    await writeFile(join(dir, 'a.md'), 'v2 plus unsaved typing')

    await restoreFile(dir, first!, 'a.md', 'a.md')
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('v1')
    const log = await history(dir, 'a.md')
    const preRestore = log.find((c) => c.message.includes('before restore'))
    expect(preRestore).toBeDefined()
    expect(await fileAtCommit(dir, preRestore!.oid, 'a.md')).toBe('v2 plus unsaved typing')
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

describe('history index', () => {
  it('matches git.log semantics across create, edit, and delete', async () => {
    await mkdir(join(dir, 'chapters'), { recursive: true })
    await mkdir(join(dir, 'metadata/characters'), { recursive: true })
    await writeFile(join(dir, 'chapters/001-one.md'), 'one v1')
    await writeFile(join(dir, 'novel.yaml'), 'title: t\n')
    await commitAll(dir, 'root')
    await writeFile(join(dir, 'chapters/002-two.md'), 'two v1')
    await commitAll(dir, 'create two', ['chapters/002-two.md'])
    await writeFile(join(dir, 'metadata/characters/mira.md'), 'mira')
    await commitAll(dir, 'codex', ['metadata/characters/mira.md'])
    await writeFile(join(dir, 'chapters/001-one.md'), 'one v2')
    await commitAll(dir, 'edit one', ['chapters/001-one.md'])
    await rm(join(dir, 'chapters/002-two.md'))
    await commitAll(dir, 'delete two')

    expect((await history(dir, 'chapters/001-one.md')).map((c) => c.message)).toEqual([
      'edit one',
      'root'
    ])
    // The creating AND the deleting commit are both listed, like `git log -- file`.
    expect((await history(dir, 'chapters/002-two.md')).map((c) => c.message)).toEqual([
      'delete two',
      'create two'
    ])
    expect((await history(dir, 'metadata/characters/mira.md')).map((c) => c.message)).toEqual([
      'codex'
    ])
    expect(await history(dir)).toHaveLength(5)
  })

  it('catches up after a commit made outside commitAll', async () => {
    const { default: git } = await import('isomorphic-git')
    const fs = await import('node:fs')
    await writeFile(join(dir, 'a.md'), 'v1')
    await commitAll(dir, 'v1', ['a.md'])
    // Prime the index, then commit behind its back.
    await history(dir, 'a.md')
    await writeFile(join(dir, 'a.md'), 'v2')
    await git.add({ fs: fs.default, dir, filepath: 'a.md' })
    await git.commit({
      fs: fs.default,
      dir,
      message: 'out of band',
      author: { name: 'x', email: 'x@localhost' }
    })
    expect((await history(dir, 'a.md')).map((c) => c.message)).toEqual(['out of band', 'v1'])
  })

  it('rebuilds from a corrupt index file in a fresh process', async () => {
    await writeFile(join(dir, 'a.md'), 'v1')
    await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'v2')
    await commitAll(dir, 'v2', ['a.md'])
    await writeFile(join(dir, '.git/pandora/history-index.json'), 'not json{{{')
    // A fresh module instance has no in-memory copy — it must survive the
    // corrupt file and rebuild by walking the graph.
    vi.resetModules()
    const fresh = await import('./service')
    expect((await fresh.history(dir, 'a.md')).map((c) => c.message)).toEqual(['v2', 'v1'])
  })

  it('keeps the persisted index at HEAD after each commit', async () => {
    await writeFile(join(dir, 'a.md'), 'v1')
    await commitAll(dir, 'v1', ['a.md'])
    await writeFile(join(dir, 'a.md'), 'v2')
    await commitAll(dir, 'v2', ['a.md'])
    const { default: git } = await import('isomorphic-git')
    const fs = await import('node:fs')
    const head = await git.resolveRef({ fs: fs.default, dir, ref: 'HEAD' })
    const raw = JSON.parse(await readFile(join(dir, '.git/pandora/history-index.json'), 'utf8'))
    expect(raw.head).toBe(head)
    expect(raw.commits).toHaveLength(2)
    expect(raw.commits[0].files).toContain('a.md')
  })

  it('returns an empty history for a repo with no commits', async () => {
    await ensureRepo(dir)
    expect(await history(dir)).toEqual([])
    expect(await history(dir, 'a.md')).toEqual([])
  })
})
