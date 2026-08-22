import { useEffect, useMemo, useRef } from 'react'
import { Extension, getSchema } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import { baseExtensions } from './extensions'
import { markdownToDoc } from './markdown'
import {
  TrackChanges,
  pendingChangeCount,
  savableMarkdown,
  proposedMarkdown,
  type AttachSpec
} from './track-changes'
import { ImagePaste } from './image-paste'

/** Style commands the toolbar can drive without knowing the editor library. */
export interface EditorHandle {
  focus: () => void
  toggleBold: () => void
  toggleItalic: () => void
  toggleUnderline: () => void
  toggleStrike: () => void
  /** Inline code (monospace span). */
  toggleCode: () => void
  /** 0 = body text. */
  setHeading: (level: 0 | 1 | 2 | 3) => void
  toggleBlockquote: () => void
  toggleBulletList: () => void
  toggleOrderedList: () => void
  toggleCodeBlock: () => void
  insertHorizontalRule: () => void
  /** Inserts a 3×3 table with a header row at the cursor. */
  insertTable: () => void
  addRowAfter: () => void
  addColumnAfter: () => void
  deleteRow: () => void
  deleteColumn: () => void
  deleteTable: () => void
  /** Align the current block(s); null = default left. */
  setBlockAlign: (align: 'center' | 'right' | null) => void
  /** Tint the current block(s) — a named tint or #hex; null clears. */
  setBlockBg: (bg: string | null) => void
  /** Font for the current block(s); null = the theme font. */
  setBlockFont: (font: string | null) => void
  /** Font for the selected text; null removes it. */
  setSpanFont: (family: string | null) => void
  /** File-picker flow: imports into assets/ and inserts at the cursor. */
  insertImage: () => void
  /** Alt text for the selected image. */
  setImageAlt: (alt: string) => void
  /** Whether a mark/node is active at the selection (toolbar highlighting). */
  isActive: (name: string, attrs?: Record<string, unknown>) => boolean
  /** Current attrs of a mark/node at the selection (toolbar values). */
  getAttributes: (name: string) => Record<string, unknown>
  /** Fires on every document/selection change; returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void

  /* --- Suggestions (no-ops when nothing is attached) --- */
  /** Undecided suggestions currently shown. */
  suggestionCount: () => number
  /** Markdown as it should be saved: undecided suggestions reverted. */
  savableBody: () => string
  /** Markdown of what one proposal still proposes. */
  proposedBody: (proposalId: string) => string
  acceptAllSuggestions: () => void
  rejectAllSuggestions: () => void
  /** Moves the caret to the next suggestion, wrapping; false when there are none. */
  goToNextSuggestion: () => boolean
  /** Shows suggestions on the live document — no remount, no focus change. */
  attachSuggestions: (spec: AttachSpec) => void
  /** Drops the overlay, leaving the savable document behind. */
  detachSuggestions: () => void
}

/** Asset-import callbacks the workspace wires to main (null = no novel). */
export interface ImageImporter {
  fromDialog: () => Promise<{ rel: string } | null>
  fromFile: (file: File) => Promise<{ rel: string } | null>
}

interface MarkdownEditorProps {
  /** Identity of the document — remounting state when it changes. */
  docId: string
  /** Markdown BODY (frontmatter is handled outside the editor). */
  value: string
  onChange: (value: string) => void
  /**
   * When true (AI drafting), external value changes always apply — even while
   * focused — and the view follows the streamed text.
   */
  forceSync?: boolean
  /** ⌘S / Ctrl+S inside the editor. */
  onSave?: () => void
  /** False locks out typing (pointer-events CSS alone doesn't stop the keyboard). */
  editable?: boolean
  /** Style commands for the toolbar; null when the editor unmounts. */
  onReady?: (handle: EditorHandle | null) => void
  /**
   * Pending suggestions for this document: the on-disk body plus the
   * proposals folded onto it. The difference renders inline as tracked
   * changes with ✓/✕ per chunk, in the ordinary editor — no mode switch.
   * Null when the document has nothing pending.
   */
  suggestion?: AttachSpec | null
  /** proposalId → human label, for per-chunk attribution on hover. */
  suggestionTitles?: Record<string, string>
  /** Fires when the set of undecided suggestions changes. */
  onSuggestionsChange?: (count: number) => void
  /** Image import into the novel's assets (toolbar, paste, drop). */
  importImage?: ImageImporter
}

/** During streamed drafts, re-render the doc at most this often. */
const STREAM_APPLY_MS = 250

/**
 * True-WYSIWYG prose editor (TipTap/ProseMirror). Markdown in, markdown out —
 * the writer never sees syntax. The parent owns persistence; external `value`
 * changes for the same docId are ignored while focused (the buffer is source
 * of truth while the user types), except during forced sync.
 */
