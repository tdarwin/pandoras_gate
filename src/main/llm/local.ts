import { basename } from 'node:path'
import { access } from 'node:fs/promises'
import type { ChatRequest, LLMProvider, ModelInfo, StreamEvent } from '../../shared/llm/types'
import { llmWorkerHost } from './worker-host'
import { readAppState, writeAppState } from '../store'
import { logWarn } from '../log'

/**
 * Local models are GGUF files the user imported (or downloaded via the
 * catalog, step 8). The registry lives in app state; model ids are file paths.
 */

/** Effective context is capped for sanity; configurable per-model later. */
const DEFAULT_CONTEXT_CAP = 16384

export interface LocalModelEntry {
  path: string
  name: string
  contextLength: number
  sizeBytes: number
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
  const entry: LocalModelEntry = {
    path,
    name: info.name || basename(path, '.gguf'),
    contextLength: Math.min(info.trainContextLength, DEFAULT_CONTEXT_CAP),
    sizeBytes: info.sizeBytes
  }
  const state = await readAppState()
  const models = (state.localModels ?? []).filter((m) => m.path !== path)
  models.push(entry)
  await writeAppState({ ...state, localModels: models })
  return entry
}

export async function removeLocalModel(path: string): Promise<void> {
  const state = await readAppState()
  await writeAppState({
    ...state,
    localModels: (state.localModels ?? []).filter((m) => m.path !== path)
  })
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
