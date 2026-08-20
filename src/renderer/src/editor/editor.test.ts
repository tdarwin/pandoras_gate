// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { Editor } from '@tiptap/core'
import { baseExtensions } from './extensions'
import { markdownToDoc, docToMarkdown } from './markdown'

/*
 * These tests instantiate a REAL editor with a live DOM view — the previous
 * editor's crash class (render-time decoration errors) was invisible to
 * state-only tests, so the replacement gets tested at the layer that failed.
 */

beforeAll(() => {
  // jsdom lacks layout; ProseMirror probes these during selection updates.
  const rect = {
    x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
    toJSON: () => ({})
  } as DOMRect
  if (!Range.prototype.getBoundingClientRect || process.env.VITEST) {
    Range.prototype.getBoundingClientRect = () => rect
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  }
})

function makeEditor(md: string, onUpdate?: (markdown: string) => void): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: baseExtensions(),
    ...(onUpdate
      ? {
          onUpdate({ editor }) {
            onUpdate(docToMarkdown(editor.state.doc))
          }
        }
      : {})
  })
  editor.commands.setContent(markdownToDoc(editor.schema, md), { emitUpdate: false })
  return editor
}

describe('TipTap editor instance', () => {
  it('renders markdown as rich content with no visible syntax', () => {
    const editor = makeEditor('# Title\n\nHello **world**, *softly*.\n')
    const dom = editor.view.dom
    expect(dom.querySelector('h1')?.textContent).toBe('Title')
    expect(dom.querySelector('strong')?.textContent).toBe('world')
    expect(dom.querySelector('em')?.textContent).toBe('softly')
    expect(dom.textContent).not.toContain('#')
    expect(dom.textContent).not.toContain('**')
    editor.destroy()
  })

  it('serializes typed edits back to markdown', () => {
    const editor = makeEditor('# Title\n\nHello **world**.\n')
    editor.commands.setTextSelection(editor.state.doc.content.size)
    editor.commands.insertContent(' More prose.')
    expect(docToMarkdown(editor.state.doc)).toBe('# Title\n\nHello **world**. More prose.\n')
    editor.destroy()
  })

  it('style commands produce markdown marks', () => {
    const editor = makeEditor('plain text\n')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.toggleBold()
    expect(docToMarkdown(editor.state.doc)).toBe('**plain** text\n')
    editor.commands.toggleBold()
    editor.chain().selectAll().toggleBlockquote().run()
    expect(docToMarkdown(editor.state.doc)).toBe('> plain text\n')
    editor.destroy()
  })

  it('underline / strike / ordered list commands produce markdown', () => {
    const editor = makeEditor('plain text\n')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.toggleUnderline()
    expect(docToMarkdown(editor.state.doc)).toBe('<u>plain</u> text\n')
    editor.commands.toggleUnderline()
    editor.commands.toggleStrike()
    expect(docToMarkdown(editor.state.doc)).toBe('~~plain~~ text\n')
    editor.commands.toggleStrike()
    editor.chain().selectAll().toggleOrderedList().run()
    expect(docToMarkdown(editor.state.doc)).toBe('1. plain text\n')
    editor.destroy()
  })

  it('inserts tables that serialize as GFM and parse back', () => {
    const editor = makeEditor('before\n')
    editor.commands.setTextSelection(editor.state.doc.content.size)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    editor.commands.insertContent('Head')
    const md = docToMarkdown(editor.state.doc)
    expect(md).toContain('| Head |')
    expect(md).toContain('| --- | --- |')
    // The serialized form parses back into an identical document shape.
    const reparsed = docToMarkdown(markdownToDoc(editor.schema, md))
    expect(reparsed).toBe(md)
    editor.destroy()
  })

  it('emits update events with serialized markdown', () => {
    let emitted = ''
    const editor = makeEditor('', (md) => {
      emitted = md
    })
    editor.commands.insertContent('The gate opened.')
    expect(emitted).toBe('The gate opened.\n')
    editor.destroy()
  })

  it('replaces content wholesale without emitting updates (streamed drafts)', () => {
    let updates = 0
    const editor = makeEditor('start\n', () => {
      updates += 1
    })
    editor.commands.setContent(markdownToDoc(editor.schema, 'start of a **draft**\n'), {
      emitUpdate: false
    })
    expect(updates).toBe(0)
    expect(docToMarkdown(editor.state.doc)).toBe('start of a **draft**\n')
    editor.destroy()
  })

  it('renders relative image srcs through the asset scheme, keeping markdown relative', () => {
    const editor = makeEditor('![the gate](assets/gate%20art.png)\n')
    const img = editor.view.dom.querySelector('img')!
    // Displayed through the privileged scheme (the sandboxed renderer cannot
    // read novel files), but the document and markdown keep the relative path.
    // Markdown srcs are URLs: `%20` means the file "gate art.png", so the
    // display URL keeps the single encoding — never a double-encoded %2520,
    // which the scheme handler's single decode would miss.
    expect(img.getAttribute('src')).toBe('pandora-asset://novel/assets/gate%20art.png')
    expect(docToMarkdown(editor.state.doc)).toBe('![the gate](assets/gate%20art.png)\n')
    editor.destroy()
  })

  it('a bare % in an image src still resolves to the literal file name', () => {
    const editor = makeEditor('![chart](assets/growth-100%.png)\n')
    const img = editor.view.dom.querySelector('img')!
    // markdown-it normalizes the malformed escape to %25 at parse time, so
    // the node holds the valid spelling; the display URL keeps it single-
    // encoded and the scheme's decode yields the file "growth-100%.png".
    expect(img.getAttribute('src')).toBe('pandora-asset://novel/assets/growth-100%25.png')
    const normalized = '![chart](assets/growth-100%25.png)\n'
    expect(docToMarkdown(editor.state.doc)).toBe(normalized)
    // The normalized form holds on the next pass.
    const editor2 = makeEditor(normalized)
    expect(docToMarkdown(editor2.state.doc)).toBe(normalized)
    editor2.destroy()
    editor.destroy()
  })

  it('renders styled blocks as tinted/aligned containers', () => {
    const editor = makeEditor('::: {align=center bg=note}\nBoxed.\n:::\n')
    const div = editor.view.dom.querySelector('div[data-styled-block]')!
    expect(div.getAttribute('data-bg')).toBe('note')
    expect(div.getAttribute('data-align')).toBe('center')
    expect(div.textContent).toContain('Boxed.')
    editor.destroy()
  })

  it('setBlockAlign wraps, updates, and lifts as attributes clear', () => {
    const editor = makeEditor('Some prose.\n')
    editor.commands.selectAll()
    editor.chain().focus().setBlockAlign('center').run()
    expect(docToMarkdown(editor.state.doc)).toBe('::: {align=center}\nSome prose.\n:::\n')
    editor.chain().focus().setBlockBg('note').run()
    expect(docToMarkdown(editor.state.doc)).toBe('::: {align=center bg=note}\nSome prose.\n:::\n')
    editor.chain().focus().setBlockAlign(null).run()
    editor.chain().focus().setBlockBg(null).run()
    // Last attribute cleared — the wrapper is gone entirely.
    expect(docToMarkdown(editor.state.doc)).toBe('Some prose.\n')
    editor.destroy()
  })

  it('setFontSpan marks the selection and serializes as a bracketed span', () => {
    const editor = makeEditor('Choose a word.\n')
    editor.commands.setTextSelection({ from: 1, to: 7 })
    editor.chain().setFontSpan('Garamond').run()
    expect(docToMarkdown(editor.state.doc)).toBe('[Choose]{font="Garamond"} a word.\n')
    editor.chain().setTextSelection({ from: 1, to: 7 }).unsetFontSpan().run()
    expect(docToMarkdown(editor.state.doc)).toBe('Choose a word.\n')
    editor.destroy()
  })

  it('survives pathological content the old editor crashed on', () => {
    // Frontmatter-looking text, hr at doc start, marks spanning wraps — all
    // as plain body content. Nothing here should throw at render time.
    const nasty = [
      '---',
      '',
      'a paragraph with **bold spanning multiple words across a long wrapped line** end',
      '',
      '- list',
      '- items',
      '',
      '> quote'
    ].join('\n')
    const editor = makeEditor(nasty)
    expect(editor.view.dom.querySelector('hr')).toBeTruthy()
    expect(docToMarkdown(editor.state.doc)).toContain('**bold spanning')
    editor.destroy()
  })
})
