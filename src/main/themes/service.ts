import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Custom themes live as folders under userData/themes — one folder per theme,
 * holding theme.yaml plus any image assets, served to the renderer through
 * the pandora-asset:// scheme.
 */

let cachedDir: string | null = null

export function themesDir(): string {
  if (!cachedDir) {
    cachedDir = join(app.getPath('userData'), 'themes')
    mkdirSync(cachedDir, { recursive: true })
  }
  return cachedDir
}
