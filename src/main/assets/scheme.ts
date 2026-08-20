import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { resolveInside } from '../paths'

/**
 * pandora-asset:// — the only way file bytes reach the renderer. The window
 * runs sandboxed with webSecurity on, so it cannot read the filesystem; this
 * scheme serves images from exactly two roots and nothing else:
 *
 *   pandora-asset://themes/<id>/<file>  → the userData themes folder
 *   pandora-asset://novel/<rel>         → the currently open novel folder
 *
 * Everything about a request is untrusted (image srcs come from chapter
 * markdown, which models and foreign novel folders write), so each path goes
 * through resolveInside — including its symlink check, because a link inside
 * the novel pointing at ~/.ssh must 403 rather than serve.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])

export const ASSET_SCHEME = 'pandora-asset'

/**
 * The open novel's directory, registered by the project:openNovel/createNovel
 * handlers. Main is otherwise stateless about which novel is open — this is
 * the one place that needs the fact outside an IPC call. The app is
 * single-window, so one slot suffices; it intentionally survives close-novel
 * (it still names the user's own folder).
 */
let novelRoot: string | null = null

export function setNovelAssetRoot(dir: string): void {
  novelRoot = dir
}

/** Pure resolution: URL → contained absolute path, or null for anything off. */
export function resolveAssetUrl(
  url: string,
  roots: { themes: string; novel: string | null }
): string | null {
  let parsed: URL
  let rel: string
  try {
    parsed = new URL(url)
    // Standard-scheme URLs percent-encode; decode can throw on bad escapes.
    rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || rel === '') return null
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) return null
  try {
    if (parsed.hostname === 'themes') return resolveInside(roots.themes, rel)
    if (parsed.hostname === 'novel' && roots.novel) return resolveInside(roots.novel, rel)
  } catch {
    return null
  }
  return null
}

/** Must run at module scope, before app.whenReady() fires. */
export function registerAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      // No bypassCSP: the renderer's CSP names pandora-asset: explicitly,
      // keeping the allowlist auditable in one place (index.html).
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Runs inside whenReady, before the window is created. */
export function registerAssetProtocol(themesRoot: string): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const path = resolveAssetUrl(request.url, { themes: themesRoot, novel: novelRoot })
    if (!path) return new Response('', { status: 403 })
    try {
      return await net.fetch(pathToFileURL(path).href)
    } catch {
      return new Response('', { status: 404 })
    }
  })
}
