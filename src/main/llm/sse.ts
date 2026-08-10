/**
 * Incremental server-sent-events parser. Feed it raw text chunks; it yields
 * complete `data:` payloads. Pure and stateful-by-instance, so it's easy to
 * unit test against chopped-up streams.
 */
export class SseParser {
  private buffer = ''

  /** Returns the data payloads completed by this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const events: string[] = []
    let sep: number
    // Events are separated by a blank line. Handle \n\n and \r\n\r\n.
    while ((sep = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = this.buffer.slice(0, sep)
      this.buffer = this.buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
      if (dataLines.length > 0) events.push(dataLines.join('\n'))
    }
    return events
  }
}
