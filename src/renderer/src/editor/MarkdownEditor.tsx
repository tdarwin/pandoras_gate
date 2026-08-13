import { useEffect, useMemo, useRef } from 'react'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { baseExtensions } from './extensions'
import { docToMarkdown, markdownToDoc } from './markdown'

/** Style commands the toolbar can drive without knowing the editor library. */
export interface EditorHandle {
  focus: () => void
  toggleBold: () => void
  toggleItalic: () => void
  /** 0 = body text. */
  setHeading: (level: 0 | 1 | 2 | 3) => void
  toggleBlockquote: () => void
  toggleBulletList: () => void
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
  /** Style commands for the toolbar; null when the editor unmounts. */
  onReady?: (handle: EditorHandle | null) => void
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
  onSave,
  onReady
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

  const editor = useEditor(
    {
      extensions: [...baseExtensions(), saveShortcut],
      content: null,
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

  // Load the document whenever a fresh editor instance appears.
  useEffect(() => {
    if (!editor) return
    lastValueRef.current = valueRef.current
    editor.commands.setContent(markdownToDoc(editor.schema, valueRef.current), {
      emitUpdate: false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Expose style commands to the toolbar.
  useEffect(() => {
    if (!editor) return
    onReadyRef.current?.({
      focus: () => editor.commands.focus(),
      toggleBold: () => editor.chain().focus().toggleBold().run(),
      toggleItalic: () => editor.chain().focus().toggleItalic().run(),
      setHeading: (level) => {
        if (level === 0) editor.chain().focus().setParagraph().run()
        else editor.chain().focus().setHeading({ level }).run()
      },
      toggleBlockquote: () => editor.chain().focus().toggleBlockquote().run(),
      toggleBulletList: () => editor.chain().focus().toggleBulletList().run()
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
