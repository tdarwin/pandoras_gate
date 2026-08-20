import MarkdownIt from 'markdown-it'
import { underlineTags } from '../../shared/markdownUnderline'
import { styledBlockFences } from '../../shared/markdownStyledBlock'
import { fontSpans } from '../../shared/markdownFontSpan'

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

/** Per-render scratch: which dialect features this platform had to drop.
 * The index signatures match markdown-it's Env parameter type. */
interface PublishEnv {
  dropped?: Set<string>
  [key: string]: unknown
  [key: symbol]: unknown
}

function note(env: PublishEnv | undefined, what: string): void {
  if (!env) return
  ;(env.dropped ??= new Set()).add(what)
}

function baseRenderer() {
  // Same dialect the editor writes: CommonMark + strikethrough + tables +
  // <u> underline pairs + Pandora styled blocks and font spans, raw HTML
  // otherwise treated as text.
  // xhtmlOut off: paste targets want HTML5-style tags (<hr>, <br>).
  const md = MarkdownIt('commonmark', { html: false, xhtmlOut: false })
    .enable(['strikethrough', 'table'])
    .use(underlineTags)
    .use(styledBlockFences)
    .use(fontSpans)

  // Font spans have no pasteable form on either platform: unwrap to text.
  md.renderer.rules['pandora_font_open'] = (_tokens, _idx, _opts, env: PublishEnv | undefined) => {
    note(env, 'text fonts')
    return ''
  }
  md.renderer.rules['pandora_font_close'] = () => ''

  // Clipboard paste can't carry an upload, so an image becomes a visible
  // placeholder telling the author exactly which file to attach by hand.
  md.renderer.rules['image'] = (tokens, idx, _opts, env: PublishEnv | undefined) => {
    const tok = tokens[idx]!
    const alt = tok.children?.[0]?.content || 'image'
    const src = tok.attrGet('src') ?? ''
    note(env, 'images (placeholders left in the text)')
    return md.utils.escapeHtml(`[Image: ${alt} — attach ${src} by hand]`)
  }
  return md
}

/**
 * Styled-block containers render by pushing what the platform can take onto
 * the contained paragraphs/headings and dropping the rest with a notice —
 * the same shape as the pm_table_cells token reshaping in the editor bridge.
 * RoyalRoad's editor keeps text-align on pasted <p>; nothing keeps
 * backgrounds or block fonts through a clipboard paste.
 */
function containerHandling(md: ReturnType<typeof baseRenderer>, keepAlign: boolean): void {
  md.core.ruler.push('pandora_containers', (state) => {
    const env = state.env as PublishEnv
    const out: typeof state.tokens = []
    let activeAlign: string | null = null
    for (const tok of state.tokens) {
      if (tok.type === 'styled_block_open') {
        const align = tok.attrGet('align')
        if (tok.attrGet('bg')) note(env, 'tinted backgrounds')
        if (tok.attrGet('font')) note(env, 'block fonts')
        if (align) {
          if (keepAlign) activeAlign = String(align)
          else note(env, 'text alignment')
        }
        continue
      }
      if (tok.type === 'styled_block_close') {
        activeAlign = null
        continue
      }
      if (activeAlign && (tok.type === 'paragraph_open' || tok.type === 'heading_open')) {
        tok.attrSet('style', `text-align: ${activeAlign}`)
      }
      out.push(tok)
    }
    state.tokens = out
  })
}

const royalroad = baseRenderer()
containerHandling(royalroad, true)

const patreon = baseRenderer()
containerHandling(patreon, false)
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

export interface RenderedChapter {
  html: string
  /** Dialect features this platform's paste can't carry, for the copy toast. */
  dropped: string[]
}

export function chapterHtmlWithReport(
  bodyMd: string,
  platform: PublishPlatform,
  chapterTitle?: string
): RenderedChapter {
  const body = chapterTitle ? stripLeadingTitle(bodyMd, chapterTitle) : bodyMd
  const env: PublishEnv = {}
  const html = renderers[platform].render(body, env).trim()
  return { html, dropped: [...(env.dropped ?? [])] }
}

export function chapterHtml(
  bodyMd: string,
  platform: PublishPlatform,
  chapterTitle?: string
): string {
  return chapterHtmlWithReport(bodyMd, platform, chapterTitle).html
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
