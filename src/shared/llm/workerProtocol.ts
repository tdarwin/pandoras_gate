import type { ChatMessage, StreamEvent, ToolDefinition } from './types'

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
      tools?: ToolDefinition[]
    }
  | { type: 'cancel'; requestId: string }
  | { type: 'countTokens'; id: number; text: string }
  | { type: 'ggufInfo'; id: number; modelPath: string }
  /** Main's answer to a worker-initiated toolCall. */
  | { type: 'toolResult'; callId: string; result: string }

/** Messages llm-worker -> main. */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'loaded'; modelPath: string; contextLength: number }
  | { type: 'loadError'; modelPath: string; message: string }
  | { type: 'event'; requestId: string; event: StreamEvent }
  | { type: 'tokenCount'; id: number; count: number }
  /** The model called a tool; main must execute it and reply with toolResult. */
  | { type: 'toolCall'; requestId: string; callId: string; name: string; paramsJson: string }
  | {
      type: 'ggufInfoResult'
      id: number
      info: { name: string; trainContextLength: number; sizeBytes: number } | null
      error?: string
    }
