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
