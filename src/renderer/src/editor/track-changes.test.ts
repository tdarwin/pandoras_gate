// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { Editor, getSchema } from '@tiptap/core'
import { baseExtensions } from './extensions'
import { markdownToDoc, docToMarkdown } from './markdown'
import { TrackChanges, pendingChanges, pendingChangeCount } from './track-changes'
import { polyfillEditorDom } from './test-dom'

beforeAll(polyfillEditorDom)

function makeReviewEditor(original: string, proposal: string): Editor {
  const schema = getSchema(baseExtensions())
  return new Editor({
    element: document.createElement('div'),
    extensions: [...baseExtensions(), TrackChanges.configure({ original })],
    content: markdownToDoc(schema, proposal).toJSON() as object
  })
}

describe('TrackChanges', () => {
  it('diffs the proposal against the original into fine-grained chunks', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    expect(pendingChangeCount(editor.state)).toBe(2)
    // Insertions render highlighted; deletions render as struck-out widgets.
    const dom = editor.view.dom
    const ins = [...dom.querySelectorAll('.tc-ins')].map((n) => n.textContent)
    expect(ins.join(' ')).toContain('green')
    expect(ins.join(' ')).toContain('hawks')
    const dels = [...dom.querySelectorAll('.tc-del')].map((n) => n.textContent)
    expect(dels.join(' ')).toContain('red')
    expect(dels.join(' ')).toContain('birds')
    expect(dom.querySelectorAll('.tc-ctrl').length).toBe(2)
    editor.destroy()
  })

  it('accept-all keeps the proposal; the badges clear', () => {
    const editor = makeReviewEditor('Old line.\n', 'New line entirely.\n')
    editor.commands.acceptAllChanges()
    expect(pendingChangeCount(editor.state)).toBe(0)
    expect(docToMarkdown(editor.state.doc)).toBe('New line entirely.\n')
    editor.destroy()
  })

  it('reject-all restores the original document', () => {
    const original = 'The gate stood closed.\n\nNobody spoke of it.\n'
    const editor = makeReviewEditor(original, 'The gate stood open.\n\nEveryone spoke of it.\n')
    editor.commands.rejectAllChanges()
    expect(docToMarkdown(editor.state.doc)).toBe(original)
    expect(pendingChangeCount(editor.state)).toBe(0)
    editor.destroy()
  })

  it('rejecting a single chunk keeps the rest of the proposal', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    const first = pendingChanges(editor.state)[0]!
    editor.commands.rejectChangeAt(first.fromB)
    const md = docToMarkdown(editor.state.doc)
    expect(md).toContain('red fish')
    expect(md).toContain('hawks')
    expect(pendingChangeCount(editor.state)).toBe(1)
    editor.destroy()
  })

  it('accepting a single chunk clears only that chunk', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    const first = pendingChanges(editor.state)[0]!
    editor.commands.acceptChangeAt(first.fromB)
    expect(pendingChangeCount(editor.state)).toBe(1)
    // Content unchanged — accepting means keeping what's already in the doc.
    expect(docToMarkdown(editor.state.doc)).toBe(
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    editor.destroy()
  })

  it('typing during review becomes a tracked change; undo of a reject restores it', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    expect(pendingChangeCount(editor.state)).toBe(1)

    editor.commands.setTextSelection(editor.state.doc.content.size)
    editor.commands.insertContent(' Rain fell.')
    expect(pendingChangeCount(editor.state)).toBe(2)

    const first = pendingChanges(editor.state)[0]!
    editor.commands.rejectChangeAt(first.fromB)
    expect(docToMarkdown(editor.state.doc)).toContain('quiet')
    editor.commands.undo()
    expect(docToMarkdown(editor.state.doc)).toContain('loud')
    expect(pendingChangeCount(editor.state)).toBe(2)
    editor.destroy()
  })

  it('handles pure insertions and pure deletions across paragraphs', () => {
    const editor = makeReviewEditor(
      'First paragraph.\n\nThird paragraph.\n',
      'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'
    )
    expect(pendingChangeCount(editor.state)).toBeGreaterThanOrEqual(1)
    editor.commands.rejectAllChanges()
    expect(docToMarkdown(editor.state.doc)).toBe('First paragraph.\n\nThird paragraph.\n')
    editor.destroy()
  })
})
