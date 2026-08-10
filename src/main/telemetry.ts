import { trace, context, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { logInfo, logWarn } from './log'

/**
 * OpenTelemetry traces to Honeycomb (opt-in: configured with an API key in
 * Preferences → Observability). Spans cover every IPC call, LLM generations,
 * the Codex pipeline, tool calls, and model downloads. Without a key this is
 * a no-op. File logs (log.ts) stay on regardless for local debugging.
 */

const SERVICE_NAME = 'pandoras-box'
const HONEYCOMB_TRACES_URL = 'https://api.honeycomb.io/v1/traces'

let provider: NodeTracerProvider | null = null
let activeTracer: Tracer = trace.getTracer('noop')
let enabled = false

export function telemetryEnabled(): boolean {
  return enabled
}

/** (Re)starts the exporter; call at boot and after the key changes. */
export async function initTelemetry(): Promise<void> {
  // Lazy imports keep this module loadable outside Electron (unit tests).
  const { getSecret } = await import('./secrets')
  const { app } = await import('electron')
  const key = await getSecret('honeycomb-api-key')
  if (provider) {
    await provider.shutdown().catch(() => {})
    provider = null
    activeTracer = trace.getTracer('noop')
    enabled = false
  }
  if (!key) {
    logInfo('telemetry', 'no Honeycomb key configured; telemetry off')
    return
  }
  try {
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: app.getVersion()
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: HONEYCOMB_TRACES_URL,
            headers: { 'x-honeycomb-team': key }
          })
        )
      ]
    })
    // Deliberately NOT registered as the global provider (re-registration on
    // key change is messy); we hand out our own tracer instead.
    activeTracer = provider.getTracer(SERVICE_NAME)
    enabled = true
    logInfo('telemetry', 'Honeycomb telemetry enabled')
  } catch (err) {
    logWarn('telemetry', 'failed to start telemetry', err)
  }
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown().catch(() => {})
}

type Attrs = Record<string, string | number | boolean>

/**
 * Runs `fn` inside a span. Nested withSpan calls become child spans via
 * context propagation. No-ops (cheaply) when telemetry is off.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attrs,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return activeTracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err)
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      span.end()
    }
  })
}

/** Fire a zero-duration event span (downloads finishing, worker crashes…). */
export function recordEvent(name: string, attrs: Attrs): void {
  if (!enabled) return
  const span = activeTracer.startSpan(name, { attributes: attrs })
  span.end()
}

/** Current active span, for adding attributes mid-flight. */
export function currentSpan(): Span | undefined {
  return trace.getSpan(context.active())
}
