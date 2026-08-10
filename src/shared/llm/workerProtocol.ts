import type { ChatMessage, StreamEvent } from './types'

/** Messages main -> llm-worker. */
export type WorkerRequest =
  | { type: 'load'; modelPath: string; contextSize?: number }
  | { type: 'unload' }
  | {
      type: 'chat'
      requestId: string
      modelPath: string
      messages: ChatMessage[]
      temperature?: number
      maxTokens?: number
      responseFormat?: { name: string; schema: Record<string, unknown> }
    }
  | { type: 'cancel'; requestId: string }
  | { type: 'countTokens'; id: number; text: string }
  | { type: 'ggufInfo'; id: number; modelPath: string }

/** Messages llm-worker -> main. */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'loaded'; modelPath: string; contextLength: number }
  | { type: 'loadError'; modelPath: string; message: string }
  | { type: 'event'; requestId: string; event: StreamEvent }
  | { type: 'tokenCount'; id: number; count: number }
  | {
      type: 'ggufInfoResult'
      id: number
      info: { name: string; trainContextLength: number; sizeBytes: number } | null
      error?: string
    }
