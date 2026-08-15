import MarkdownIt from 'markdown-it'
import {
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  defaultMarkdownSerializer
} from 'prosemirror-markdown'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { underlineTags } from '@shared/markdownUnderline'

/**
 * Markdown ⇄ ProseMirror bridge bound to the TipTap schema. Markdown stays
 * the on-disk format; the editor never shows it. Output is normalized (ATX
 * headings, "-" bullets, "*"/"**" emphasis, tight lists) and idempotent for
 * the prose subset: serializing an already-normalized document reproduces it
 * byte-for-byte.
 *
 * Anything the parser can't understand degrades to plain-text paragraphs —
 * nothing a user wrote is ever dropped.
 */

/** CommonMark + GFM strikethrough and pipe tables; raw HTML is treated as
 * literal text, except <u>…</u> which round-trips the underline mark
 * (shared dialect — see @shared/markdownUnderline). */
const tokenizer = MarkdownIt('commonmark', { html: false })
  .enable(['strikethrough', 'table'])
  .use(underlineTags)

// ProseMirror table cells hold block content, but markdown-it emits cell
// text as bare inline tokens — wrap each cell in a paragraph pair so the
// parser can build tableCell(paragraph(...)).
tokenizer.core.ruler.push('pm_table_cells', (state) => {
  if (!state.tokens.some((t) => t.type === 'table_open')) return
  const out: typeof state.tokens = []
  for (const tok of state.tokens) {
    if (tok.type === 'th_open' || tok.type === 'td_open') {
      out.push(tok, new state.Token('paragraph_open', 'p', 1))
    } else if (tok.type === 'th_close' || tok.type === 'td_close') {
      out.push(new state.Token('paragraph_close', 'p', -1), tok)
    } else {
      out.push(tok)
    }
  }
  state.tokens = out
})

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok) => ({ start: Number(tok.attrGet('start') ?? 1) })
    },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: {
      block: 'codeBlock',
      getAttrs: (tok) => ({ language: tok.info || null }),
      noCloseToken: true
    },
    hr: { node: 'horizontalRule' },
    image: {
      node: 'image',
      getAttrs: (tok) => ({
        src: tok.attrGet('src'),
        title: tok.attrGet('title') || null,
        alt: tok.children?.[0]?.content || null
      })
    },
    hardbreak: { node: 'hardBreak' },
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader' },
    td: { block: 'tableCell' },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    u: { mark: 'underline' },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href') }) },
    code_inline: { mark: 'code', noCloseToken: true }
  })
}

/* Reuse prosemirror-markdown's battle-tested serializers, rekeyed to TipTap
 * node/mark names. Custom where attribute names differ (codeBlock.language
 * vs code_block.params, orderedList.start vs ordered_list.order) or where
 * we pin house style ("-" bullets). */
const d = defaultMarkdownSerializer

/** Serializer-state internals the table capture borrows (stable at runtime,
 * absent from the public typings). */
interface StateInternals {
  out: string
  delim: string
  closed: PMNode | null
}

/**
 * Renders a cell's content as a single-line inline-markdown string by
 * running the state's own inline renderer against a swapped-out buffer.
 * Block boundaries inside a cell flatten to spaces; pipes are escaped so
 * they can't break the row.
 */
function cellText(state: MarkdownSerializerState, cell: PMNode): string {
  const s = state as unknown as MarkdownSerializerState & StateInternals
  const saved = { out: s.out, delim: s.delim, closed: s.closed }
  s.delim = ''
  s.closed = null
  const parts: string[] = []
  cell.forEach((block) => {
    if (block.isTextblock) {
      s.out = ''
      state.renderInline(block, false)
      if (s.out) parts.push(s.out)
    } else if (block.textContent.trim()) {
      parts.push(block.textContent)
    }
  })
  s.out = saved.out
  s.delim = saved.delim
  s.closed = saved.closed
  return parts
    .join(' ')
    .replace(/\\\n/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

const serializer = new MarkdownSerializer(
  {
    blockquote: d.nodes.blockquote!,
    codeBlock(state, node) {
      const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
      // Widen the fence beyond any run of backticks inside the block.
      const backticks = node.textContent.match(/`{3,}/gm)
      const fence = backticks ? backticks.sort().at(-1)! + '`' : '```'
      state.write(fence + language + '\n')
      state.text(node.textContent, false)
      state.write('\n')
      state.write(fence)
      state.closeBlock(node)
    },
    heading: d.nodes.heading!,
    horizontalRule: d.nodes.horizontal_rule!,
    bulletList(state, node) {
      state.renderList(node, '  ', () => '- ')
    },
    orderedList(state, node) {
      const start = Number(node.attrs.start ?? 1)
      const maxW = String(start + node.childCount - 1).length
      state.renderList(node, state.repeat(' ', maxW + 2), (i) => {
        const nStr = String(start + i)
        return state.repeat(' ', maxW - nStr.length) + nStr + '. '
      })
    },
    listItem: d.nodes.list_item!,
    paragraph: d.nodes.paragraph!,
    image: d.nodes.image!,
    hardBreak: d.nodes.hard_break!,
    // GFM pipe table: first row serves as the header row (GFM requires one).
    // Rows and cells are rendered here wholesale, never via own handlers.
    table(state, node) {
      const rows: string[][] = []
      node.forEach((row) => {
        const cells: string[] = []
        row.forEach((cell) => cells.push(cellText(state, cell)))
        rows.push(cells)
      })
      const cols = Math.max(1, ...rows.map((r) => r.length))
      const line = (cells: string[]): string =>
        `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`
      state.write(line(rows[0] ?? []))
      state.ensureNewLine()
      state.write(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`)
      state.ensureNewLine()
      for (const row of rows.slice(1)) {
        state.write(line(row))
        state.ensureNewLine()
      }
      state.closeBlock(node)
    },
    text: d.nodes.text!
  },
  {
    bold: d.marks.strong!,
    italic: d.marks.em!,
    code: d.marks.code!,
    link: d.marks.link!,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    underline: { open: '<u>', close: '</u>', mixable: true, expelEnclosingWhitespace: true }
  }
)

/** Last-resort import: every line becomes a plain paragraph, nothing lost. */
function plainTextDoc(schema: Schema, text: string): PMNode {
  const paragraph = schema.nodes.paragraph!
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => paragraph.createChecked(null, line ? [schema.text(line)] : []))
  return schema.nodes.doc!.createChecked(null, paragraphs.length ? paragraphs : [paragraph.createChecked()])
}

const parserCache = new WeakMap<Schema, MarkdownParser>()

/** Parses markdown into a document of the given schema. Never throws. */
export function markdownToDoc(schema: Schema, markdown: string): PMNode {
  if (!markdown.trim()) return plainTextDoc(schema, '')
  let parser = parserCache.get(schema)
  if (!parser) {
    parser = buildParser(schema)
    parserCache.set(schema, parser)
  }
  try {
    return parser.parse(markdown)
  } catch {
    return plainTextDoc(schema, markdown)
  }
}

/** Serializes a document to normalized markdown (trailing newline included). */
export function docToMarkdown(doc: PMNode): string {
  // Prose lists are tight; TipTap nodes carry no `tight` attr of their own.
  const out = serializer.serialize(doc, { tightLists: true })
  return out.trim() ? out.replace(/\n*$/, '\n') : ''
}
