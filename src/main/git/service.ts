import fs from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { resolveInside } from '../paths'
import { structuredPatch } from 'diff'

/**
 * Git-under-the-hood: every novel dir is a repo the user never has to know
 * about. Snapshots are commits; restores are new commits (HEAD never moves
 * backward, so any restore can itself be undone).
 */

const AUTHOR = { name: "Pandora's Gate", email: 'pandora@localhost' }

export interface CommitInfo {
  oid: string
  message: string
  /** Unix ms. */
  timestamp: number
}

export interface FileDiff {
  hunks: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }[]
  additions: number
  deletions: number
}

/* ------------------------------------------------------------------ */
/* Per-repo write lock                                                 */
/* ------------------------------------------------------------------ */

// Commits can be triggered concurrently (autocommit timer, proposal accepts,
// snapshot writes, quit flush). isomorphic-git's index writes are not safe to
// interleave, so every mutating operation on a repo runs through one promise
// chain per dir.
const repoLocks = new Map<string, Promise<unknown>>()

async function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(dir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  repoLocks.set(
    dir,
    next.catch(() => undefined)
  )
  return next
}

/** Resolves once every in-flight commit has settled (quit flush). */
export async function awaitIdle(): Promise<void> {
  await Promise.allSettled([...repoLocks.values()])
}

export async function ensureRepo(dir: string): Promise<void> {
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    try {
      await git.init({ fs, dir, defaultBranch: 'main' })
    } catch {
      // init is idempotent; a race with another call is fine.
    }
  }
}

/**
 * Stages every change in the repo and commits. Returns the new commit oid,
 * or null when the tree is clean.
 *
 * `touchedPaths` are files we know were just written: they are staged with an
 * explicit content-hashing `git.add`, sidestepping statusMatrix's stat-based
 * change detection (which misses same-size writes within the same second —
 * exactly what rapid autosaves and AI streaming produce).
 */
export async function commitAll(
  dir: string,
  message: string,
  touchedPaths: string[] = []
): Promise<string | null> {
  return withRepoLock(dir, async () => {
    await ensureRepo(dir)

    for (const filepath of touchedPaths) {
      try {
        await git.add({ fs, dir, filepath })
      } catch {
        // File may have been deleted between save and commit; statusMatrix
        // below picks that up.
      }
    }

    const matrix = await git.statusMatrix({ fs, dir })
    let changed = false
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue
      changed = true
      if (workdir === 0) {
        await git.remove({ fs, dir, filepath })
      } else if (stage === 0 || workdir === 2) {
        await git.add({ fs, dir, filepath })
      }
    }
    if (!changed) return null
    const oid = await git.commit({ fs, dir, message, author: AUTHOR })
    // Keep the history index warm — one commit of catch-up is cheap here,
    // and it keeps History panel opens O(1).
    await syncIndex(dir).catch(() => undefined)
    return oid
  })
}

/* ------------------------------------------------------------------ */
/* Per-file history index                                              */
/* ------------------------------------------------------------------ */

// isomorphic-git's `log({ filepath })` counts *matching* commits against
// `depth`, so any file touched by fewer than `depth` commits triggers a walk
// of the entire commit graph — with a commit read plus tree resolutions per
// visited commit. On a months-old novel that is thousands of loose-object
// reads per History open. Instead we keep a derived index of (commit →
// changed files), appended as we commit and caught up by walking only commits
// we have not seen. It lives inside `.git/` so it is never tracked, travels
// with the repo, and is simply rebuilt if missing or corrupt. It grows without
// bound, but at ~100 bytes per commit that is megabytes after years of use.

interface IndexedCommit extends CommitInfo {
  files: string[]
}

interface HistoryIndex {
  head: string
  commits: IndexedCommit[]
}

const memoryIndex = new Map<string, HistoryIndex>()

function indexPath(dir: string): string {
  return join(dir, '.git', 'pandora', 'history-index.json')
}

