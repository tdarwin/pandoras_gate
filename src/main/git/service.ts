import fs from 'node:fs'
import git from 'isomorphic-git'
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
  return git.commit({ fs, dir, message, author: AUTHOR })
}

/** Commit history, optionally narrowed to one file. Newest first. */
export async function history(dir: string, filepath?: string, depth = 100): Promise<CommitInfo[]> {
  await ensureRepo(dir)
  try {
    const commits = await git.log({
      fs,
      dir,
      depth,
      ...(filepath ? { filepath, force: true, follow: false } : {})
    })
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message.trim(),
      timestamp: c.commit.committer.timestamp * 1000
    }))
  } catch {
    // Repo with no commits yet.
    return []
  }
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
  await fs.promises.writeFile(`${dir}/${filepath}`, content, 'utf8')
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
