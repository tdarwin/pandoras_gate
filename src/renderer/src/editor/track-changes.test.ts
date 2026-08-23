// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { Editor, getSchema } from '@tiptap/core'
import { baseExtensions } from './extensions'
import { markdownToDoc, docToMarkdown } from './markdown'
import {
  inlineDocContent,
  suggestionsAttached,
  TrackChanges,
  pendingChanges,
  pendingChangeCount,
  savableDoc,
  proposedDoc,
  changeSource
} from './track-changes'
import { polyfillEditorDom } from './test-dom'

beforeAll(polyfillEditorDom)

function makeReviewEditor(original: string, proposal: string): Editor {
  const schema = getSchema(baseExtensions())
  const suggestion = { original, chain: [{ proposalId: 'p1', content: proposal }] }
  return new Editor({
    element: document.createElement('div'),
    extensions: [...baseExtensions(), TrackChanges.configure({ suggestion })],
    // What the workspace puts in the editor: the last link that can be shown
    // INLINE. A proposal that changes the shape of the document is decided
    // whole and never reaches the overlay, so the editor holds the file.
    content: markdownToDoc(schema, inlineDocContent(schema, suggestion)).toJSON() as object
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

  it('the writer typing is not a suggestion, and a rejected chunk comes back on undo', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    expect(pendingChangeCount(editor.state)).toBe(1)

    editor.commands.setTextSelection(editor.state.doc.content.size)
    editor.commands.insertContent(' Rain fell.')
    // Your own words are yours: no green highlight, no ✓/✕ to click.
    expect(pendingChangeCount(editor.state)).toBe(1)
    // …and a save keeps them, while the undecided suggestion stays off disk.
    expect(docToMarkdown(savableDoc(editor.state))).toBe('A quiet night. Rain fell.\n')

    const first = pendingChanges(editor.state)[0]!
    editor.commands.rejectChangeAt(first.fromB)
    expect(docToMarkdown(editor.state.doc)).toContain('quiet')
    editor.commands.undo()
    expect(docToMarkdown(editor.state.doc)).toContain('loud')
    // Undoing a reject brings the text back as the author's OWN — they asked
    // for it, so it is no longer a decision waiting on them, and a save keeps
    // it rather than quietly reverting to the original.
    expect(pendingChangeCount(editor.state)).toBe(0)
    expect(docToMarkdown(savableDoc(editor.state))).toContain('loud')
    editor.destroy()
  })

  it('typing right after a suggestion does not silently accept it', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    const change = pendingChanges(editor.state)[0]!
    // Continuing the sentence at the edge of a suggested word is the most
    // ordinary way there is to interact with one. Change.merge fuses touching
    // ranges, so this keystroke lands inside the AI's change — it must not
    // take the decision away, nor put unaccepted AI text on disk.
    editor.commands.setTextSelection(change.toB)
    editor.commands.insertContent(' Rain.')
    expect(pendingChangeCount(editor.state)).toBe(1)
    const saved = docToMarkdown(savableDoc(editor.state))
    expect(saved).toContain('quiet')
    expect(saved).not.toContain('loud')
    // …and the author's own words survive it.
    expect(saved).toContain('Rain.')
    editor.destroy()
  })

  it('replacing a suggested word with your own writes only yours', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    const change = pendingChanges(editor.state)[0]!
    // Select the suggestion and type over it. Restoring the proposal's
    // deletion here put the original back ALONGSIDE the author's word.
    editor.commands.insertContentAt({ from: change.fromB, to: change.toB }, 'bright')
    expect(docToMarkdown(savableDoc(editor.state))).toBe('A bright night.\n')
    editor.destroy()
  })

  it('selecting across a suggestion and typing keeps only what was typed', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    const change = pendingChanges(editor.state)[0]!
    // A selection that straddles the suggestion is still a takeover: the
    // original must not come back around the author's replacement.
    editor.commands.insertContentAt({ from: 1, to: change.toB + 3 }, 'X')
    const saved = docToMarkdown(savableDoc(editor.state))
    expect(saved).toBe(docToMarkdown(editor.state.doc))
    expect(saved).not.toContain('quiet')
    expect(saved).toContain('X')
    editor.destroy()
  })

  it('deleting beside a suggestion adopts it, and never resurrects the deletion', () => {
    // A deletion the author makes lands in the same A-range the proposal
    // deleted from, so the two cannot be separated cleanly — narrowing the
    // A-side alone made the revert restore less than it replaced and prose
    // vanished from the saved document. Adopting the chunk is the safe
    // direction: their edit stands, exactly as the editor shows it.
    for (const before of [true, false]) {
      const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
      const change = pendingChanges(editor.state)[0]!
      const at = before ? change.fromB - 1 : change.toB
      editor.commands.deleteRange({ from: at, to: at + 1 })
      const saved = docToMarkdown(savableDoc(editor.state))
      expect(saved).toBe(docToMarkdown(editor.state.doc))
      expect(saved).toBe(before ? 'Aloud night.\n' : 'A loudnight.\n')
      expect(pendingChangeCount(editor.state)).toBe(0)
      editor.destroy()
    }
  })

  it('typing INSIDE a suggestion adopts it rather than reverting the words', () => {
    const editor = makeReviewEditor('A quiet night.\n', 'A loud night.\n')
    const change = pendingChanges(editor.state)[0]!
    // Into the middle of the suggested word: they have made it theirs.
    editor.commands.setTextSelection(change.fromB + 2)
    editor.commands.insertContent('XX')
    expect(pendingChangeCount(editor.state)).toBe(0)
    expect(docToMarkdown(savableDoc(editor.state))).toContain('loXXud')
    editor.destroy()
  })

  it('attaching an empty chain leaves the document alone', () => {
    // Every proposal for the document was set aside as un-combinable. There
    // is nothing to overlay, and replacing the document with "the last link"
    // emptied it — the author watched their prose disappear while the file
    // still had it.
    const editor = makeReviewEditor('Kept.\n', 'Kept edited.\n')
    editor.commands.detachSuggestions()
    const standing = docToMarkdown(editor.state.doc)
    editor.commands.attachSuggestions({ original: standing, chain: [] })
    expect(docToMarkdown(editor.state.doc)).toBe(standing)
    expect(pendingChangeCount(editor.state)).toBe(0)
    editor.destroy()
  })

  it('savableDoc keeps accepted chunks and drops undecided ones', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    const [first] = pendingChanges(editor.state)
    editor.commands.acceptChangeAt(first!.fromB)
    const saved = docToMarkdown(savableDoc(editor.state))
    expect(saved).toContain('green')
    expect(saved).toContain('birds')
    expect(saved).not.toContain('hawks')

    editor.commands.acceptAllChanges()
    expect(docToMarkdown(savableDoc(editor.state))).toContain('hawks')
    editor.destroy()
  })

  it('a heavy copy-edit stays reviewable sentence by sentence', () => {
    // Well past prosemirror-changeset's 5000-character diff budget, which used
    // to collapse the whole document into one all-or-nothing chunk.
    const paras = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}: the gate stood open and the wind came through it coldly.`
    )
    const edited = paras.map((p, i) => p.replace('coldly', `bitterly cold, take ${i}`))
    const original = `${paras.join('\n\n')}\n`
    const proposal = `${edited.join('\n\n')}\n`
    expect(original.length + proposal.length).toBeGreaterThan(5000)

    const editor = makeReviewEditor(original, proposal)
    expect(pendingChangeCount(editor.state)).toBeGreaterThanOrEqual(50)
    // And each one is independently decidable.
    const changes = pendingChanges(editor.state)
    editor.commands.acceptChangeAt(changes[0]!.fromB)
    expect(pendingChangeCount(editor.state)).toBe(changes.length - 1)
    editor.destroy()
  })

  it('attributes each chunk to the proposal that made it', () => {
    const original = 'Alpha.\n\nBeta.\n'
    const first = 'Alpha edited.\n\nBeta.\n'
    const second = 'Alpha edited.\n\nBeta edited.\n'
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        ...baseExtensions(),
        TrackChanges.configure({
          suggestion: {
            original,
            chain: [
              { proposalId: 'p1', content: first },
              { proposalId: 'p2', content: second }
            ]
          }
        })
      ],
      content: markdownToDoc(getSchema(baseExtensions()), second).toJSON() as object
    })
    const changes = pendingChanges(editor.state)
    expect(changes).toHaveLength(2)
    expect(changes.map((c) => changeSource(c))).toEqual(['p1', 'p2'])

    // Each proposal's remaining content carries only its own suggestion.
    expect(docToMarkdown(proposedDoc(editor.state, 'p1'))).toBe(first)
    expect(docToMarkdown(proposedDoc(editor.state, 'p2'))).toBe('Alpha.\n\nBeta edited.\n')

    // Rejecting one leaves the other alone.
    editor.commands.rejectChangeAt(changes[0]!.fromB)
    expect(pendingChangeCount(editor.state)).toBe(1)
    expect(changeSource(pendingChanges(editor.state)[0]!)).toBe('p2')
    editor.destroy()
  })

  it('attaches and detaches without recreating the editor', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...baseExtensions(), TrackChanges.configure({ suggestion: null })],
      content: markdownToDoc(getSchema(baseExtensions()), 'A quiet night.\n').toJSON() as object
    })
    expect(pendingChangeCount(editor.state)).toBe(0)

    editor.commands.attachSuggestions({
      original: 'A quiet night.\n',
      chain: [{ proposalId: 'p1', content: 'A loud night.\n' }]
    })
    expect(pendingChangeCount(editor.state)).toBe(1)
    expect(docToMarkdown(editor.state.doc)).toContain('loud')
    // Suggestions arriving is not an edit the author can undo — undoing it
    // would leave the plugin diffing against a document it no longer holds.
    editor.commands.undo()
    expect(docToMarkdown(editor.state.doc)).toContain('loud')

    editor.commands.detachSuggestions()
    expect(pendingChangeCount(editor.state)).toBe(0)
    expect(docToMarkdown(editor.state.doc)).toBe('A quiet night.\n')
    editor.destroy()
  })

  it('walks suggestions in document order, then hands off', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    const [a, b] = pendingChanges(editor.state)
    editor.commands.setTextSelection(1)
    expect(editor.commands.goToNextSuggestion()).toBe(true)
    expect(editor.state.selection.from).toBe(a!.fromB)
    expect(editor.commands.goToNextSuggestion()).toBe(true)
    expect(editor.state.selection.from).toBe(b!.fromB)
    // Past the last one it reports false rather than cycling — the caller
    // moves on to the next document, which is what "next" has to mean.
    expect(editor.commands.goToNextSuggestion()).toBe(false)
    editor.destroy()
  })

  it('does not rebuild decorations for a plain cursor move', () => {
    const editor = makeReviewEditor(
      'One red fish swam.\n\nTwo blue birds sang.\n',
      'One green fish swam.\n\nTwo blue hawks sang.\n'
    )
    const before = editor.view.props.decorations?.call(editor.view.props, editor.state)
    editor.commands.setTextSelection(3)
    const after = editor.view.props.decorations?.call(editor.view.props, editor.state)
    // Same object, so ProseMirror does no widget DOM work for arrow keys.
    expect(after).toBe(before)
    editor.destroy()
  })

  it('review works on chapters using the dialect, and accepts keep it intact', () => {
    const original = '::: {bg=note}\nSystem: level up.\n:::\n\nProse follows.\n'
    const proposal = '::: {bg=note}\nSystem: level up twice.\n:::\n\nProse follows.\n'
    const editor = makeReviewEditor(original, proposal)
    expect(pendingChangeCount(editor.state)).toBe(1)
    editor.commands.acceptAllChanges()
    expect(docToMarkdown(editor.state.doc)).toBe(proposal)
    editor.destroy()
  })

  it('an image swap highlights the new image and reject restores the old one', () => {
    const original = 'Look:\n\n![map](assets/old-map.png)\n'
    const proposal = 'Look:\n\n![map](assets/new-map.png)\n'
    const editor = makeReviewEditor(original, proposal)
    expect(pendingChangeCount(editor.state)).toBeGreaterThanOrEqual(1)
    editor.commands.rejectAllChanges()
    expect(docToMarkdown(editor.state.doc)).toBe(original)
    editor.destroy()
  })

  it('a proposal that changes the shape of the document never goes inline', () => {
    // The rule this file is built around: per-chunk ✓/✕ is for edits WITHIN a
    // block. Deciding a suggestion means splicing the original back over the
    // proposal's range, so a mis-paired block is not a display glitch, it is
    // prose gone from the saved document — and pairing blocks between two
    // documents holding different numbers of them is ambiguous in ways no
    // amount of care resolves. Five review rounds said so.
    //
    // So the editor holds the author's document, nothing renders, and
    // whatever they type is what gets saved. The proposal is decided whole,
    // against a word diff, elsewhere.
    for (const [original, proposal] of [
      ['Hello there.\n', '> Hello there.\n'],
      ['One.\n\nTwo.\n', '- One.\n- Two.\n'],
      ['> Quoted.\n', 'Quoted.\n'],
      ['> Q.\n\nAfter.\n', 'Q.\n\nAfter.\n'],
      ['A.\n\nB.\n\nAfter.\n', '> A.\n\n> B.\n\nAfter.\n'],
      ['- A\n- B\n\nAfter.\n', 'A\n\nB\n\nAfter.\n'],
      ['First.\n\nThird.\n', 'First.\n\nSecond.\n\nThird.\n'],
      ['First.\n\nSecond.\n\nThird.\n', 'First.\n\nThird.\n'],
      ['An epigraph line.\n', '::: {align=center}\nAn epigraph line.\n:::\n'],
      ['A quiet night.\n\nAfter.\n', '> A loud night.\n\nAfter.\n']
    ] as const) {
      const editor = makeReviewEditor(original, proposal)
      expect(pendingChangeCount(editor.state)).toBe(0)
      expect(docToMarkdown(editor.state.doc)).toBe(original)
      expect(docToMarkdown(savableDoc(editor.state))).toBe(original)
      editor.destroy()
    }
  })

  it('and whatever the author types on top of one is theirs, wherever they type it', () => {
    // The permanent keystroke axis, now asserting something with no moving
    // parts: nothing was ever attached, so nothing can be dropped, and the
    // saved document is exactly what the author is looking at.
    for (const [original, proposal] of [
      ['Para zero.\n\nMiddle one.\n\nPara two.\n', '> Para zero.\n\nMiddle one.\n\nPara two.\n'],
      ['Para zero.\n\nMiddle one.\n\nPara two.\n', 'Para zero.\n\n- Middle one.\n\nPara two.\n'],
      ['Para zero.\n\nMiddle one.\n\nPara two.\n', '> Para zero.\n\n> Middle one.\n\n> Para two.\n'],
      ['- Para zero.\n- Middle one.\n\nPara two.\n', 'Para zero.\n\nMiddle one.\n\nPara two.\n'],
      ['Para zero.\n\nPara two.\n', 'Para zero.\n\nMiddle one.\n\nPara two.\n']
    ] as const) {
      for (const where of ['Para zero.', 'Middle one.', 'Para two.']) {
        const editor = makeReviewEditor(original, proposal)
        let caret = -1
        editor.state.doc.descendants((node, pos) => {
          if (caret < 0 && node.isText && node.text === where) caret = pos
        })
        if (caret < 0) {
          editor.destroy()
          continue
        }
        editor.commands.setTextSelection(caret)
        editor.commands.insertContent('X')
        expect(pendingChangeCount(editor.state)).toBe(0)
        expect(docToMarkdown(savableDoc(editor.state))).toBe(docToMarkdown(editor.state.doc))
        expect(docToMarkdown(savableDoc(editor.state))).toContain(`X${where}`)
        editor.destroy()
      }
    }
  })

  it('a chain stops at its first structural link, and the rest waits', () => {
    // Later links were folded ON TOP of the structural one, so their content
    // assumes it. Once the text-only ones are decided the fold re-anchors and
    // the structural one comes back as the first.
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        ...baseExtensions(),
        TrackChanges.configure({
          suggestion: {
            original: 'Alpha.\n\nBeta.\n',
            chain: [
              { proposalId: 'p1', content: 'Alpha edited.\n\nBeta.\n' },
              { proposalId: 'p2', content: 'Alpha edited.\n\n> Beta.\n' },
              { proposalId: 'p3', content: 'Alpha edited.\n\n> Beta edited.\n' }
            ]
          }
        })
      ],
      content: markdownToDoc(
        getSchema(baseExtensions()),
        'Alpha edited.\n\nBeta.\n'
      ).toJSON() as object
    })
    const chunks = pendingChanges(editor.state)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.sources).toEqual(['p1'])
    expect(docToMarkdown(savableDoc(editor.state))).toBe('Alpha.\n\nBeta.\n')
    editor.destroy()
  })

  it('a detached overlay says so, so a count of zero is never mistaken for a decision', () => {
    const editor = makeReviewEditor('Old line.\n', 'New line.\n')
    expect(suggestionsAttached(editor.state)).toBe(true)
    expect(pendingChangeCount(editor.state)).toBe(1)

    editor.commands.detachSuggestions()
    // Both are zero now. Only one of them means "the author decided".
    expect(pendingChangeCount(editor.state)).toBe(0)
    expect(suggestionsAttached(editor.state)).toBe(false)

    editor.commands.acceptAllChanges()
    expect(suggestionsAttached(editor.state)).toBe(false)
    editor.destroy()
  })

  it('a structural proposal leaves the overlay unattached', () => {
    const editor = makeReviewEditor('Hello.\n', '> Hello.\n')
    expect(suggestionsAttached(editor.state)).toBe(false)
    editor.destroy()
  })
})
