/**
 * Batches streamed delta text into ~frame-sized IPC events. Local models emit
 * a delta per token; sending each one forces a renderer store update (and a
 * transcript re-render) per token, which stalls the editor during long
 * replies. Order is preserved: flush() runs before any non-delta event so
 * toolStatus/done/error never overtake buffered text.
 */
export class DeltaCoalescer {
  private buffer = ''
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly emit: (text: string) => void,
    private readonly flushMs = 40
  ) {}

  push(text: string): void {
    this.buffer += text
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer) {
      const text = this.buffer
      this.buffer = ''
      this.emit(text)
    }
  }
}
