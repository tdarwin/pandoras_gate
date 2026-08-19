/**
 * One-at-a-time job queue for the LLM worker. A single resident model and a
 * single memory pool mean two generations must never overlap: the second
 * context would be sized against whatever RAM/VRAM the first one left, and a
 * model switch mid-generation would dispose weights under a running prompt.
 * Everything that loads a model or generates goes through here, in order.
 */

interface Job {
  run: () => Promise<void>
  /** True to drop the job instead of running it (e.g. cancelled while queued). */
  skip?: () => boolean
}

export class SerialQueue {
  private jobs: Job[] = []
  private running = false

  /** True while a job is executing (used to announce queue waits). */
  get busy(): boolean {
    return this.running
  }

  push(run: () => Promise<void>, skip?: () => boolean): void {
    this.jobs.push(skip ? { run, skip } : { run })
    if (!this.running) void this.pump()
  }

  private async pump(): Promise<void> {
    this.running = true
    try {
      for (;;) {
        const job = this.jobs.shift()
        if (!job) return
        if (job.skip?.()) continue
        try {
          await job.run()
        } catch {
          // Jobs report their own failures (worker protocol events); a
          // rejection must not stall the queue.
        }
      }
    } finally {
      this.running = false
    }
  }
}
