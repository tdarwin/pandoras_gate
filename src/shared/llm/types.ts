export type ProviderId = 'local' | 'openrouter'

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  /** Effective context window in tokens (may be capped below the model's max). */
  contextLength: number
  capabilities: {
    jsonSchema: boolean
    toolUse: boolean
  }
  /** USD per million tokens; remote models only. */
  pricing?: {
    promptPerMTok: number
    completionPerMTok: number
  }
}

export interface ToolCallRef {
  id: string
  name: string
  /** JSON-encoded arguments. */
  arguments: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant messages that requested tool calls (agentic loop, main-only). */
  toolCalls?: ToolCallRef[]
  /** Tool-result messages: which call this answers. */
  toolCallId?: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  modelId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /**
   * Chars of messages[0].content that are byte-stable across turns of the
   * conversation. Providers that support prompt caching put a cache
   * breakpoint at this boundary.
   */
  cachePrefixChars?: number
  /** When set, the provider constrains output to this JSON schema. */
  responseFormat?: { name: string; schema: Record<string, unknown> }
  /** Tools the model may call; providers that can't do tools ignore this. */
  tools?: ToolDefinition[]
  /**
   * Executes a tool call and returns its result. Main-process only — never
   * crosses IPC. Used by providers that run the tool loop internally (local
   * models); the OpenRouter loop lives in the chat orchestrator instead.
   */
  toolExecutor?: (name: string, argsJson: string) => Promise<string>
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'toolCall'; id: string; name: string; arguments: string }
  | { type: 'toolStatus'; text: string }
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
