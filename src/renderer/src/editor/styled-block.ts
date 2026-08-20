import { Node, type CommandProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, type Transaction } from '@tiptap/pm/state'
import { isNamedTint } from '@shared/markdownAttrs'

/**
 * The block half of the Pandora dialect: a container carrying presentation
 * attributes (alignment, background tint, font), serialized as a fenced div
 * — `::: {align=center bg=note}` … `:::`. Writers see a styled box, never
 * the fences. One level only: a guard plugin unwraps any nested instance,
 * and a block whose attributes all clear is unwrapped too.
 */

export interface StyledBlockAttrs {
  align: 'center' | 'right' | null
  bg: string | null
  font: string | null
  /** Unrecognized on-disk attrs, preserved verbatim. */
  extra: string | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    styledBlock: {
      /** Align the current block(s); null returns to the default left. */
      setBlockAlign: (align: 'center' | 'right' | null) => ReturnType
      /** Tint the current block(s); a named tint or #hex, null clears. */
      setBlockBg: (bg: string | null) => ReturnType
      /** Set the block font; null returns to the theme font. */
      setBlockFont: (font: string | null) => ReturnType
    }
  }
}

function hasAnyAttr(attrs: Record<string, unknown>): boolean {
  return Boolean(attrs['align'] ?? attrs['bg'] ?? attrs['font'] ?? attrs['extra'])
}

/** Set one attribute: update the surrounding block, or wrap to create one;
 * lift the block when its last attribute clears. */
function setAttr(key: 'align' | 'bg' | 'font', value: string | null) {
  return ({ editor, chain }: CommandProps): boolean => {
    if (editor.isActive('styledBlock')) {
      const next = { ...editor.getAttributes('styledBlock'), [key]: value }
      if (!hasAnyAttr(next)) return chain().lift('styledBlock').run()
      return chain().updateAttributes('styledBlock', { [key]: value }).run()
    }
    if (value === null) return false
    return chain().wrapIn('styledBlock', { [key]: value }).run()
  }
}

export const StyledBlock = Node.create({
  name: 'styledBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      align: { default: null },
      bg: { default: null },
      font: { default: null },
      extra: { default: null }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-styled-block]',
        getAttrs: (el) => ({
          align: el.getAttribute('data-align'),
          bg: el.getAttribute('data-bg') ?? (el.style.background || null),
          font: el.style.fontFamily || null,
          extra: el.getAttribute('data-extra')
        })
      }
    ]
  },

  renderHTML({ node }) {
    const { align, bg, font, extra } = node.attrs as StyledBlockAttrs
    const attrs: Record<string, string> = { 'data-styled-block': '' }
    const style: string[] = []
    if (align) {
      attrs['data-align'] = align
      style.push(`text-align: ${align}`)
    }
    if (bg) {
      // Named tints style via CSS tokens so they follow the theme; raw hex
      // is the author's explicit choice. Values are validated at parse time.
      if (isNamedTint(bg)) attrs['data-bg'] = bg
      else style.push(`background: ${bg}`)
    }
    if (font) style.push(`font-family: ${font}`)
    if (extra) attrs['data-extra'] = extra
    if (style.length > 0) attrs['style'] = style.join('; ')
    return ['div', attrs, 0]
  },

  addCommands() {
    return {
      setBlockAlign: (align) => setAttr('align', align),
      setBlockBg: (bg) => setAttr('bg', bg),
      setBlockFont: (font) => setAttr('font', font)
    }
  },

  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        // The dialect has no nested form, and an attribute-less block has no
        // on-disk form at all — unwrap both however they were produced
        // (wrapping a mixed selection, pasting, collaborative edits).
        appendTransaction(transactions, _oldState, newState): Transaction | null {
          if (!transactions.some((tr) => tr.docChanged)) return null
          let tr: Transaction | null = null
          const unwrap = (node: PMNode, pos: number): void => {
            tr ??= newState.tr
            tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize), node.content)
          }
          newState.doc.descendants((node, pos) => {
            if (node.type !== type) return true
            if (!hasAnyAttr(node.attrs)) {
              unwrap(node, pos)
              return false
            }
            let nested = false
            node.descendants((child) => {
              if (child.type === type) nested = true
              return !nested
            })
            if (nested) {
              // Unwrap the OUTER block's inner children by lifting each
              // nested instance's content in place.
              node.descendants((child, childPos) => {
                if (child.type === type) {
                  unwrap(child, pos + 1 + childPos)
                  return false
                }
                return true
              })
            }
            return true
          })
          return tr
        }
      })
    ]
  }
})
