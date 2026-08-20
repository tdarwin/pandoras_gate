import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import type { Extensions } from '@tiptap/core'
import { StyledBlock } from './styled-block'
import { FontMark } from './font-mark'

const ASSET_URL_PREFIX = 'pandora-asset://novel/'

/** True for the relative asset paths chapter markdown links (`assets/…`). */
function isRelativeSrc(src: unknown): src is string {
  return typeof src === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/')
}

/**
 * Markdown image srcs are URLs, so percent-escapes in them are honored:
 * a hand-authored `assets/my%20file.png` means the file "my file.png".
 * Each segment is decoded before re-encoding — blindly re-encoding would
 * yield `%2520`, and the scheme handler's single decode would then look
 * for a literal "my%20file.png". A segment with a malformed escape (a
 * literal `%` as in `100%.png`) is treated as a literal name.
 */
function encodeSrcSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment))
  } catch {
    return encodeURIComponent(segment)
  }
}

/**
 * The image node keeps the markdown-relative `src` (`assets/foo.png`) as its
 * source of truth; only the rendered <img> maps it onto the privileged
 * pandora-asset:// scheme, which is the sole way the sandboxed renderer can
 * display novel files. parseHTML reverses the mapping so copy/paste within
 * the editor never leaks scheme URLs into the markdown — kept in encoded
 * form, which is exactly the markdown-safe spelling of the relative path.
 */
const NovelImage = Image.extend({
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => {
          const src = el.getAttribute('src') ?? ''
          return {
            src: src.startsWith(ASSET_URL_PREFIX) ? src.slice(ASSET_URL_PREFIX.length) : src,
            alt: el.getAttribute('alt'),
            title: el.getAttribute('title')
          }
        }
      }
    ]
  },
  renderHTML({ HTMLAttributes }) {
    const src = HTMLAttributes['src']
    const mapped = isRelativeSrc(src)
      ? { ...HTMLAttributes, src: ASSET_URL_PREFIX + src.split('/').map(encodeSrcSegment).join('/') }
      : HTMLAttributes
    return ['img', mapped]
  }
})

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
    NovelImage.configure({ inline: true }),
    // GFM pipe tables. Column resizing stays off — widths have no markdown
    // form and would be lost on every save.
    TableKit,
    // The Pandora dialect: styled blocks (fenced divs) and font spans.
    StyledBlock,
    FontMark
  ]
}
