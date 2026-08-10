import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { livePreviewPlugin } from './live-preview/decorations'
import { editorTheme } from './theme'

interface MarkdownEditorProps {
  /** Identity of the document — remounting state when it changes. */
  docId: string
  value: string
  onChange: (value: string) => void
  /**
   * When true (AI drafting), external value changes always apply — even while
   * focused — and the view follows the streamed text.
   */
  forceSync?: boolean
  /** ⌘S / Ctrl+S inside the editor. */
  onSave?: () => void
}

/**
 * CodeMirror 6 markdown editor with live preview. The parent owns persistence;
 * this component owns the editing surface. External `value` changes for the
 * same docId are ignored while focused (the buffer is source of truth while
 * the user types).
 */
export default function MarkdownEditor({
  docId,
  value,
  onChange,
  forceSync = false,
  onSave
}: MarkdownEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.()
              return true
            }
          },
          ...defaultKeymap,
          ...historyKeymap
        ]),
        markdown({ base: markdownLanguage }),
        livePreviewPlugin,
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        })
      ]
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Recreate the editor only when switching documents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // External value changes (e.g. AI writes into the file) while not focused —
  // or always, during forced sync (drafting).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current && (forceSync || !view.hasFocus)) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        ...(forceSync
          ? { selection: { anchor: value.length }, scrollIntoView: true }
          : {})
      })
    }
  }, [value, forceSync])

  return <div ref={containerRef} className="h-full min-h-0" />
}
