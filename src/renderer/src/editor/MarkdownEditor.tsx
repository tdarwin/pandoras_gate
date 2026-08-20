import { useEffect, useMemo, useRef } from 'react'
import { Extension, getSchema } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { baseExtensions } from './extensions'
import { docToMarkdown, markdownToDoc } from './markdown'
import { TrackChanges } from './track-changes'

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
  /** Whether a mark/node is active at the selection (toolbar highlighting). */
  isActive: (name: string, attrs?: Record<string, unknown>) => boolean
  /** Fires on every document/selection change; returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void
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
   * Review mode: `value` holds the PROPOSED body and this holds the on-disk
   * body — the difference renders as tracked changes with ✓/✕ per chunk.
   */
  reviewOriginal?: string
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
  reviewOriginal
}: MarkdownEditorProps): React.JSX.Element {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  /** The markdown the current editor doc corresponds to. */
  const lastValueRef = useRef(value)
  const valueRef = useRef(value)
  valueRef.current = value

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

  // Parse the initial document at creation so the editor (and the review
  // diff, when active) never sees a transient empty doc.
  const initialContent = useMemo(() => {
    lastValueRef.current = valueRef.current
    return markdownToDoc(getSchema(baseExtensions()), valueRef.current).toJSON() as object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions(),
        saveShortcut,
        ...(reviewOriginal !== undefined
          ? [TrackChanges.configure({ original: reviewOriginal })]
          : [])
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
        const md = docToMarkdown(editor.state.doc)
        lastValueRef.current = md
        onChangeRef.current(md)
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
      isActive: (name, attrs) => (attrs ? editor.isActive(name, attrs) : editor.isActive(name)),
      subscribe: (cb) => {
        editor.on('transaction', cb)
        return () => {
          editor.off('transaction', cb)
        }
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
      editor.commands.setContent(markdownToDoc(editor.schema, next), { emitUpdate: false })
      if (forceSync) {
        // Follow the streamed text without stealing focus.
        editor
          .chain()
          .setTextSelection(editor.state.doc.content.size)
          .scrollIntoView()
          .run()
      }
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

  return <EditorContent editor={editor} className="h-full min-h-0 overflow-y-auto" />
}
