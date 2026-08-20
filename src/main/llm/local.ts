import { app } from 'electron'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { access, rm, rmdir } from 'node:fs/promises'
import type { ChatRequest, LLMProvider, ModelInfo, StreamEvent } from '../../shared/llm/types'
import { DEFAULT_CONTEXT_CEILING } from '../../shared/llm/memory'
import { llmWorkerHost } from './worker-host'
import { readAppState, writeAppState } from '../store'
import { logInfo, logWarn } from '../log'
import { realpathOrSelf } from '../paths'

/**
 * Local models are GGUF files the user imported (or downloaded via the
 * catalog, step 8). The registry lives in app state; model ids are file paths.
 */

export interface LocalModelEntry {
  path: string
  name: string
  /**
   * The window this machine can actually give the model. Written at import
   * time and refreshed whenever the worker resolves the real size at load —
   * it is not a fixed property of the model, since it depends on how much
   * memory is left after the weights.
   */
  contextLength: number
  /** The window the model was trained on; the ceiling on the above. */
  trainContextLength?: number
  sizeBytes: number
}

/** Where the app puts models it downloaded itself, as opposed to imports. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

/**
 * True for files the app downloaded, wherever in the models tree they sit.
 *
 * Compared in both literal and symlink-resolved form: on macOS `/var` is a link
 * to `/private/var`, so a stored path and `modelsDir()` can name the same
 * directory in two different ways. Getting that wrong would silently leave
 * downloads on disk. Resolves the parent rather than the file so a deleted or
 * symlinked model doesn't change the answer.
 */
export function isManagedModelFile(path: string): boolean {
  // Normalized first: an un-resolved `…/models/../elsewhere/x.gguf` would
  // otherwise pass the prefix check, and this decides what gets deleted.
  const target = resolve(path)
  const roots = new Set([modelsDir(), realpathOrSelf(modelsDir())].map((r) => resolve(r)))
  const parent = dirname(target)
  const parents = new Set([parent, realpathOrSelf(parent)])
  for (const p of parents) {
    for (const root of roots) {
      if ((p + sep).startsWith(root + sep)) return true
    }
  }
  return false
}

/**
 * The window to ask the worker for: the model's own limit, capped by app
 * policy. Both the warm-load and chat paths go through this — passing the
 * trained window directly let a large-memory machine resolve a 256k context
 * and a ~17GB KV cache, while the picker had promised 64k.
 */
export function contextCeilingFor(entry: LocalModelEntry): number {
  return Math.min(entry.trainContextLength ?? entry.contextLength, DEFAULT_CONTEXT_CEILING)
}

/** Missing files already warned about, so a stale entry logs once per run. */
const warnedMissing = new Set<string>()

/**
 * Returns registered models whose file actually exists. Missing files (e.g.
 * a deleted model or an unplugged external drive) are hidden rather than
 * removed from the registry, so they come back when the file does — and so
 * callers never hand the worker a path that would ENOENT mid-pipeline.
 */
export async function listLocalModels(): Promise<LocalModelEntry[]> {
  const state = await readAppState()
  const models = state.localModels ?? []
  const present = await Promise.all(
    models.map(async (m) => {
      try {
        await access(m.path)
        return m
      } catch {
        if (!warnedMissing.has(m.path)) {
          warnedMissing.add(m.path)
          logWarn('llm', `local model file missing — hiding from model list: ${m.path}`)
        }
        return null
      }
    })
  )
  return present.filter((m): m is LocalModelEntry => m !== null)
}

export async function importGguf(path: string): Promise<LocalModelEntry> {
  await access(path)
  const info = await llmWorkerHost.ggufInfo(path)
  if (!info) throw new Error('Could not read GGUF metadata — is this a valid model file?')
  // A first estimate; the worker replaces it with the size it actually
  // resolves against live memory the first time the model is loaded.
  const entry: LocalModelEntry = {
    path,
    name: info.name || basename(path, '.gguf'),
    contextLength: Math.min(info.trainContextLength, DEFAULT_CONTEXT_CEILING),
    trainContextLength: info.trainContextLength,
    sizeBytes: info.sizeBytes
  }
  const state = await readAppState()
  const models = (state.localModels ?? []).filter((m) => m.path !== path)
  models.push(entry)
  await writeAppState({ ...state, localModels: models })
  return entry
}

