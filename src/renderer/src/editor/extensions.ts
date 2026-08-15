import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import type { Extensions } from '@tiptap/core'

/**
 * The document model shared by the editor component and the markdown bridge
 * tests. Underline serializes as literal <u> tags (markdown has no native
 * form); links don't navigate on click inside the app.
 */
export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false }
    }),
    // Markdown images are inline tokens; the block-mode default would make
    // the parser silently drop them.
    Image.configure({ inline: true }),
    // GFM pipe tables. Column resizing stays off — widths have no markdown
    // form and would be lost on every save.
    TableKit
  ]
}
