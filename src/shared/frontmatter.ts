import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface FrontmatterDoc {
  /** Parsed YAML frontmatter, {} when the file has none or the block is unreadable. */
  data: Record<string, unknown>
  /** Markdown body after the frontmatter block. */
  body: string
  /**
   * The inside of a `---` block that is NOT a YAML mapping — a hand-edited
   * `title: Chapter 1: The Gate`, a list, a stray tab. Null when the block
   * parsed, and null when there was no block at all.
   *
   * It is kept apart from the body so a broken block never renders as prose in
   * the writing surface, and never gets rewritten as prose on the next save.
   * `data` is always {} when this is set: the two are mutually exclusive by
   * construction, and anything that needs to SET a field must check this first
   * rather than write a second block over YAML it could not read.
   */
  rawFrontmatter: string | null
}

// The inner group is optional: deleting every field in another editor leaves
// tight fences (`---\n---`), and requiring a line between them turned those
// into the first two lines of the prose.
const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/

/**
 * Splits a markdown document into YAML frontmatter and body.
 *
 * A leading UTF-8 BOM is dropped: Node keeps it on read, so `^---` would miss
 * the block entirely and the whole file — fences included — would be treated as
 * prose. The BOM does not come back on the next write.
 */
export function parseFrontmatter(raw: string): FrontmatterDoc {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { data: {}, body: text, rawFrontmatter: null }
  const body = text.slice(match[0].length)
  const inner = match[1] ?? ''
  // An empty block is not an unreadable one — `---\n\n---` is just a document
  // with no details. Treating it as unreadable put the amber notice over an
  // empty textarea and round-tripped bare fences forever.
  if (!inner.trim()) return { data: {}, body, rawFrontmatter: null }
  try {
    const data: unknown = parseYaml(inner)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, body, rawFrontmatter: inner }
    }
    return { data: data as Record<string, unknown>, body, rawFrontmatter: null }
  } catch {
    return { data: {}, body, rawFrontmatter: inner }
  }
}

/**
 * Serializes frontmatter + body back into a markdown document. An unreadable
 * block round-trips verbatim (and `data` is ignored — see `rawFrontmatter`).
 */
export function serializeFrontmatter(doc: {
  data: Record<string, unknown>
  body: string
  /** Omit when building a document from scratch — there is no block to keep. */
  rawFrontmatter?: string | null
}): string {
  if (doc.rawFrontmatter != null) return `---\n${doc.rawFrontmatter}\n---\n${doc.body}`
  if (Object.keys(doc.data).length === 0) return doc.body
  const yaml = stringifyYaml(doc.data).trimEnd()
  return `---\n${yaml}\n---\n${doc.body}`
}
