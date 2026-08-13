import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import type { Extensions } from '@tiptap/core'

/**
 * The document model shared by the editor component and the markdown bridge
 * tests. Underline is disabled (it has no markdown form); links don't
 * navigate on click inside the app.
 */
export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      underline: false,
      link: { openOnClick: false }
    }),
    // Markdown images are inline tokens; the block-mode default would make
    // the parser silently drop them.
    Image.configure({ inline: true })
  ]
}
