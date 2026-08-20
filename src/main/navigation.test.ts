import { describe, it, expect } from 'vitest'
import { isAllowedNavigation, isOpenableExternalUrl } from './navigation'

const PROD_ENTRY = 'file:///Applications/App.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV_ENTRY = 'http://localhost:5173'

describe('isAllowedNavigation', () => {
  it('packaged: allows only the entry document itself (reload)', () => {
    expect(isAllowedNavigation(PROD_ENTRY, PROD_ENTRY)).toBe(true)
    expect(isAllowedNavigation(`${PROD_ENTRY}#section`, PROD_ENTRY)).toBe(true)
  })

  it('packaged: refuses every other file:// URL', () => {
    expect(isAllowedNavigation('file:///Users/me/Downloads/notes.html', PROD_ENTRY)).toBe(false)
    expect(isAllowedNavigation('file:///etc/hosts', PROD_ENTRY)).toBe(false)
    // The relative-link case from the report: same dir, different document.
    expect(
      isAllowedNavigation(
        'file:///Applications/App.app/Contents/Resources/app.asar/out/renderer/other.html',
        PROD_ENTRY
      )
    ).toBe(false)
  })

  it('packaged: refuses non-file schemes and garbage', () => {
    expect(isAllowedNavigation('http://localhost:5173/', PROD_ENTRY)).toBe(false)
    expect(isAllowedNavigation('pandora-asset://novel/assets/a.png', PROD_ENTRY)).toBe(false)
    expect(isAllowedNavigation('not a url', PROD_ENTRY)).toBe(false)
  })

  it('dev: allows same-origin only', () => {
    expect(isAllowedNavigation('http://localhost:5173/', DEV_ENTRY)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/index.html', DEV_ENTRY)).toBe(true)
    expect(isAllowedNavigation('http://localhost:4000/', DEV_ENTRY)).toBe(false)
    expect(isAllowedNavigation('file:///etc/hosts', DEV_ENTRY)).toBe(false)
    expect(isAllowedNavigation('https://example.com/', DEV_ENTRY)).toBe(false)
  })
})

describe('isOpenableExternalUrl', () => {
  it('allows http, https, and mailto', () => {
    expect(isOpenableExternalUrl('https://example.com/docs')).toBe(true)
    expect(isOpenableExternalUrl('http://example.com')).toBe(true)
    expect(isOpenableExternalUrl('mailto:someone@example.com')).toBe(true)
  })

  it('refuses everything else', () => {
    for (const bad of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'smb://server/share',
      'pandora-asset://themes/x/y.png',
      'not a url'
    ]) {
      expect(isOpenableExternalUrl(bad)).toBe(false)
    }
  })
})
