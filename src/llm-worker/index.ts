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

let llama: Llama | null = null
let model: LlamaModel | null = null
let loadedPath: string | null = null
let configuredContextSize: number | undefined
const activeChats = new Map<string, AbortController>()

async function getLlamaInstance(): Promise<Llama> {
  if (!llama) {
    const { getLlama } = await import('node-llama-cpp')
    llama = await getLlama()
  }
  return llama
}

async function ensureModel(modelPath: string): Promise<LlamaModel> {
  if (model && loadedPath === modelPath) return model
  // One resident model at a time: unload before switching.
  if (model) {
    await model.dispose()
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

      const result = await session.prompt(last.content, {
        signal: controller.signal,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        grammar: grammar as never,
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
      send({
        type: 'event',
        requestId: req.requestId,
        event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
      })
    }
  } finally {
    activeChats.delete(req.requestId)
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
    case 'cancel':
      activeChats.get(msg.requestId)?.abort()
      break
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
