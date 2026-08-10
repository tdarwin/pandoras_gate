import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/**
 * API keys encrypted at rest with the OS keystore (Keychain on macOS, DPAPI
 * on Windows). Keys never cross to the renderer — it only learns whether a
 * key is configured.
 */

type SecretName = 'openrouter-api-key'

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

async function readAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(secretsPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is unavailable; cannot store the API key securely')
  }
  const all = await readAll()
  all[name] = safeStorage.encryptString(value).toString('base64')
  await mkdir(dirname(secretsPath()), { recursive: true })
  await writeFile(secretsPath(), JSON.stringify(all), 'utf8')
}

export async function getSecret(name: SecretName): Promise<string | null> {
  const all = await readAll()
  const encrypted = all[name]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

export async function hasSecret(name: SecretName): Promise<boolean> {
  return (await getSecret(name)) !== null
}

export async function deleteSecret(name: SecretName): Promise<void> {
  const all = await readAll()
  delete all[name]
  await writeFile(secretsPath(), JSON.stringify(all), 'utf8')
}
