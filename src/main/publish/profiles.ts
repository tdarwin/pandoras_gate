import MarkdownIt from 'markdown-it'

/**
 * Publishing profiles: chapter markdown → HTML shaped for a platform's post
 * editor, plus a plain-text fallback. Both go on the clipboard together, so
 * a paste into RoyalRoad/Patreon carries formatting while plain targets get
 * readable text.
 *
 * Platform notes:
 * - RoyalRoad's editor accepts rich paste incl. <hr> scene breaks and tables
 *   (LitRPG stat blocks) — pass both through.
 * - Patreon's post editor has no horizontal rule and only shallow headings:
 *   scene breaks become a "* * *" paragraph, headings below h2 become bold
 *   paragraphs. Tables paste degraded there; authors see it on paste.
 * - Both platforms take the chapter title in a separate field, so a leading
 *   H1 that just repeats the title is dropped from the body.
 */

export type PublishPlatform = 'royalroad' | 'patreon'

function baseRenderer() {
  // Same dialect the editor writes: CommonMark + strikethrough, raw HTML
  // treated as text — plus tables, which prose files may carry for stats.
  // xhtmlOut off: paste targets want HTML5-style tags (<hr>, <br>).
  return MarkdownIt('commonmark', { html: false, xhtmlOut: false }).enable([
    'strikethrough',
    'table'
  ])
}

const royalroad = baseRenderer()

const patreon = baseRenderer()
patreon.renderer.rules.hr = () => '<p>* * *</p>\n'
patreon.renderer.rules.heading_open = (tokens: { tag: string }[], idx: number) => {
  const tag = tokens[idx]!.tag
  return tag === 'h1' || tag === 'h2' ? `<${tag}>` : '<p><strong>'
}
patreon.renderer.rules.heading_close = (tokens: { tag: string }[], idx: number) => {
  const tag = tokens[idx]!.tag
  return tag === 'h1' || tag === 'h2' ? `</${tag}>\n` : '</strong></p>\n'
}

const renderers: Record<PublishPlatform, ReturnType<typeof baseRenderer>> = {
  royalroad,
  patreon
}

/**
 * Drops a leading `# Title` that repeats the chapter title — both platforms
 * take the title in their own field, and a duplicated heading at the top of
 * the post is the most common paste cleanup authors do by hand.
 */
export function stripLeadingTitle(bodyMd: string, chapterTitle: string): string {
  const lines = bodyMd.split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  const first = lines[i] ?? ''
  const m = /^#\s+(.+?)\s*#*\s*$/.exec(first.trim())
  if (m && m[1]!.trim().toLowerCase() === chapterTitle.trim().toLowerCase()) {
    return lines.slice(i + 1).join('\n').replace(/^\n+/, '')
  }
  return bodyMd
}

export function chapterHtml(
  bodyMd: string,
  platform: PublishPlatform,
  chapterTitle?: string
): string {
  const body = chapterTitle ? stripLeadingTitle(bodyMd, chapterTitle) : bodyMd
  return renderers[platform].render(body).trim()
}

/** Readable formatting-free fallback for the clipboard's text flavor. */
export function chapterPlainText(bodyMd: string, chapterTitle?: string): string {
  const body = chapterTitle ? stripLeadingTitle(bodyMd, chapterTitle) : bodyMd
  const html = royalroad.render(body)
  return html
    .replace(/<hr\s*\/?>/g, '* * *')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<\/(p|h[1-6]|li|blockquote|tr|table)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