async function loadIndex(dir: string): Promise<HistoryIndex | null> {
  const cached = memoryIndex.get(dir)
  if (cached) return cached
  try {
    const raw = await fs.promises.readFile(indexPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as HistoryIndex
    if (typeof parsed.head !== 'string' || !Array.isArray(parsed.commits)) return null
    memoryIndex.set(dir, parsed)
    return parsed
  } catch {
    return null
  }
}

async function saveIndex(dir: string, index: HistoryIndex): Promise<void> {
  memoryIndex.set(dir, index)
  try {
    await fs.promises.mkdir(join(dir, '.git', 'pandora'), { recursive: true })
    await fs.promises.writeFile(indexPath(dir), JSON.stringify(index), 'utf8')
  } catch {
    // A failed write only costs a re-walk next time.
  }
}

/** Every file (recursively) under a tree, prefixed. */
async function listTreeFiles(dir: string, treeOid: string, prefix: string): Promise<string[]> {
  const { tree } = await git.readTree({ fs, dir, oid: treeOid })
  const files: string[] = []
  for (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    if (entry.type === 'tree') {
      files.push(...(await listTreeFiles(dir, entry.oid, path)))
    } else {
      files.push(path)
    }
  }
  return files
}

/**
 * Paths that differ between two trees. Only subtrees whose oids differ are
 * descended into, so an unchanged `chapters/` costs one comparison. Deleted
 * paths are included — `git log -- <file>` lists the deleting commit too.
 */
async function diffTreeFiles(
  dir: string,
  treeOid: string,
  parentTreeOid: string | null,
  prefix = ''
): Promise<string[]> {
  if (parentTreeOid === null) return listTreeFiles(dir, treeOid, prefix)
  if (treeOid === parentTreeOid) return []
  const [{ tree: current }, { tree: parent }] = await Promise.all([
    git.readTree({ fs, dir, oid: treeOid }),
    git.readTree({ fs, dir, oid: parentTreeOid })
  ])
  const parentByPath = new Map(parent.map((e) => [e.path, e]))
  const files: string[] = []
  for (const entry of current) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    const old = parentByPath.get(entry.path)
    parentByPath.delete(entry.path)
    if (!old) {
      if (entry.type === 'tree') files.push(...(await listTreeFiles(dir, entry.oid, path)))
      else files.push(path)
    } else if (old.oid !== entry.oid || old.type !== entry.type) {
      if (entry.type === 'tree' && old.type === 'tree') {
        files.push(...(await diffTreeFiles(dir, entry.oid, old.oid, path)))
      } else if (entry.type === 'tree') {
        files.push(path, ...(await listTreeFiles(dir, entry.oid, path)))
      } else if (old.type === 'tree') {
        files.push(path, ...(await listTreeFiles(dir, old.oid, path)))
      } else {
        files.push(path)
      }
    }
  }
  for (const [path, old] of parentByPath) {
    const full = prefix ? `${prefix}/${path}` : path
    if (old.type === 'tree') files.push(...(await listTreeFiles(dir, old.oid, full)))
    else files.push(full)
  }
  return files
}

/**
 * Brings the index up to HEAD by walking only unseen commits (first parents —
 * the app never creates merges). If the walk reaches the root without meeting
 * a known commit (history rewritten, index stale), the walk itself IS the
 * full history and the old index is discarded.
 */
async function syncIndex(dir: string): Promise<HistoryIndex> {
  let head: string
  try {
    head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    // Unborn branch: no commits yet.
    return { head: '', commits: [] }
  }
  const existing = await loadIndex(dir)
  if (existing?.head === head) return existing
  const known = new Map((existing?.commits ?? []).map((c) => [c.oid, c]))

  const fresh: IndexedCommit[] = []
  let oid: string | null = head
  let anchor: string | null = null
  while (oid) {
    if (known.has(oid)) {
      anchor = oid
      break
    }
    const { commit } = await git.readCommit({ fs, dir, oid })
    const parentOid: string | null = commit.parent[0] ?? null
    const parentTree = parentOid
      ? (await git.readCommit({ fs, dir, oid: parentOid })).commit.tree
      : null
    fresh.push({
      oid,
      message: commit.message.trim(),
      timestamp: commit.committer.timestamp * 1000,
      files: await diffTreeFiles(dir, commit.tree, parentTree)
    })
    oid = parentOid
  }

  let commits = fresh
  if (anchor && existing) {
    const at = existing.commits.findIndex((c) => c.oid === anchor)
    commits = [...fresh, ...existing.commits.slice(at)]
  }
  const index: HistoryIndex = { head, commits }
  await saveIndex(dir, index)
  return index
}

