export type ProviderId = 'local' | 'openrouter'

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  /** Effective context window in tokens (may be capped below the model's max). */
  contextLength: number
  capabilities: {
    jsonSchema: boolean
  }
  /** USD per million tokens; remote models only. */
  pricing?: {
    promptPerMTok: number
    completionPerMTok: number
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  modelId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** When set, the provider constrains output to this JSON schema. */
  responseFormat?: { name: string; schema: Record<string, unknown> }
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string }

/**
 * A chat-capable model provider. Implementations: OpenRouter (remote),
 * node-llama-cpp (local, in the llm-worker utility process).
 */
export interface LLMProvider {
  readonly id: ProviderId
  listModels(): Promise<ModelInfo[]>
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>
  /** Exact for local models; estimate (with margin) for remote. */
  countTokens(modelId: string, text: string): Promise<number>
}
