import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