/** Commit history, optionally narrowed to one file. Newest first. */
export async function history(dir: string, filepath?: string, depth = 100): Promise<CommitInfo[]> {
  await ensureRepo(dir)
  const index = await withRepoLock(dir, () => syncIndex(dir))
  const matching = filepath ? index.commits.filter((c) => c.files.includes(filepath)) : index.commits
  return matching.slice(0, depth).map(({ oid, message, timestamp }) => ({ oid, message, timestamp }))
}

/** File content at a commit; null when the file didn't exist there. */
export async function fileAtCommit(
  dir: string,
  oid: string,
  filepath: string
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath })
    return new TextDecoder().decode(blob)
  } catch {
    return null
  }
}

/** Unified diff between a file's content at a commit and its current content. */
export async function diffAgainstWorkdir(
  dir: string,
  oid: string,
  filepath: string
): Promise<FileDiff> {
  const old = (await fileAtCommit(dir, oid, filepath)) ?? ''
  let current = ''
  try {
    current = await fs.promises.readFile(`${dir}/${filepath}`, 'utf8')
  } catch {
    current = ''
  }
  const patch = structuredPatch(filepath, filepath, old, current, '', '')
  let additions = 0
  let deletions = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { hunks: patch.hunks, additions, deletions }
}

/**
 * Restores a file to its content at `oid` — as a NEW commit on top of HEAD.
 */
export async function restoreFile(
  dir: string,
  oid: string,
  filepath: string,
  label: string
): Promise<string | null> {
  const content = await fileAtCommit(dir, oid, filepath)
  if (content === null) throw new Error(`${filepath} does not exist in that snapshot`)
  // The pre-restore state may exist only as a quiet save on disk — commit it
  // before overwriting (no-op when the tree is clean), so nothing a restore
  // replaces is ever unrecoverable.
  await commitAll(dir, `before restore: ${label}`, [filepath])
  await fs.promises.writeFile(resolveInside(dir, filepath), content, 'utf8')
  return commitAll(dir, `restore: ${label} (from ${oid.slice(0, 7)})`, [filepath])
}

/* ------------------------------------------------------------------ */
/* Debounced autocommit                                                */
/* ------------------------------------------------------------------ */

interface PendingCommit {
  timer: NodeJS.Timeout
  messages: Set<string>
  touched: Set<string>
}

const pending = new Map<string, PendingCommit>()
const AUTOCOMMIT_DEBOUNCE_MS = 2000

/**
 * Schedules an autocommit ~2s after the last save. Messages and touched file
 * paths from coalesced saves are merged into one commit.
 */
export function scheduleAutocommit(dir: string, message: string, touchedPaths: string[]): void {
  const entry = pending.get(dir)
  if (entry) {
    clearTimeout(entry.timer)
    entry.messages.add(message)
    for (const p of touchedPaths) entry.touched.add(p)
    entry.timer = setTimeout(() => void flushAutocommit(dir), AUTOCOMMIT_DEBOUNCE_MS)
  } else {
    pending.set(dir, {
      messages: new Set([message]),
      touched: new Set(touchedPaths),
      timer: setTimeout(() => void flushAutocommit(dir), AUTOCOMMIT_DEBOUNCE_MS)
    })
  }
}

export async function flushAutocommit(dir: string): Promise<string | null> {
  const entry = pending.get(dir)
  if (!entry) return null
  clearTimeout(entry.timer)
  pending.delete(dir)
  const message = [...entry.messages].join('; ')
  try {
    return await commitAll(dir, message, [...entry.touched])
  } catch (err) {
    console.error('autocommit failed', dir, err)
    return null
  }
}

/** Flush every pending autocommit (app quit). */
export async function flushAllAutocommits(): Promise<void> {
  await Promise.all([...pending.keys()].map((dir) => flushAutocommit(dir)))
}
