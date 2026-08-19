import type { Llama, LlamaModel } from 'node-llama-cpp'
import type { WorkerRequest, WorkerResponse } from '../shared/llm/workerProtocol'
import { SerialQueue } from './queue'

/**
 * LLM inference worker — runs as an Electron utilityProcess so model loading
 * and prompt evaluation can never stall the main process, and a crash (bad
 * GGUF, OOM) takes down only this process.
 */

const port = process.parentPort
if (!port) {
  throw new Error('llm-worker must run as an Electron utilityProcess')
}

function send(msg: WorkerResponse): void {
  port.postMessage(msg)
}

let llamaPromise: Promise<Llama> | null = null
let model: LlamaModel | null = null
let loadedPath: string | null = null
/**
 * Context size resolved for the currently loaded model. Keyed by path *and*
 * ceiling: the same model asked for a different ceiling is a different answer,
 * and caching on path alone made the window depend on whether a warm load or a
 * chat happened to run first. Cleared in `ensureModel` with the model itself.
 */
let resolvedContext: {
  modelPath: string
  ceiling: number
  contextSize: number
  resolved: boolean
} | null = null
const activeChats = new Map<string, AbortController>()
let nextCallId = 1
const pendingToolResults = new Map<string, (result: string) => void>()
/** callIds in flight per chat request, so cancel can unwind tool waits. */
const pendingByRequest = new Map<string, Set<string>>()

/** Runaway-agent guard: max tool calls per single chat reply. */
const TOOL_CALL_BUDGET = 10

// Cache the PROMISE, not the instance — concurrent first calls must not
// create two Llama instances (grammars from one are invalid for models
// loaded with the other).
function getLlamaInstance(): Promise<Llama> {
  if (!llamaPromise) {
    llamaPromise = import('node-llama-cpp').then((m) => m.getLlama())
  }
  return llamaPromise
}

async function ensureModel(modelPath: string): Promise<LlamaModel> {
  if (model && loadedPath === modelPath) return model
  // One resident model at a time. Disposal is safe here: chat and load both
  // run through `generationQueue`, so when this executes no other generation
  // can hold the old model.
  if (model) {
    try {
      await model.dispose()
    } catch {
      // Already disposed or mid-teardown — proceed to load fresh.
    }
    model = null
    loadedPath = null
    resolvedContext = null
  }
  const inst = await getLlamaInstance()
  model = await inst.loadModel({ modelPath })
  loadedPath = modelPath
  return model
}

/**
 * Works out the context window this machine can actually give the loaded model.
 *
 * node-llama-cpp resolves this against live VRAM/RAM state without allocating
 * anything, which is the only honest answer — the app used to assume a flat 16k
 * for every model on every machine, which under-served small models badly and
 * over-promised on large ones. `ceiling` is the app's policy cap; the resolver
 * may return less if the memory isn't there.
 */
async function resolveContextSize(
  m: LlamaModel,
  ceiling?: number
): Promise<{ contextSize: number; resolved: boolean }> {
  const max = Math.min(m.trainContextSize, ceiling ?? m.trainContextSize)
  if (resolvedContext?.modelPath === loadedPath && resolvedContext.ceiling === max) {
    return { contextSize: resolvedContext.contextSize, resolved: resolvedContext.resolved }
  }

  let contextSize = max
  let resolved = true
  try {
    contextSize = await m.fileInsights.configurationResolver.resolveContextContextSize(
      { max },
      { modelGpuLayers: m.gpuLayers, modelTrainContextSize: m.trainContextSize }
    )
  } catch {
    // InsufficientMemoryError, or an estimator that can't judge this build.
    // Fall back to the requested ceiling and let createContext's own memory
    // checks be the backstop — but say the number is a guess, so main doesn't
    // record it as the model's real window.
    resolved = false
  }

  resolvedContext = { modelPath: loadedPath ?? '', ceiling: max, contextSize, resolved }
  // Announced rather than returned, so a window resolved on the chat path is
  // recorded too — not just one a warm load asked for.
  if (resolved) {
    send({ type: 'contextResolved', modelPath: loadedPath ?? '', contextLength: contextSize })
  }
  return { contextSize, resolved }
}

