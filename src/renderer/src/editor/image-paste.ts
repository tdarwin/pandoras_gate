import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

export interface ImagePasteOptions {
  /**
   * Imports pasted/dropped image bytes into the novel's assets folder and
   * returns the relative path for the markdown link — or null to decline
   * (no novel open, import failed). Wired by the workspace; the extension
   * stays free of IPC.
   */
  onImportImage: ((file: File) => Promise<{ rel: string } | null>) | null
}

/**
 * Paste-from-clipboard and drag-and-drop for images. The file lands in
 * `<novel>/assets/` via the configured importer and the document gets a
 * relative-src image node — never base64 in the markdown.
 */
export const ImagePaste = Extension.create<ImagePasteOptions>({
  name: 'imagePaste',

  addOptions() {
    return { onImportImage: null }
  },

  addProseMirrorPlugins() {
    const { editor, options } = this

    const insertFiles = (files: File[], dropPos?: number): boolean => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0 || !options.onImportImage) return false
      for (const file of images) {
        void options.onImportImage(file).then((result) => {
          if (!result || editor.isDestroyed) return
          const node = editor.schema.nodes.image!.create({
            src: result.rel,
            alt: file.name.replace(/\.[^.]*$/, '') || null
          })
          const tr = editor.state.tr
          // The import is fast and local, but the caret may have moved:
          // a drop lands where it happened, a paste at the live selection.
          editor.view.dispatch(
            dropPos !== undefined && dropPos <= tr.doc.content.size
              ? tr.insert(dropPos, node)
              : tr.replaceSelectionWith(node)
          )
        })
      }
      return true
    }

    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) =>
            insertFiles(Array.from(event.clipboardData?.files ?? [])),
          handleDrop: (view, event) => {
            const files = Array.from(event.dataTransfer?.files ?? [])
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            return insertFiles(files, pos)
          }
        }
      })
    ]
  }
})
