import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listThemes, resolveTheme, themeToVars, importThemeFile, duplicateTheme } from './service'
import { stripJsonc, fromVsCode, fromSublime, fromTmTheme, parsePlist } from './importers'
import { ThemeFileSchema, ResolvedThemeSchema } from '../../shared/schemas/theme'

vi.mock('electron', () => ({
  app: {
    getPath: (): never => {
      throw new Error('tests pass explicit dirs')
    }
  }
}))

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-themes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeTheme(id: string, yaml: string): Promise<void> {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, 'theme.yaml'), yaml, 'utf8')
}

describe('listThemes', () => {
  it('lists valid themes and keeps broken ones visible with a readable problem', async () => {
    await writeTheme('good', 'name: Good Theme\nbase: light\ncolors:\n  surface: "#ffffff"\n')
    await writeTheme('broken', 'name: [unclosed\n')
    await mkdir(join(dir, 'empty-folder'), { recursive: true })
    await writeTheme('bad-color', 'colors:\n  surface: notahex\n')

    const themes = await listThemes(dir)
    expect(themes.map((t) => [t.id, t.valid])).toEqual([
      ['bad-color', false],
      ['broken', false],
      ['empty-folder', false],
      ['good', true]
    ])
    const good = themes.find((t) => t.id === 'good')!
    expect(good.name).toBe('Good Theme')
    expect(good.base).toBe('light')
    expect(themes.find((t) => t.id === 'broken')!.problem).toMatch(/YAML/)
    expect(themes.find((t) => t.id === 'empty-folder')!.problem).toMatch(/missing/)
    expect(themes.find((t) => t.id === 'bad-color')!.problem).toMatch(/surface/)
  })

  it('returns [] for a missing themes dir', async () => {
    expect(await listThemes(join(dir, 'nope'))).toEqual([])
  })
})

describe('themeToVars', () => {
  it('a base-only theme produces no overrides', () => {
    expect(themeToVars('x', ThemeFileSchema.parse({ base: 'dark' }))).toEqual({})
  })

  it('maps tokens 1:1 and derives the families the theme touches', () => {
    const theme = ThemeFileSchema.parse({
      base: 'dark',
      colors: { surface: '#1d2021', ink: '#ebdbb2' },
      editor: { colors: { caret: '#fe8019', link: '#83a598' } }
    })
    const vars = themeToVars('gruvbox', theme)
    expect(vars['--t-surface']).toBe('#1d2021')
    expect(vars['--t-ink']).toBe('#ebdbb2')
    // Derived: panel/lines from surface, ink family from ink, chat link from editor link.
    expect(vars['--t-panel']).toContain('color-mix')
    expect(vars['--t-ink-muted']).toContain('var(--t-ink)')
    expect(vars['--ed-sel']).toContain('var(--ed-caret)')
    expect(vars['--chat-link']).toBe('var(--ed-link)')
    // Explicit values are never overwritten by derivation.
    expect(vars['--ed-caret']).toBe('#fe8019')
  })

  it('does not derive families the theme leaves alone', () => {
    const vars = themeToVars(
      'fonts-only',
      ThemeFileSchema.parse({ base: 'light', editor: { font: { family: 'Iowan Old Style', size: 17 } } })
    )
    expect(vars).toEqual({ '--f-editor': 'Iowan Old Style', '--f-editor-size': '17px' })
  })

  it('background images get an asset URL and a default legibility tint', () => {
    const vars = themeToVars(
      'papery',
      ThemeFileSchema.parse({ base: 'light', editor: { background: { image: 'paper.png', blur: 2 } } })
    )
    expect(vars['--ed-bg-image']).toBe('url("pandora-asset://themes/papery/paper.png")')
    expect(vars['--ed-bg-tint']).toContain('rgba(255')
    expect(vars['--ed-bg-blur']).toBe('2px')
  })

  it('every emitted var satisfies the injection-safety schema', () => {
    const theme = ThemeFileSchema.parse({
      base: 'dark',
      name: 'Full',
      colors: { surface: '#111111', ink: '#eeeeee' },
      editor: {
        colors: { caret: '#ff0000' },
        font: { family: 'ETBembo, Georgia, serif', size: 16, lineHeight: 1.8, measure: 42 },
        background: { image: 'bg.png', opacity: 0.4, blur: 3, tint: '#00000088' }
      },
      ui: { font: { family: 'Avenir Next' } },
      chat: { colors: { link: '#00ff00' }, background: { tint: '#11111188' } }
    })
    const resolved = { id: 'full', name: 'Full', base: 'dark' as const, vars: themeToVars('full', theme) }
    expect(ResolvedThemeSchema.safeParse(resolved).success).toBe(true)
  })
})

