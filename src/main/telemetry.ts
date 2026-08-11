import { trace, context, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { logInfo, logWarn } from './log'

/**
 * OpenTelemetry traces, DEV MODE ONLY, configured entirely through the
 * standard OTEL_* environment variables (e.g. from the project's .envrc via
 * direnv): OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_SERVICE_NAME. Packaged builds never export telemetry, and no
 * credentials are stored in the app. Spans cover every IPC call, LLM
 * generations, the Codex pipeline, and tool calls. File logs (log.ts) stay
 * on regardless for local debugging.
 */

const DEFAULT_SERVICE_NAME = 'pandoras-box'

let provider: NodeTracerProvider | null = null
let activeTracer: Tracer = trace.getTracer('noop')
let enabled = false

export function telemetryEnabled(): boolean {
  return enabled
}

function otlpConfigured(): boolean {
  return Boolean(
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ||
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
  )
}

/** Starts the exporter when running in dev with OTEL_* env vars present. */
export async function initTelemetry(): Promise<void> {
  // Lazy import keeps this module loadable outside Electron (unit tests).
  const { app } = await import('electron')
  if (provider) {
    await provider.shutdown().catch(() => {})
    provider = null
    activeTracer = trace.getTracer('noop')
    enabled = false
  }
  if (app.isPackaged) {
    return
  }
  if (!otlpConfigured()) {
    logInfo('telemetry', 'no OTEL_EXPORTER_OTLP_* env config; telemetry off')
    return
  }
  try {
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? DEFAULT_SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: app.getVersion()
      }),
      spanProcessors: [
        // No url/headers here: the exporter reads the standard
        // OTEL_EXPORTER_OTLP_* environment variables itself.
        new BatchSpanProcessor(new OTLPTraceExporter())
      ]
    })
    // Deliberately NOT registered as the global provider; we hand out our
    // own tracer instead.
    activeTracer = provider.getTracer(DEFAULT_SERVICE_NAME)
    enabled = true
    logInfo(
      'telemetry',
      `dev telemetry enabled → ${process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']}`
    )
  } catch (err) {
    logWarn('telemetry', 'failed to start telemetry', err)
  }
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown().catch(() => {})
}

/** The tracer for manual span management (streaming spans). No-op when off. */
export function getTracer(): Tracer {
  return activeTracer
}

/**
 * Flush pending spans without shutting the pipeline down. GenAI turns are
 * long-lived and the batch processor's delay would lose spans on quit/crash —
 * call after each top-level agent invocation.
 */
export async function flushTelemetry(): Promise<void> {
  await provider?.forceFlush().catch(() => {})
}

type Attrs = Record<string, string | number | boolean | string[]>

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
