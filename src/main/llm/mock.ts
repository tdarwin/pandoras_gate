import type { ChatRequest, LLMProvider, ModelInfo, StreamEvent } from '../../shared/llm/types'

/**
 * Deterministic scripted provider for tests and e2e: yields queued responses
 * as small deltas. Not registered in production builds.
 */
export class MockProvider implements LLMProvider {
  readonly id = 'local' as const

  private responses: string[] = []
  public requests: ChatRequest[] = []

  queue(response: string): void {
    this.responses.push(response)
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'mock-model',
        name: 'Mock Model',
        provider: 'local',
        contextLength: 8192,
        capabilities: { jsonSchema: true }
      }
    ]
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req)
    const response = this.responses.shift()
    if (response === undefined) {
      yield { type: 'error', message: 'MockProvider: no queued response' }
      return
    }
    // Stream in chunks to exercise accumulation paths.
    for (let i = 0; i < response.length; i += 64) {
      if (signal.aborted) {
        yield { type: 'done', finishReason: 'cancelled' }
        return
      }
      yield { type: 'delta', text: response.slice(i, i + 64) }
    }
    yield { type: 'usage', promptTokens: 100, completionTokens: Math.ceil(response.length / 4) }
    yield { type: 'done', finishReason: 'stop' }
  }

  async countTokens(_modelId: string, text: string): Promise<number> {
    return Math.ceil(text.length / 4)
  }
}
