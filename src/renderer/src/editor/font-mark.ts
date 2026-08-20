import { Mark } from '@tiptap/core'

/**
 * The span half of the Pandora dialect: a font for a run of text,
 * serialized as a bracketed span — `[text]{font="Garamond"}`. Presentation
 * only; the family name is validated at parse time (no CSS metacharacters).
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSpan: {
      /** Set the font for the selected text. */
      setFontSpan: (family: string) => ReturnType
      /** Remove the font from the selected text. */
      unsetFontSpan: () => ReturnType
    }
  }
}

export const FontMark = Mark.create({
  name: 'font',
  // High priority ranks this mark before the StarterKit marks in the schema,
  // which is what keeps it OUTERMOST when serializing: `[A *b* c]{font="F"}`
  // instead of the span splitting into three around the emphasis.
  priority: 1000,

  addAttributes() {
    return { family: { default: null } }
  },

  parseHTML() {
    return [
      {
        tag: 'span[style]',
        getAttrs: (el) => {
          const family = el.style.fontFamily
          return family ? { family: family.replaceAll('"', '') } : false
        }
      }
    ]
  },

  renderHTML({ mark }) {
    return ['span', { style: `font-family: ${String(mark.attrs.family ?? '')}` }, 0]
  },

  addCommands() {
    return {
      setFontSpan:
        (family) =>
        ({ chain }) => {
          const trimmed = family.trim()
          if (trimmed === '' || /[;{}"\\]/.test(trimmed)) return false
          return chain().setMark('font', { family: trimmed }).run()
        },
      unsetFontSpan:
        () =>
        ({ chain }) =>
          chain().unsetMark('font').run()
    }
  }
})