describe('resolveTheme', () => {
  it('resolves a minimal hand-written theme', async () => {
    await writeTheme('mini', 'base: light\ncolors:\n  surface: "#fdf6e3"\n')
    const resolved = await resolveTheme('mini', dir)
    expect(resolved.base).toBe('light')
    expect(resolved.vars['--t-surface']).toBe('#fdf6e3')
  })

  it('throws a readable error for a malformed theme', async () => {
    await writeTheme('bad', 'colors:\n  surface: 12\n')
    await expect(resolveTheme('bad', dir)).rejects.toThrow(/surface/)
    await expect(resolveTheme('missing', dir)).rejects.toThrow(/missing/)
  })
})

const VSCODE_FIXTURE = `{
  // A comment — VS Code themes are JSONC.
  "name": "Test Dark",
  "colors": {
    "editor.background": "#1e1e2e",
    "editor.foreground": "#cdd6f4",
    "sideBar.background": "#181825",
    "focusBorder": "#89b4fa",
    "editorCursor.foreground": "#f5e0dc",
    "editor.selectionBackground": "#585b7066",
    "textLink.foreground": "#89b4fa",
  },
  "tokenColors": [
    { "scope": "markup.heading", "settings": { "foreground": "#f9e2af" } },
    { "scope": ["markup.quote"], "settings": { "foreground": "#a6adc8" } }
  ]
}`

const SUBLIME_FIXTURE = `{
  "name": "Test Sublime",
  "globals": {
    "background": "#fdf6e3",
    "foreground": "#657b83",
    "caret": "#586e75",
    "selection": "#eee8d5",
    "line_highlight": "#eee8d5",
    "accent": "#268bd2"
  },
  "rules": []
}`

const TMTHEME_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>name</key>
  <string>Test &amp; tmTheme</string>
  <key>settings</key>
  <array>
    <dict>
      <key>settings</key>
      <dict>
        <key>background</key>
        <string>#002b36</string>
        <key>foreground</key>
        <string>#839496</string>
        <key>caret</key>
        <string>#93a1a1</string>
      </dict>
    </dict>
    <dict>
      <key>scope</key>
      <string>markup.heading</string>
      <key>settings</key>
      <dict>
        <key>foreground</key>
        <string>#cb4b16</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`

describe('importers', () => {
  it('stripJsonc removes comments and trailing commas but not string contents', () => {
    const out = stripJsonc('{ "a": "http://x // not a comment", /* gone */ "b": [1, 2,], }')
    expect(JSON.parse(out)).toEqual({ a: 'http://x // not a comment', b: [1, 2] })
  })

  it('maps a VS Code theme', () => {
    const theme = fromVsCode(VSCODE_FIXTURE)
    expect(theme.name).toBe('Test Dark')
    expect(theme.base).toBe('dark')
    expect(theme.colors?.surface).toBe('#1e1e2e')
    expect(theme.colors?.panel).toBe('#181825')
    expect(theme.editor?.colors?.caret).toBe('#f5e0dc')
    expect(theme.editor?.colors?.heading).toBe('#f9e2af')
    expect(theme.editor?.colors?.quoteText).toBe('#a6adc8')
    expect(theme.chat?.colors?.link).toBe('#89b4fa')
  })

  it('maps a Sublime color scheme, detecting a light base', () => {
    const theme = fromSublime(SUBLIME_FIXTURE)
    expect(theme.base).toBe('light')
    expect(theme.colors?.surface).toBe('#fdf6e3')
    expect(theme.editor?.colors?.link).toBe('#268bd2')
    expect(theme.editor?.colors?.bullet).toBe('#268bd2')
  })

  it('parses plists and maps a .tmTheme', () => {
    expect(parsePlist('<plist><dict><key>k</key><string>v</string></dict></plist>')).toEqual({ k: 'v' })
    const theme = fromTmTheme(TMTHEME_FIXTURE)
    expect(theme.name).toBe('Test & tmTheme')
    expect(theme.base).toBe('dark')
    expect(theme.colors?.surface).toBe('#002b36')
    expect(theme.editor?.colors?.heading).toBe('#cb4b16')
  })

  it('rejects files that are not themes, readably', () => {
    expect(() => fromVsCode('not json at all')).toThrow(/VS Code/)
    expect(() => fromVsCode('{"name": "x"}')).toThrow(/editor colors/)
    expect(() => fromSublime('{"no": "globals"}')).toThrow(/globals/)
    expect(() => fromTmTheme('<html>nope</html>')).toThrow(/tmTheme/)
  })
})