/**
 * Records the window the worker actually resolved for a model, so the context
 * assembler budgets against the real thing rather than an import-time guess.
 * A no-op when the size hasn't changed, to avoid rewriting app state on every
 * model switch.
 */
export async function recordResolvedContext(path: string, contextLength: number): Promise<void> {
  const state = await readAppState()
  const models = state.localModels ?? []
  const entry = models.find((m) => m.path === path)
  if (!entry || entry.contextLength === contextLength) return
  await writeAppState({
    ...state,
    localModels: models.map((m) => (m.path === path ? { ...m, contextLength } : m))
  })
}

/**
 * Deregisters a model, and deletes the file when the app is the one that put it
 * there.
 *
 * Ownership is decided by location, not by whether the live catalog still lists
 * the model. Deciding by catalog membership meant that once a model was rotated
 * out of the catalog — which happens routinely now that it updates without an
 * app release — "Remove" silently left multi-gigabyte files behind. A file the
 * user imported from their own disk is still only deregistered.
 */
export async function removeLocalModel(path: string): Promise<void> {
  const state = await readAppState()
  await writeAppState({
    ...state,
    localModels: (state.localModels ?? []).filter((m) => m.path !== path)
  })
  if (!isManagedModelFile(path)) return

  const target = resolve(path)
  await rm(target, { force: true })

  // The per-repo directory a Hugging Face download creates is shared by every
  // quant pulled from that repo, so it may only go when the last one does.
  // `rmdir` refuses a non-empty directory — which is exactly that test — and,
  // unlike a recursive remove, it cannot take a sibling quant with it.
  const dir = dirname(target)
  if (dir !== resolve(modelsDir())) await rmdir(dir).catch(() => {})
}

/**
 * Fills in metadata for models registered by earlier versions.
 *
 * Before 0.5 the registry stored `contextLength = min(trained, 16384)` and no
 * trained window at all, so those entries would stay pinned at the old flat cap
 * forever: the ceiling derived from them can never exceed 16k, so the resolver
 * has nothing to widen to. Reads the GGUF header once per stale entry and
 * rewrites both fields.
 *
 * Best-effort by design — a model on an unplugged drive is skipped and retried
 * next launch rather than dropped.
 */
export async function backfillModelMetadata(): Promise<{ updated: number }> {
  const state = await readAppState()
  const models = state.localModels ?? []
  const stale = models.filter((m) => m.trainContextLength === undefined)
  if (stale.length === 0) return { updated: 0 }

  const updates = new Map<string, { trainContextLength: number; contextLength: number }>()
  for (const entry of stale) {
    try {
      await access(entry.path)
      const info = await llmWorkerHost.ggufInfo(entry.path)
      if (!info) continue
      updates.set(entry.path, {
        trainContextLength: info.trainContextLength,
        contextLength: Math.min(info.trainContextLength, DEFAULT_CONTEXT_CEILING)
      })
    } catch {
      // Unreadable or missing — leave it stale and try again next launch.
    }
  }
  if (updates.size === 0) return { updated: 0 }

  // Re-read: a download may have registered a model while we were reading headers.
  const latest = await readAppState()
  await writeAppState({
    ...latest,
    localModels: (latest.localModels ?? []).map((m) => {
      const update = updates.get(m.path)
      return update ? { ...m, ...update } : m
    })
  })
  logInfo('llm', `backfilled context metadata for ${updates.size} model(s)`)
  return { updated: updates.size }
}

export class LocalProvider implements LLMProvider {
  readonly id = 'local' as const

  async listModels(): Promise<ModelInfo[]> {
    const models = await listLocalModels()
    return models.map((m) => ({
      id: m.path,
      name: m.name,
      provider: 'local',
      contextLength: m.contextLength,
      capabilities: { jsonSchema: true, toolUse: true }
    }))
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const models = await listLocalModels()
    const entry = models.find((m) => m.path === req.modelId)
    if (!entry) {
      yield { type: 'error', message: `Local model not found: ${req.modelId}` }
      return
    }
    yield* llmWorkerHost.chat(
      {
        requestId: crypto.randomUUID(),
        modelPath: entry.path,
        contextSize: contextCeilingFor(entry),
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
        ...(req.tools?.length ? { tools: req.tools } : {})
      },
      signal,
      req.toolExecutor
    )
  }

  async countTokens(_modelId: string, text: string): Promise<number> {
    return llmWorkerHost.countTokens(text)
  }
}

export const localProvider = new LocalProvider()
