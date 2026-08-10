import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { WorkerRequest, WorkerResponse } from '../../shared/llm/workerProtocol'
import type { StreamEvent } from '../../shared/llm/types'

/**
 * Supervises the llm-worker utility process: lazy start, crash recovery, and
 * request/response bridging. A worker crash mid-generation surfaces as an
 * error event on the affected requests — never an app crash.
 */

type EventSink = (event: StreamEvent) => void

class LlmWorkerHost {
  private proc: UtilityProcess | null = null
  private readyPromise: Promise<void> | null = null
  private nextId = 1

  private chatSinks = new Map<string, EventSink>()
  private pendingCounts = new Map<number, (count: number) => void>()
  private pendingInfos = new Map<
    number,
    (r: { info: { name: string; trainContextLength: number; sizeBytes: number } | null; error?: string }) => void
  >()
  private pendingLoads = new Map<
    string,
    { resolve: (contextLength: number) => void; reject: (err: Error) => void }
  >()

  private async ensureStarted(): Promise<void> {
    if (this.proc && this.readyPromise) return this.readyPromise
    const workerPath = join(__dirname, 'llmWorker.js')
    const proc = utilityProcess.fork(workerPath, [], {
      serviceName: 'pandora-llm-worker',
      stdio: 'pipe'
    })
    this.proc = proc

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('llm-worker start timeout')), 30_000)
      proc.once('spawn', () => {
        // 'ready' message confirms module load succeeded.
      })
      const onMessage = (msg: WorkerResponse): void => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          resolve()
        }
        this.dispatch(msg)
      }
      proc.on('message', onMessage)
      proc.once('exit', (code) => {
        clearTimeout(timeout)
        this.handleExit(code)
        reject(new Error(`llm-worker exited with code ${code}`))
      })
    })
    proc.stdout?.on('data', (d: Buffer) => console.log('[llm-worker]', d.toString().trimEnd()))
    proc.stderr?.on('data', (d: Buffer) => console.error('[llm-worker]', d.toString().trimEnd()))
    return this.readyPromise
  }

  private dispatch(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'event': {
        this.chatSinks.get(msg.requestId)?.(msg.event)
        if (msg.event.type === 'done' || msg.event.type === 'error') {
          this.chatSinks.delete(msg.requestId)
        }
        break
      }
      case 'tokenCount': {
        this.pendingCounts.get(msg.id)?.(msg.count)
        this.pendingCounts.delete(msg.id)
        break
      }
      case 'ggufInfoResult': {
        this.pendingInfos.get(msg.id)?.(msg)
        this.pendingInfos.delete(msg.id)
        break
      }
      case 'loaded': {
        this.pendingLoads.get(msg.modelPath)?.resolve(msg.contextLength)
        this.pendingLoads.delete(msg.modelPath)
        break
      }
      case 'loadError': {
        this.pendingLoads.get(msg.modelPath)?.reject(new Error(msg.message))
        this.pendingLoads.delete(msg.modelPath)
        break
      }
      case 'ready':
        break
    }
  }

  private handleExit(code: number): void {
    this.proc = null
    this.readyPromise = null
    const message = `Local model process stopped unexpectedly (code ${code}). It may have run out of memory — try a smaller model.`
    for (const sink of this.chatSinks.values()) sink({ type: 'error', message })
    this.chatSinks.clear()
    for (const reject of this.pendingLoads.values()) reject.reject(new Error(message))
    this.pendingLoads.clear()
    for (const resolve of this.pendingCounts.values()) resolve(0)
    this.pendingCounts.clear()
    for (const resolve of this.pendingInfos.values()) resolve({ info: null, error: message })
    this.pendingInfos.clear()
  }

  private send(msg: WorkerRequest): void {
    this.proc?.postMessage(msg)
  }

  async loadModel(modelPath: string, contextSize?: number): Promise<number> {
    await this.ensureStarted()
    return new Promise<number>((resolve, reject) => {
      this.pendingLoads.set(modelPath, { resolve, reject })
      this.send({ type: 'load', modelPath, ...(contextSize ? { contextSize } : {}) })
    })
  }

  async ggufInfo(
    modelPath: string
  ): Promise<{ name: string; trainContextLength: number; sizeBytes: number } | null> {
    await this.ensureStarted()
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pendingInfos.set(id, (r) => resolve(r.info))
      this.send({ type: 'ggufInfo', id, modelPath })
    })
  }

  async countTokens(text: string): Promise<number> {
    await this.ensureStarted()
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pendingCounts.set(id, resolve)
      this.send({ type: 'countTokens', id, text })
    })
  }

  /** Streams a chat generation; cancellation via the AbortSignal. */
  async *chat(
    req: Omit<Extract<WorkerRequest, { type: 'chat' }>, 'type'>,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    try {
      await this.ensureStarted()
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    const queue: StreamEvent[] = []
    let notify: (() => void) | null = null
    let finished = false

    this.chatSinks.set(req.requestId, (event) => {
      queue.push(event)
      if (event.type === 'done' || event.type === 'error') finished = true
      notify?.()
    })

    const onAbort = (): void => {
      this.send({ type: 'cancel', requestId: req.requestId })
      notify?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    this.send({ type: 'chat', ...req })

    try {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        if (finished || signal.aborted) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = null
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.chatSinks.delete(req.requestId)
    }
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.readyPromise = null
  }
}

export const llmWorkerHost = new LlmWorkerHost()
