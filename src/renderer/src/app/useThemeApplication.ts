import { useEffect, useState } from 'react'
import type { ResolvedTheme } from '@shared/schemas/theme'
import { usePrefsStore } from '../stores/prefs'
import { useProjectStore } from '../stores/project'
import { onIpcEvent } from '../lib/events'

/**
 * Applies the theme preference to the document: `data-theme` selects a
 * built-in palette (custom themes pin their declared base), and a custom
 * theme's resolved tokens — plus the appearance override prefs — land as
 * inline custom properties on <html>, which outrank every stylesheet rule
 * regardless of selector or injection order. Inline application is also
 * naturally idempotent under StrictMode's double-invoked effects.
 */

/** Property names this hook has set, so stale ones are removed on change. */
const applied = new Set<string>()

const VAR_NAME_RE = /^--[a-z][a-z0-9-]*$/
const VAR_VALUE_RE = /^[^;{}]*$/

function applyVars(vars: Record<string, string>): void {
  const style = document.documentElement.style
  for (const name of [...applied]) {
    if (!(name in vars)) {
      style.removeProperty(name)
      applied.delete(name)
    }
  }
  for (const [name, value] of Object.entries(vars)) {
    // The IPC schema already constrains shapes; this is the local backstop.
    if (!VAR_NAME_RE.test(name) || !VAR_VALUE_RE.test(value)) continue
    style.setProperty(name, value)
    applied.add(name)
  }
}

export function useThemeApplication(): void {
  const theme = usePrefsStore((s) => s.theme)
  const editorFontFamily = usePrefsStore((s) => s.editorFontFamily)
  const editorFontSize = usePrefsStore((s) => s.editorFontSize)
  const editorLineHeight = usePrefsStore((s) => s.editorLineHeight)
  const editorMeasure = usePrefsStore((s) => s.editorMeasure)
  const [custom, setCustom] = useState<ResolvedTheme | null>(null)

  // Resolve the custom theme (and re-resolve when its file changes on disk).
  useEffect(() => {
    if (!theme.startsWith('custom:')) {
      setCustom(null)
      return
    }
    const id = theme.slice('custom:'.length)
    let cancelled = false
    const load = async (): Promise<void> => {
      const result = await window.pandora.invoke('themes:resolve', { id })
      if (cancelled) return
      if (result.ok) {
        setCustom(result.data)
      } else {
        // The pref is kept: restoring the theme folder restores the look.
        setCustom(null)
        useProjectStore
          .getState()
          .setError(`Theme "${id}" couldn't load — using the built-in theme. ${result.error.message}`)
      }
    }
    void load()
    const off = onIpcEvent('themes:changed', () => void load())
    return () => {
      cancelled = true
      off()
    }
  }, [theme])

  // data-theme picks the palette; 'system' follows the OS setting.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      document.documentElement.dataset['theme'] = custom
        ? custom.base
        : theme === 'system'
          ? mq.matches
            ? 'light'
            : 'dark'
          : theme.startsWith('custom:')
            ? 'dark' // resolving or broken — a stable fallback, never blank
            : theme
    }
    apply()
    if (!custom && theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    return undefined
  }, [theme, custom])

  // Token values: the custom theme's vars, then the appearance overrides.
  useEffect(() => {
    const vars: Record<string, string> = { ...(custom?.vars ?? {}) }
    if (editorFontFamily !== null) vars['--f-editor'] = editorFontFamily
    if (editorFontSize !== null) vars['--f-editor-size'] = `${editorFontSize}px`
    if (editorLineHeight !== null) vars['--f-editor-lh'] = String(editorLineHeight)
    if (editorMeasure !== null) vars['--ed-measure'] = `${editorMeasure}rem`
    applyVars(vars)
  }, [custom, editorFontFamily, editorFontSize, editorLineHeight, editorMeasure])
}
