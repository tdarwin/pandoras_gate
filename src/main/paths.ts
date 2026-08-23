import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

/** Symlink-resolved form when the path exists; the path itself otherwise. */
export function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * Symlink-resolves the deepest existing ancestor and re-attaches the rest,
 * so containment is judged on the true filesystem location even for paths
 * that don't exist yet (a chapter about to be created, a proposal target).
 */
function realpathDeepest(p: string): string {
  let base = p
  const suffix: string[] = []
  while (!existsSync(base)) {
    const parent = dirname(base)
    if (parent === base) break
    suffix.unshift(basename(base))
    base = parent
  }
  const real = realpathOrSelf(base)
  return suffix.length > 0 ? join(real, ...suffix) : real
}

/**
 * Resolves `rel` against `root` and proves the result stays inside it, or
 * throws a readable error. This is the gate every user- or model-authored
 * relative path (manifest chapter files, proposal targets, asset requests)
 * must pass before touching the filesystem.
 *
 * Rejections are deliberate and strict — the app never writes `..`, absolute
 * paths, or backslashes into these fields, so their presence means a
 * hand-edited or foreign file:
 * - absolute paths, `..` segments, backslashes, NUL bytes
 * - anything that resolves outside `root` once symlinks are followed (a
 *   symlink inside the folder pointing at ~/.ssh must fail even though the
 *   literal path looks contained; on macOS /var vs /private/var must not
 *   cause a false rejection)
 * - `root` itself (these paths always name something inside the folder)
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('Path contains a NUL byte')
  if (rel.includes('\\')) {
    throw new Error(`Path "${rel}" contains a backslash — paths use forward slashes`)
  }
  if (isAbsolute(rel)) throw new Error(`Path "${rel}" must be relative, not absolute`)
  if (rel.split('/').includes('..')) {
    throw new Error(`Path "${rel}" may not contain ".." segments`)
  }
  const target = resolve(root, rel)
  const realRoot = realpathOrSelf(resolve(root))
  const realTarget = realpathDeepest(target)
  if (realTarget === realRoot || !(realTarget + sep).startsWith(realRoot + sep)) {
    throw new Error(`Path "${rel}" points outside its allowed folder`)
  }
  return target
}

/**
 * Writes JSON through a temp file and a rename, so a crash or a full disk
 * mid-write leaves the previous version intact rather than a truncated file.
 * The app's own state files (`.pandora/state.json`, proposal JSON) are read
 * back with a parse that silently skips what it cannot read, so a torn write
 * is silent data loss — pending suggestions or a chapter's processed hash
 * simply vanishing.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Same directory: rename is only atomic within a filesystem. The random
  // suffix is not decoration — two writers of one path in the same millisecond
  // would otherwise share a temp file.
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(value, null, 2), 'utf8')
      // Without this the rename can land ahead of the data on a power loss,
      // leaving an empty file — the torn write this is here to prevent.
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
