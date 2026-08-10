import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Dead-simple durable logging: one file per day under userData/logs, plain
 * lines, kept for the last 7 days. Synchronous appends so nothing is lost on
 * crash — volumes here are tiny. Electron is resolved lazily so this module
 * also loads under plain node (unit tests), falling back to the OS tmpdir.
 */

let logsPath: string | null = null

function resolveBaseDir(): string {
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return join(app.getPath('userData'), 'logs')
  }
  return join(tmpdir(), 'pandora-logs')
}

export function logsDir(): string {
  if (!logsPath) {
    logsPath = resolveBaseDir()
    mkdirSync(logsPath, { recursive: true })
    prune()
  }
  return logsPath
}

function prune(): void {
  try {
    const files = readdirSync(logsPath!)
      .filter((f) => f.startsWith('pandora-') && f.endsWith('.log'))
      .sort()
    for (const f of files.slice(0, -7)) {
      rmSync(join(logsPath!, f), { force: true })
    }
  } catch {
    // Pruning is best-effort.
  }
}

function currentFile(): string {
  const day = new Date().toISOString().slice(0, 10)
  return join(logsDir(), `pandora-${day}.log`)
}

export type LogLevel = 'info' | 'warn' | 'error'

export function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${
    detail !== undefined ? ` :: ${safeString(detail)}` : ''
  }\n`
  try {
    appendFileSync(currentFile(), line, 'utf8')
  } catch {
    // Never let logging take the app down.
  }
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${scope}] ${message}`, detail ?? '')
}

function safeString(value: unknown): string {
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logInfo = (scope: string, message: string, detail?: unknown): void =>
  log('info', scope, message, detail)
export const logWarn = (scope: string, message: string, detail?: unknown): void =>
  log('warn', scope, message, detail)
export const logError = (scope: string, message: string, detail?: unknown): void =>
  log('error', scope, message, detail)
