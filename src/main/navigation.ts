/**
 * Navigation policy for the single privileged window. The renderer is a
 * single-page app: the only legitimate top-level navigation is back to its
 * own entry document (location.reload() — the crash screen's recovery
 * button). Everything else, file:// URLs especially, must be refused: the
 * preload stays attached across navigations, so a model-authored relative
 * link that resolved to an attacker-chosen local file would hand it
 * window.pandora. (Chat replies render untrusted markdown.)
 */
export function isAllowedNavigation(url: string, entryUrl: string): boolean {
  let target: URL
  let entry: URL
  try {
    target = new URL(url)
    entry = new URL(entryUrl)
  } catch {
    return false
  }
  if (entry.protocol === 'file:') {
    // Packaged: only the entry document itself — never the file:// prefix
    // check this replaces, which admitted every local file.
    return target.protocol === 'file:' && target.pathname === entry.pathname
  }
  // Dev: anything same-origin on the vite server (HMR, reload).
  return target.origin === entry.origin
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** True only for URLs safe to hand to the OS via shell.openExternal. */
export function isOpenableExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
