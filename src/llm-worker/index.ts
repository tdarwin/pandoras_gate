import type { Llama, LlamaModel } from 'node-llama-cpp'
import type { WorkerRequest, WorkerResponse } from '../shared/llm/workerProtocol'

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
let configuredContextSize: number | undefined
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
  // One resident model at a time: unload before switching — but NEVER while a
  // generation still holds the old model ("Object is disposed" crashes).
  if (model) {
    if (activeChats.size > 0) {
      throw new Error(
        'Another generation is still running with the current model. Stop it (or let it finish) before switching models.'
      )
    }
    try {
      await model.dispose()
    } catch {
      // Already disposed or mid-teardown — proceed to load fresh.
    }
    model = null
    loadedPath = null
  }
  const inst = await getLlamaInstance()
  model = await inst.loadModel({ modelPath })
  loadedPath = modelPath
  return model
}

async function handleLoad(modelPath: string, contextSize?: number): Promise<void> {
  try {
    configuredContextSize = contextSize
    const m = await ensureModel(modelPath)
    const contextLength = Math.min(m.trainContextSize, contextSize ?? m.trainContextSize)
    send({ type: 'loaded', modelPath, contextLength })
  } catch (err) {
    send({
      type: 'loadError',
      modelPath,
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

async function handleChat(req: Extract<WorkerRequest, { type: 'chat' }>): Promise<void> {
  const controller = new AbortController()
  activeChats.set(req.requestId, controller)
  try {
    const m = await ensureModel(req.modelPath)
    const inst = await getLlamaInstance()
    const { LlamaChatSession } = await import('node-llama-cpp')

    const context = await m.createContext({
      contextSize: configuredContextSize ? { max: configuredContextSize } : undefined
    })
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

port.on('message', (e: { data: WorkerRequest }) => {
  const msg = e.data
  switch (msg.type) {
    case 'load':
      void handleLoad(msg.modelPath, msg.contextSize)
      break
    case 'unload':
      if (model) {
        void model.dispose()
        model = null
        loadedPath = null
      }
      break
    case 'chat':
      void handleChat(msg)
      break
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
      const count = model
        ? model.tokenize(msg.text).length
        : Math.ceil((msg.text.length / 4) * 1.1)
      send({ type: 'tokenCount', id: msg.id, count })
      break
    }
    case 'ggufInfo':
      void handleGgufInfo(msg.id, msg.modelPath)
      break
  }
})

send({ type: 'ready' })