describe('importThemeFile', () => {
  it('imports each format into a new theme folder', async () => {
    // Sources live OUTSIDE the themes dir — anything inside it lists as a theme.
    const src = await mkdtemp(join(tmpdir(), 'pandora-theme-src-'))
    await writeFile(join(src, 'dark.json'), VSCODE_FIXTURE, 'utf8')
    await writeFile(join(src, 'sol.sublime-color-scheme'), SUBLIME_FIXTURE, 'utf8')
    await writeFile(join(src, 'legacy.tmTheme'), TMTHEME_FIXTURE, 'utf8')

    expect((await importThemeFile(join(src, 'dark.json'), dir)).id).toBe('test-dark')
    expect((await importThemeFile(join(src, 'sol.sublime-color-scheme'), dir)).id).toBe('test-sublime')
    expect((await importThemeFile(join(src, 'legacy.tmTheme'), dir)).id).toBe('test-tmtheme')

    const themes = await listThemes(dir)
    expect(themes.every((t) => t.valid)).toBe(true)
    expect(themes).toHaveLength(3)
    await rm(src, { recursive: true, force: true })
  })

  it('de-duplicates ids on repeat imports', async () => {
    const src = await mkdtemp(join(tmpdir(), 'pandora-theme-src-'))
    const file = join(src, 'in.json')
    await writeFile(file, VSCODE_FIXTURE, 'utf8')
    expect((await importThemeFile(file, dir)).id).toBe('test-dark')
    expect((await importThemeFile(file, dir)).id).toBe('test-dark-2')
    expect((await importThemeFile(file, dir)).id).toBe('test-dark-3')
    await rm(src, { recursive: true, force: true })
  })

  it('accepts a Pandora theme.yaml directly and rejects other extensions', async () => {
    const src = await mkdtemp(join(tmpdir(), 'pandora-theme-src-'))
    const yamlSrc = join(src, 'mine.yaml')
    await writeFile(yamlSrc, 'name: Mine\nbase: dark\n', 'utf8')
    expect((await importThemeFile(yamlSrc, dir)).id).toBe('mine')
    const txtSrc = join(src, 'x.txt')
    await writeFile(txtSrc, 'hello', 'utf8')
    await expect(importThemeFile(txtSrc, dir)).rejects.toThrow(/Unsupported/)
    await rm(src, { recursive: true, force: true })
  })
})

describe('duplicateTheme', () => {
  it('a built-in base becomes a minimal editable theme', async () => {
    const { id } = await duplicateTheme('light', dir)
    expect(id).toBe('my-light-theme')
    const written = ThemeFileSchema.parse(parseYaml(await readFile(join(dir, id, 'theme.yaml'), 'utf8')))
    expect(written.base).toBe('light')
    expect((await resolveTheme(id, dir)).vars).toEqual({})
  })

  it('a custom theme is copied with its assets', async () => {
    await writeTheme('orig', 'name: Orig\nbase: dark\neditor:\n  background:\n    image: bg.png\n')
    await writeFile(join(dir, 'orig', 'bg.png'), 'png-bytes', 'utf8')
    const { id } = await duplicateTheme('custom:orig', dir)
    expect(id).toBe('orig-copy')
    expect(await readFile(join(dir, id, 'bg.png'), 'utf8')).toBe('png-bytes')
    const copy = await resolveTheme(id, dir)
    expect(copy.name).toBe('Orig copy')
    expect(copy.vars['--ed-bg-image']).toBe('url("pandora-asset://themes/orig-copy/bg.png")')
  })
})