async function handleLoad(modelPath: string, contextSize?: number): Promise<void> {
  try {
    const m = await ensureModel(modelPath)
    const { contextSize: contextLength, resolved } = await resolveContextSize(m, contextSize)
    send({ type: 'loaded', modelPath, contextLength, resolved })
  } catch (err) {
    send({
      type: 'loadError',
      modelPath,
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

async function handleChat(
  req: Extract<WorkerRequest, { type: 'chat' }>,
  controller: AbortController
): Promise<void> {
  try {
    const m = await ensureModel(req.modelPath)
    const inst = await getLlamaInstance()
    const { LlamaChatSession } = await import('node-llama-cpp')

    // Resolved per model, not read from a global the chat path may never have
    // set — a chat that arrives without a warm load used to allocate whatever
    // llama.cpp felt like, which the context assembler then budgeted against
    // wrongly in both directions.
    const { contextSize } = await resolveContextSize(m, req.contextSize)
    const context = await m.createContext({ contextSize: { max: contextSize } })
    try {
      const sequence = context.getSequence()

      const systemMessages = req.messages.filter((msg) => msg.role === 'system')
      const turns = req.messages.filter((msg) => msg.role !== 'system')

      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: systemMessages.map((msg) => msg.content).join('\n\n') || undefined
      })

      // Replay prior turns into the session history; the final user message
      // is the actual prompt.
      const last = turns.at(-1)
      if (!last || last.role !== 'user') {
        send({
          type: 'event',
          requestId: req.requestId,
          event: { type: 'error', message: 'Chat must end with a user message' }
        })
        return
      }
      const prior = turns.slice(0, -1)
      if (prior.length > 0) {
        const history: import('node-llama-cpp').ChatHistoryItem[] = []
        if (systemMessages.length > 0) {
          history.push({ type: 'system', text: systemMessages.map((msg) => msg.content).join('\n\n') })
        }
        for (const t of prior) {
          if (t.role === 'user') history.push({ type: 'user', text: t.content })
          else history.push({ type: 'model', response: [t.content] })
        }
        session.setChatHistory(history)
      }

      const grammar = req.responseFormat
        ? await inst.createGrammarForJsonSchema(req.responseFormat.schema as never)
        : undefined

      // Tool support: node-llama-cpp drives the call/respond loop internally;
      // each handler round-trips to the main process for execution. A budget
      // and duplicate-call detection stop runaway agent loops — small local
      // models will otherwise chain tool calls forever.
      let functions: Record<string, unknown> | undefined
      if (req.tools?.length && !grammar) {
        const { defineChatSessionFunction } = await import('node-llama-cpp')
        let callCount = 0
        const seenCalls = new Set<string>()
        functions = {}
        for (const tool of req.tools) {
          const props = (tool.parameters as { properties?: Record<string, unknown> }).properties
          const hasParams = props && Object.keys(props).length > 0
          functions[tool.name] = defineChatSessionFunction({
            description: tool.description,
            ...(hasParams ? { params: tool.parameters as never } : {}),
            handler: (params: unknown) => {
              const paramsJson = JSON.stringify(params ?? {})
              callCount += 1
              if (callCount > TOOL_CALL_BUDGET) {
                return Promise.resolve(
                  'TOOL BUDGET EXHAUSTED for this reply. Do not call any more tools. Summarize what you have done so far and answer the author now.'
                )
              }
              const key = `${tool.name}:${paramsJson}`
              if (seenCalls.has(key)) {
                return Promise.resolve(
                  'You already called this tool with identical arguments in this reply and have its result. Do not repeat tool calls — answer the author now.'
                )
              }
              seenCalls.add(key)
              return new Promise<string>((resolve) => {
                const callId = `${req.requestId}:${nextCallId++}`
                pendingToolResults.set(callId, resolve)
                let pending = pendingByRequest.get(req.requestId)
                if (!pending) {
                  pending = new Set()
                  pendingByRequest.set(req.requestId, pending)
                }
                pending.add(callId)
                send({
                  type: 'toolCall',
                  requestId: req.requestId,
                  callId,
                  name: tool.name,
                  paramsJson
                })
              })
            }
          })
        }
      }

      const result = await session.prompt(last.content, {
        signal: controller.signal,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        grammar: grammar as never,
        functions: functions as never,
        onTextChunk: (text) => {
          send({ type: 'event', requestId: req.requestId, event: { type: 'delta', text } })
        }
      })

      send({
        type: 'event',
        requestId: req.requestId,
        event: {
          type: 'usage',
          promptTokens: sequence.tokenMeter.usedInputTokens,
          completionTokens: m.tokenize(result).length
        }
      })
      send({
        type: 'event',
        requestId: req.requestId,
        event: { type: 'done', finishReason: 'stop' }
      })
    } finally {
      await context.dispose()
    }
  } catch (err) {
    if (controller.signal.aborted) {
      send({
        type: 'event',
        requestId: req.requestId,
        event: { type: 'done', finishReason: 'cancelled' }
      })
    } else {
      const raw = err instanceof Error ? err.message : String(err)
      // Translate llama.cpp internals into something actionable.
      const message = raw.includes('disposed')
        ? 'The model was unloaded mid-generation (usually a model switch during a running task). Try again.'
        : raw
      send({
        type: 'event',
        requestId: req.requestId,
        event: { type: 'error', message }
      })
    }
  } finally {
    activeChats.delete(req.requestId)
    pendingByRequest.delete(req.requestId)
  }
}

async function handleGgufInfo(id: number, modelPath: string): Promise<void> {
  try {
    const { readGgufFileInfo } = await import('node-llama-cpp')
    const { stat } = await import('node:fs/promises')
    const info = await readGgufFileInfo(modelPath)
    const meta = info.metadata as { general?: { name?: string } }
    const arch = info.architectureMetadata as { context_length?: number } | undefined
    const fileStat = await stat(modelPath)
    send({
      type: 'ggufInfoResult',
      id,
      info: {
        name: meta.general?.name ?? modelPath.split('/').at(-1) ?? modelPath,
        trainContextLength: arch?.context_length ?? 4096,
        sizeBytes: fileStat.size
      }
    })
  } catch (err) {
    send({
      type: 'ggufInfoResult',
      id,
      info: null,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// Generations and model loads run strictly one at a time — see queue.ts.
const generationQueue = new SerialQueue()

port.on('message', (e: { data: WorkerRequest }) => {
  const msg = e.data
  switch (msg.type) {
    case 'load':
      generationQueue.push(() => handleLoad(msg.modelPath, msg.contextSize))
      break
    case 'unload':
      generationQueue.push(async () => {
        if (model) {
          await model.dispose().catch(() => undefined)
          model = null
          loadedPath = null
          resolvedContext = null
        }
      })
      break
    case 'chat': {
      // Registered before the job starts so cancel works while queued.
      const controller = new AbortController()
      activeChats.set(msg.requestId, controller)
      if (generationQueue.busy) {
        send({
          type: 'event',
          requestId: msg.requestId,
          event: { type: 'status', text: 'Waiting for the current generation to finish…' }
        })
      }
      generationQueue.push(
        () => handleChat(msg, controller),
        () => {
          if (!controller.signal.aborted) return false
          send({
            type: 'event',
            requestId: msg.requestId,
            event: { type: 'done', finishReason: 'cancelled' }
          })
          activeChats.delete(msg.requestId)
          return true
        }
      )
      break
    }
    case 'cancel': {
      activeChats.get(msg.requestId)?.abort()
      // Unwind any tool handler awaiting main — otherwise the prompt cannot
      // observe the abort and generation never actually stops.
      const pending = pendingByRequest.get(msg.requestId)
      if (pending) {
        for (const callId of pending) {
          pendingToolResults.get(callId)?.('Cancelled by the author. Stop immediately.')
          pendingToolResults.delete(callId)
        }
        pendingByRequest.delete(msg.requestId)
      }
      break
    }
    case 'toolResult': {
      pendingToolResults.get(msg.callId)?.(msg.result)
      pendingToolResults.delete(msg.callId)
      for (const pending of pendingByRequest.values()) pending.delete(msg.callId)
      break
    }
    case 'countTokens': {
      // tokenize can throw mid-dispose during a queued model switch; an
      // estimate beats killing the worker from the message handler.
      let count: number
      try {
        count = model ? model.tokenize(msg.text).length : Math.ceil((msg.text.length / 4) * 1.1)
      } catch {
        count = Math.ceil((msg.text.length / 4) * 1.1)
      }
      send({ type: 'tokenCount', id: msg.id, count })
      break
    }
    case 'ggufInfo':
      void handleGgufInfo(msg.id, msg.modelPath)
      break
  }
})

send({ type: 'ready' })
