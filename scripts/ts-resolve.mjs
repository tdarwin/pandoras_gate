import module from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Fail with the actual requirement rather than "registerHooks is not a
// function" or "Unknown file extension .ts" six frames deep.
//
// `process.features.typescript` is the precise test: it is set only once type
// stripping runs unflagged (22.18+/23.6+). Checking registerHooks alone let
// 22.15–22.17 through the guard and straight into the extension error.
if (!process.features.typescript || typeof module.registerHooks !== 'function') {
  console.error(
    `This script needs Node 22.18+ or 23.6+ (running ${process.version}).\n` +
      'Earlier versions lack unflagged TypeScript stripping and/or module.registerHooks.'
  )
  process.exit(1)
}
const { registerHooks } = module

/**
 * Lets plain `node` run scripts that import the app's TypeScript sources.
 *
 * Node strips types natively but still requires explicit file extensions, while
 * the app's own imports are extensionless because electron-vite resolves them.
 * Rather than litter the source with `.ts` suffixes to suit a build script, this
 * hook resolves extensionless relative specifiers to their `.ts` file.
 *
 * Used as `node --import ./scripts/ts-resolve.mjs <script>`.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    if (relative && !/\.[cm]?[jt]sx?$|\.json$/i.test(specifier) && context.parentURL) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const url = new URL(candidate, context.parentURL)
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})
