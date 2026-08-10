import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface FrontmatterDoc {
  /** Parsed YAML frontmatter, {} when the file has none. */
  data: Record<string, unknown>
  /** Markdown body after the frontmatter block. */
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Splits a markdown document into YAML frontmatter and body.
 * Malformed YAML is treated as "no frontmatter" — the raw text stays in the
 * body so nothing a user wrote is ever dropped.
 */
export function parseFrontmatter(raw: string): FrontmatterDoc {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { data: {}, body: raw }
  try {
    const data = parseYaml(match[1])
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, body: raw }
    }
    return { data: data as Record<string, unknown>, body: raw.slice(match[0].length) }
  } catch {
    return { data: {}, body: raw }
  }
}

/** Serializes frontmatter + body back into a markdown document. */
export function serializeFrontmatter(doc: FrontmatterDoc): string {
  const hasData = Object.keys(doc.data).length > 0
  if (!hasData) return doc.body
  const yaml = stringifyYaml(doc.data).trimEnd()
  return `---\n${yaml}\n---\n${doc.body}`
}
