/**
 * Serialization for read-modify-write cycles on files the app owns.
 *
 * Nothing in Electron's main process serializes IPC handlers: `ipcMain.handle`
 * runs them as they arrive. So a novel's `.pandora/state.json`, its proposal
 * JSON, and its git index all have concurrent writers — an autocommit timer, a
 * pipeline run holding state across a minutes-long model call, a burst of
 * accept/reject clicks, the quit flush. Each of those is read → modify → write,
 * and interleaving them loses the earlier write silently.
 *
 * One promise chain per key. Keys are namespaced by concern and novel dir
 * (`state:<dir>`, `proposals:<dir>`, `repo:<dir>`) so unrelated work does not
 * queue behind unrelated work.
 */

const locks = new Map<string, Promise<unknown>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  // `.then(fn, fn)` so a rejected predecessor does not strand the queue.
  const next = prev.then(fn, fn)
  locks.set(
    key,
    next.catch(() => undefined)
  )
  return next
}

/**
 * Resolves once every in-flight holder has settled — all of them, or only
 * those whose key starts with `prefix`. Used by the quit flush.
 */
export async function awaitIdle(prefix?: string): Promise<void> {
  const pending =
    prefix === undefined
      ? [...locks.values()]
      : [...locks.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
  await Promise.allSettled(pending)
}