export default function MarkdownEditor({
  docId,
  value,
  onChange,
  forceSync = false,
  editable = true,
  onSave,
  onReady,
  suggestion = null,
  suggestionTitles,
  onSuggestionsChange,
  importImage
}: MarkdownEditorProps): React.JSX.Element {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const importImageRef = useRef(importImage)
  importImageRef.current = importImage
  /** The markdown the current editor doc corresponds to. */
  const lastValueRef = useRef(value)
  const valueRef = useRef(value)
  valueRef.current = value
  // Kept in sync: `initialContent` reads this on every docId change, so a
  // stale spec would seed the new chapter with the previous one's proposal.
  const suggestionRef = useRef(suggestion)
  suggestionRef.current = suggestion
  const suggestionTitlesRef = useRef(suggestionTitles)
  suggestionTitlesRef.current = suggestionTitles
  const onSuggestionsChangeRef = useRef(onSuggestionsChange)
  onSuggestionsChangeRef.current = onSuggestionsChange

  const saveShortcut = useMemo(
    () =>
      Extension.create({
        name: 'saveShortcut',
        addKeyboardShortcuts() {
          return {
            'Mod-s': () => {
              onSaveRef.current?.()
              return true
            }
          }
        }
      }),
    []
  )

  // Parse the initial document at creation so the editor never sees a
  // transient empty doc. With suggestions attached the document IS the folded
  // proposal — `value` stays the savable body, which is what the parent saves.
  const initialContent = useMemo(() => {
    lastValueRef.current = valueRef.current
    const spec = suggestionRef.current
    const body = spec?.chain[spec.chain.length - 1]?.content ?? valueRef.current
    return markdownToDoc(getSchema(baseExtensions()), body).toJSON() as object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  /**
   * Pushes the savable document up, then the count.
   *
   * Order matters both ways. Content first, because a decision that CHANGES
   * the text (accept) must leave the buffer dirty before anything reacts to
   * the count — otherwise the store persists the decision against the old
   * buffer and resolves the proposals out from under the save that follows.
   * Count always, because a decision that changes NOTHING (reject) would
   * otherwise never be reported at all.
   */
  const emit = (state: EditorState): void => {
    const md = savableMarkdown(state)
    // TipTap emits one update as the editor is created. Passing that up marks
    // a freshly opened document dirty, which queues an autosave that rewrites
    // a file the author only looked at.
    if (md !== lastValueRef.current) {
      lastValueRef.current = md
      onChangeRef.current(md)
    }
    onSuggestionsChangeRef.current?.(pendingChangeCount(state))
  }

  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions(),
        saveShortcut,
        ImagePaste.configure({
          onImportImage: (file) => importImageRef.current?.fromFile(file) ?? Promise.resolve(null)
        }),
        // Always present, never toggled by remounting the editor: recreating
        // it steals focus and resets the caret, and suggestions can arrive
        // 15 s after a save — mid-sentence.
        TrackChanges.configure({
          suggestion: suggestionRef.current,
          ...(suggestionTitlesRef.current ? { titles: suggestionTitlesRef.current } : {})
        })
      ],
      content: initialContent,
      autofocus: true,
      editorProps: {
        attributes: {
          class: 'prose-editor',
          spellcheck: 'true'
        }
      },
      onUpdate({ editor }) {
        // The SAVABLE document, not the visible one: with suggestions shown
        // the editor holds AI text the author has not agreed to, and autosave
        // must not write it.
        emit(editor.state)
      }
    },
    // Recreate (fresh undo history) only when switching documents.
    [docId]
  )

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(editable)
  }, [editor, editable])

  // Expose style commands to the toolbar.
  useEffect(() => {
    if (!editor) return
    onReadyRef.current?.({
      focus: () => editor.commands.focus(),
      toggleBold: () => editor.chain().focus().toggleBold().run(),
      toggleItalic: () => editor.chain().focus().toggleItalic().run(),
      toggleUnderline: () => editor.chain().focus().toggleUnderline().run(),
      toggleStrike: () => editor.chain().focus().toggleStrike().run(),
      toggleCode: () => editor.chain().focus().toggleCode().run(),
      setHeading: (level) => {
        if (level === 0) editor.chain().focus().setParagraph().run()
        else editor.chain().focus().setHeading({ level }).run()
      },
      toggleBlockquote: () => editor.chain().focus().toggleBlockquote().run(),
      toggleBulletList: () => editor.chain().focus().toggleBulletList().run(),
      toggleOrderedList: () => editor.chain().focus().toggleOrderedList().run(),
      toggleCodeBlock: () => editor.chain().focus().toggleCodeBlock().run(),
      insertHorizontalRule: () => editor.chain().focus().setHorizontalRule().run(),
      insertTable: () =>
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      addRowAfter: () => editor.chain().focus().addRowAfter().run(),
      addColumnAfter: () => editor.chain().focus().addColumnAfter().run(),
      deleteRow: () => editor.chain().focus().deleteRow().run(),
      deleteColumn: () => editor.chain().focus().deleteColumn().run(),
      deleteTable: () => editor.chain().focus().deleteTable().run(),
      setBlockAlign: (align) => editor.chain().focus().setBlockAlign(align).run(),
      setBlockBg: (bg) => editor.chain().focus().setBlockBg(bg).run(),
      setBlockFont: (font) => editor.chain().focus().setBlockFont(font).run(),
      setSpanFont: (family) => {
        if (family === null) editor.chain().focus().unsetFontSpan().run()
        else editor.chain().focus().setFontSpan(family).run()
      },
      insertImage: () => {
        void importImageRef.current?.fromDialog().then((result) => {
          if (!result || editor.isDestroyed) return
          const node = editor.schema.nodes.image!.create({ src: result.rel })
          editor.view.dispatch(editor.state.tr.replaceSelectionWith(node))
          editor.commands.focus()
        })
      },
      setImageAlt: (alt) =>
        editor.chain().focus().updateAttributes('image', { alt: alt || null }).run(),
      isActive: (name, attrs) => (attrs ? editor.isActive(name, attrs) : editor.isActive(name)),
      getAttributes: (name) => editor.getAttributes(name),
      subscribe: (cb) => {
        editor.on('transaction', cb)
        return () => {
          editor.off('transaction', cb)
        }
      },

      suggestionCount: () => pendingChangeCount(editor.state),
      savableBody: () => savableMarkdown(editor.state),
      proposedBody: (proposalId) => proposedMarkdown(editor.state, proposalId),
      acceptAllSuggestions: () => {
        editor.chain().acceptAllChanges().run()
      },
      rejectAllSuggestions: () => {
        editor.chain().rejectAllChanges().run()
      },
      goToNextSuggestion: () => editor.chain().goToNextSuggestion().run(),
      attachSuggestions: (spec) => {
        editor.chain().attachSuggestions(spec).run()
      },
      detachSuggestions: () => {
        editor.chain().detachSuggestions().run()
      }
    })
    return () => onReadyRef.current?.(null)
  }, [editor])

  // External value changes (AI writes into the file) while not focused — or
  // always, during forced sync (drafting), throttled so streaming doesn't
  // re-render the document on every token.
  const streamTimerRef = useRef<number | null>(null)
  const lastStreamApplyRef = useRef(0)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (valueRef.current === lastValueRef.current) return

    const apply = (): void => {
      const next = valueRef.current
      lastValueRef.current = next
      const doc = markdownToDoc(editor.schema, next)
      const { state, dispatch } = editor.view
      const tr = state.tr.replace(0, state.doc.content.size, doc.slice(0, doc.content.size))
      // An external write is not something the author did, so it is not
      // something ⌘Z should undo. TipTap's setContent is an ordinary
      // history-recorded replace: pressing undo after an AI change reverted
      // it in one step and autosave then persisted the reversion — and every
      // 250 ms frame of a streamed draft was its own undo step.
      tr.setMeta('addToHistory', false)
      if (forceSync) {
        // Follow the streamed text without stealing focus.
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size)).scrollIntoView()
      } else {
        // Keep the caret where it was rather than snapping to the top.
        const from = Math.min(state.selection.from, tr.doc.content.size)
        tr.setSelection(TextSelection.near(tr.doc.resolve(from)))
      }
      dispatch(tr)
    }

    if (forceSync) {
      if (streamTimerRef.current !== null) return
      const since = Date.now() - lastStreamApplyRef.current
      const delay = Math.max(0, STREAM_APPLY_MS - since)
      streamTimerRef.current = window.setTimeout(() => {
        streamTimerRef.current = null
        lastStreamApplyRef.current = Date.now()
        apply()
      }, delay)
    } else if (!editor.isFocused) {
      apply()
    }
  }, [editor, value, forceSync])

  // Flush any pending stream frame when unmounting or leaving forceSync.
  useEffect(() => {
    return () => {
      if (streamTimerRef.current !== null) {
        window.clearTimeout(streamTimerRef.current)
        streamTimerRef.current = null
      }
    }
  }, [editor])

  // The wrapper (not the scroller) carries the theme background image, so
  // the image stays put while the prose scrolls over it.
  return (
    <div className="editor-surface h-full min-h-0">
      <EditorContent editor={editor} className="h-full min-h-0 overflow-y-auto" />
    </div>
  )
}
