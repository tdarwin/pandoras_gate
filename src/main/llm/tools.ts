import type { WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMProvider, ToolDefinition } from '../../shared/llm/types'
import type { DeferredRun } from './chat'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  runChapterEdit,
  enqueueProposalItems,
  isAllowedProposalPath
} from '../metadata/pipeline'
import { listMetadata, createChapter, readNovelManifest } from '../project/service'
import { parseFrontmatter } from '../../shared/frontmatter'
import { flushAutocommit, commitAll } from '../git/service'
import { logInfo, logError } from '../log'
import { withSpan } from '../telemetry'
import { SpanStatusCode } from '@opentelemetry/api'

/**
 * Tools the chat agent can call. Every tool that changes the story funnels
 * through the proposal queue — the agent can propose, only the author applies.
 */

export interface ToolContext {
  novelDir: string
  activeFile: string | null
  /** Provider/model the chat is running on — tool runs reuse them. */
  provider: LLMProvider
  modelId: string
  sender: WebContents
  /** gen_ai.conversation.id shared by every span of this session. */
  conversationId?: string
  /**
   * Queues a generation to run after the chat reply finishes. Tools that need
   * their own model call must NOT run it inline: on local models a nested
   * stream competes with the chat's still-allocated context for memory.
   */
  defer: (job: DeferredRun) => void
}

export function chatToolDefinitions(ctx: Pick<ToolContext, 'activeFile'>): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'write_codex_doc',
      description:
        'Create or rewrite ONE specific Codex document with content you author. Use this when the author asks for a particular document — a character profile, a world/system doc, the synopsis, glossary, timeline, or an outline. Provide the COMPLETE new file content (markdown with YAML frontmatter per the Codex conventions; timeline.yaml is pure YAML). The author reviews the suggestion before it is saved. Allowed paths: metadata/characters/<slug>.md, metadata/world/<slug>.md, metadata/synopsis.md, metadata/glossary.md, metadata/summaries/<chapter-file-name>, metadata/timeline.yaml, outlines/novel.md, outlines/<chapter-file-name>.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['path', 'content', 'rationale'],
        additionalProperties: false
      }
    },
    {
      name: 'list_codex_docs',
      description:
        'List every existing Codex document with its path. Call this before writing or reading docs so you reuse existing paths instead of inventing duplicates.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'read_codex_doc',
      description:
        'Read the current full content of one Codex document by path (metadata/... or outlines/...). Use before updating a doc you have not seen in full.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    },
    {
      name: 'update_codex',
      description:
        'Run a full analysis of the currently open chapter and propose updates across the whole Codex (profiles, world rules, summary, synopsis, glossary, timeline) in one sweep. Use for broad "update the codex from this chapter" requests; for one specific document, use write_codex_doc instead.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'list_chapters',
      description:
        'List the novel\'s chapters in order with their file paths, statuses, and which one is open in the editor.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'create_chapter',
      description:
        'Create a new, empty chapter at the end of the novel with the given title. It appears in the sidebar immediately. Use draft_chapter afterwards if the author wants prose written into it.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false
      }
    },
    {
      name: 'draft_chapter',
      description:
        'Start an AI prose draft that streams directly into a chapter in the editor (with an automatic pre-draft snapshot). Use for writing NEW prose or continuing a chapter; to revise existing text use edit_chapter. The draft begins right after your reply finishes, so keep the reply brief. chapterFile defaults to the open chapter; instructions carry the author\'s direction (beats, tone, POV).',
      parameters: {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
          chapterFile: { type: 'string' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'edit_chapter',
      description:
        'Rewrite the ENTIRE currently open chapter according to the author\'s instructions. Use only for sweeping revisions that touch most of the chapter (POV change, full-tone pass). For changes to a specific scene, paragraph, or line, use edit_chapter_section instead — it is faster and cannot drift in untouched text. Produces a complete revision the author reviews as a word-level diff.',
      parameters: {
        type: 'object',
        properties: { instructions: { type: 'string' } },
        required: ['instructions'],
        additionalProperties: false
      }
    },
    {
      name: 'find_in_chapter',
      description:
        'Search a chapter\'s text for a word or phrase and get back the matching paragraphs with surrounding context and exact wording. Use this to locate a passage the author described ("the scene where Kael meets the elder" → search a distinctive word like "elder"), and to fetch exact text before edit_chapter_section — especially when the chapter was shown to you with its middle elided. chapterFile defaults to the open chapter.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          chapterFile: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: 'edit_chapter_section',
      description:
        'Replace ONE specific passage in a chapter. "find" must be the EXACT text currently in the chapter (copy it verbatim — use find_in_chapter if unsure) and must match exactly one place; include a sentence of surrounding text if the passage could appear twice. "replacement" is your revised text for exactly that span (empty string deletes it — that is how you cut a section when moving it). chapterFile defaults to the open chapter. The author reviews the change as a small diff before anything is saved. Preferred over edit_chapter for all targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string' },
          replacement: { type: 'string' },
          chapterFile: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['find', 'replacement'],
        additionalProperties: false
      }
    },
    {
      name: 'append_to_chapter',
      description:
        'Append content to the END of a chapter (works on empty chapters). Use together with edit_chapter_section to MOVE a passage between chapters: first edit_chapter_section on the source with an empty replacement (cut), then append_to_chapter on the destination with the same text (paste). Both changes go to the review queue. Do NOT create a new chapter for this — use an existing one from list_chapters.',
      parameters: {
        type: 'object',
        properties: {
          chapterFile: { type: 'string' },
          content: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['chapterFile', 'content'],
        additionalProperties: false
      }
    },
    {
      name: 'generate_outline',
      description:
        'Generate or refine an outline as a reviewable suggestion. Use scope "chapter" for the currently open chapter, or "novel" for the whole-novel outline. Optional guidance carries the author\'s direction.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['novel', 'chapter'] },
          guidance: { type: 'string' }
        },
        required: ['scope'],
        additionalProperties: false
      }
    }
  ]
  // Tools that operate on "the open chapter" need one to be open.
  const needsOpenChapter = new Set(['update_codex', 'edit_chapter'])
  return ctx.activeFile?.startsWith('chapters/')
    ? tools
    : tools.filter((t) => !needsOpenChapter.has(t.name))
}

/**
 * Estimated prompt cost of enabling tools: the system note plus the tool
 * JSON schemas the provider sends on the wire. Lets the context assembler
 * budget for it and the inspector report it.
 */
export function toolOverheadTokens(
  activeFile: string | null,
  count: (text: string) => number
): number {
  return count(TOOL_SYSTEM_NOTE) + count(JSON.stringify(chatToolDefinitions({ activeFile })))
}

/** Tells the renderer new proposals may exist (badge + list refresh). */
function notifyProposalsChanged(sender: WebContents): void {
  if (!sender.isDestroyed()) sender.send('proposals:changed', {})
}

function send(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  argsJson: string
): Promise<string> {
  logInfo('tools', `executing ${name}`, argsJson)
  return withSpan(
    `execute_tool ${name}`,
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': name,
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.arguments': argsJson,
      'gen_ai.request.model': ctx.modelId,
      ...(ctx.conversationId ? { 'gen_ai.conversation.id': ctx.conversationId } : {})
    },
    async (span) => {
      const result = await executeToolInner(ctx, name, argsJson)
      span.setAttribute('gen_ai.tool.call.result', result.slice(0, 4000))
      if (result.startsWith('Error') || result.startsWith('Nothing queued')) {
        // Tool-level failures return strings (so the model can react), but
        // observability needs them as real errors with the message attached.
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.slice(0, 500) })
        span.setAttribute('error.type', 'tool_error')
        span.setAttribute('error.message', result.slice(0, 4000))
        logError('tools', `${name} returned an error result`, result.slice(0, 500))
      }
      return result
    }
  )
}

async function executeToolInner(ctx: ToolContext, name: string, argsJson: string): Promise<string> {
  {
    try {
      switch (name) {
        case 'write_codex_doc': {
          let args: { path?: string; content?: string; rationale?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.path || !args.content) {
            return 'Error: both "path" and "content" are required.'
          }
          const { queued, rejected } = await enqueueProposalItems(ctx.novelDir, 'Chat suggestion', [
            {
              path: args.path,
              newContent: args.content,
              rationale: args.rationale ?? 'Written in chat at the author’s request'
            }
          ])
          notifyProposalsChanged(ctx.sender)
          if (queued > 0) {
            return `Done: the suggested document for ${args.path} is in the review queue (the suggestions badge in the toolbar). Nothing is saved until the author accepts it.`
          }
          return `Nothing queued — ${rejected.join('; ')}`
        }
        case 'list_codex_docs': {
          const listing = await listMetadata(ctx.novelDir)
          const lines = [
            ...(listing.hasSynopsis ? ['metadata/synopsis.md'] : []),
            ...(listing.hasGlossary ? ['metadata/glossary.md'] : []),
            ...(listing.hasTimeline ? ['metadata/timeline.yaml'] : []),
            ...listing.characters.map((c) => `${c.file} (character: ${c.name})`),
            ...listing.world.map((w) => `${w.file} (world/system: ${w.name})`),
            ...listing.summaries.map((s) => `${s.file} (summary: ${s.title})`),
            ...listing.outlines.map((o) => `${o.file} (${o.title})`)
          ]
          return lines.length > 0 ? lines.join('\n') : 'The Codex is empty so far.'
        }
        case 'read_codex_doc': {
          let args: { path?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.path || !isAllowedProposalPath(args.path)) {
            return 'Error: path must be an existing Codex document (metadata/... or outlines/...).'
          }
          try {
            return await readFile(join(ctx.novelDir, args.path), 'utf8')
          } catch {
            return `Error: ${args.path} does not exist. Use list_codex_docs to see what does.`
          }
        }
        case 'update_codex': {
          if (!ctx.activeFile?.startsWith('chapters/')) {
            return 'Error: no chapter is open in the editor, so there is nothing to analyze.'
          }
          // Pin the target now — the author may navigate before the run fires.
          const chapterFile = ctx.activeFile
          ctx.defer({
            label: 'Updating the Codex…',
            run: async (onStatus) => {
              await flushAutocommit(ctx.novelDir)
              const result = await runMetadataUpdate({
                novelDir: ctx.novelDir,
                chapterFile,
                provider: ctx.provider,
                modelId: ctx.modelId,
                // An explicit request always runs, even if the chapter is unchanged.
                force: true,
                onStatus,
                ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {})
              })
              return result.status === 'ran'
                ? `${result.itemCount} suggestion${result.itemCount === 1 ? '' : 's'}`
                : 'Codex already up to date'
            }
          })
          return 'Queued: the Codex analysis will run as soon as this reply finishes; its suggestions will appear in the review queue (the badge in the toolbar). Keep your reply to one short sentence.'
        }
        case 'list_chapters': {
          const manifest = await readNovelManifest(ctx.novelDir)
          if (manifest.chapters.length === 0) return 'The novel has no chapters yet.'
          return manifest.chapters
            .map(
              (c, i) =>
                `${i + 1}. ${c.title} (${c.file}, status: ${c.status}${
                  c.file === ctx.activeFile ? ', OPEN IN EDITOR' : ''
                })`
            )
            .join('\n')
        }
        case 'create_chapter': {
          let args: { title?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.title?.trim()) return 'Error: "title" is required.'
          const existingManifest = await readNovelManifest(ctx.novelDir)
          const duplicate = existingManifest.chapters.find(
            (c) => c.title.trim().toLowerCase() === args.title!.trim().toLowerCase()
          )
          if (duplicate) {
            return `Error: a chapter titled "${duplicate.title}" already exists (${duplicate.file}). Use that chapter — do NOT create another one.`
          }
          const state = await createChapter(ctx.novelDir, args.title.trim())
          await commitAll(ctx.novelDir, `chapter created: ${args.title.trim()}`, ['novel.yaml'])
          send(ctx.sender, 'novel:updated', state)
          const created = state.manifest.chapters.at(-1)
          return `Created chapter ${state.manifest.chapters.length}: "${args.title.trim()}" (${created?.file}). It is empty — use draft_chapter if the author wants prose written into it.`
        }
        case 'draft_chapter': {
          let args: { instructions?: string; chapterFile?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          const manifest = await readNovelManifest(ctx.novelDir)
          const target = args.chapterFile ?? ctx.activeFile ?? undefined
          if (!target || !manifest.chapters.some((c) => c.file === target)) {
            return 'Error: no valid target chapter — pass chapterFile from list_chapters or have the author open a chapter.'
          }
          send(ctx.sender, 'draft:requested', {
            chapterFile: target,
            instructions: args.instructions ?? ''
          })
          return `The AI draft for ${target} will start streaming into the editor as soon as this reply finishes (a pre-draft snapshot is taken automatically). Keep your reply to one short sentence.`
        }
        case 'find_in_chapter': {
          let args: { query?: string; chapterFile?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.query?.trim()) return 'Error: "query" is required.'
          const manifest = await readNovelManifest(ctx.novelDir)
          const target = args.chapterFile ?? ctx.activeFile ?? undefined
          if (!target || !manifest.chapters.some((c) => c.file === target)) {
            return 'Error: no valid chapter — pass chapterFile from list_chapters or have the author open one.'
          }
          const raw = await readFile(join(ctx.novelDir, target), 'utf8')
          const body = parseFrontmatter(raw).body
          const paragraphs = body.split(/\n\s*\n/)
          const needle = args.query.trim().toLowerCase()
          const hits: string[] = []
          for (let i = 0; i < paragraphs.length && hits.length < 3; i++) {
            if (paragraphs[i]!.toLowerCase().includes(needle)) {
              const context = paragraphs
                .slice(Math.max(0, i - 1), i + 2)
                .join('\n\n')
                .slice(0, 2000)
              hits.push(`--- match ${hits.length + 1} (paragraph ${i + 1} of ${paragraphs.length}) ---\n${context}`)
            }
          }
          if (hits.length === 0) {
            return `No matches for "${args.query}" in ${target}. Try a shorter or different word.`
          }
          return `${hits.length} match(es) in ${target}. Quote text EXACTLY as shown when using edit_chapter_section.\n\n${hits.join('\n\n')}`
        }
        case 'edit_chapter_section': {
          let args: { find?: string; replacement?: string; chapterFile?: string; rationale?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.find || args.replacement === undefined) {
            return 'Error: both "find" and "replacement" are required.'
          }
          const manifest = await readNovelManifest(ctx.novelDir)
          const target = args.chapterFile ?? ctx.activeFile ?? undefined
          if (!target || !manifest.chapters.some((c) => c.file === target)) {
            return 'Error: no valid chapter — pass chapterFile from list_chapters or have the author open one.'
          }
          await flushAutocommit(ctx.novelDir)
          const raw = await readFile(join(ctx.novelDir, target), 'utf8')
          const body = parseFrontmatter(raw).body
          const frontmatterPrefix = raw.slice(0, raw.length - body.length)

          const occurrences = body.split(args.find).length - 1
          if (occurrences === 0) {
            return 'Error: that exact text was not found in the chapter. Use find_in_chapter and copy the passage verbatim — whitespace and punctuation must match exactly.'
          }
          if (occurrences > 1) {
            return `Error: that text appears ${occurrences} times. Include more surrounding sentences in "find" so it matches exactly one place.`
          }
          if (args.find === args.replacement) {
            return 'Error: the replacement is identical to the original text.'
          }

          const title = manifest.chapters.find((c) => c.file === target)?.title ?? target
          const newContent = frontmatterPrefix + body.replace(args.find, args.replacement)
          const { queued, rejected } = await enqueueProposalItems(
            ctx.novelDir,
            `Chapter edit: ${title}`,
            [
              {
                path: target,
                newContent,
                rationale: args.rationale ?? 'Targeted section edit from chat',
                // The exact content the splice was computed against — accepts
                // rebase onto whatever the file says by then.
                base: raw
              }
            ],
            (p) => p === target
          )
          notifyProposalsChanged(ctx.sender)
          if (queued > 0) {
            return 'Done: the section edit is in the review queue as a small diff (the suggestions badge). The chapter is untouched until the author accepts it.'
          }
          return `Nothing queued — ${rejected.join('; ')}`
        }
        case 'append_to_chapter': {
          let args: { chapterFile?: string; content?: string; rationale?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.chapterFile || !args.content?.trim()) {
            return 'Error: both "chapterFile" and "content" are required.'
          }
          const manifest = await readNovelManifest(ctx.novelDir)
          const entry = manifest.chapters.find((c) => c.file === args.chapterFile)
          if (!entry) {
            return 'Error: that chapter does not exist — check list_chapters. Do NOT create a new chapter unless the author asked for one.'
          }
          await flushAutocommit(ctx.novelDir)
          const raw = await readFile(join(ctx.novelDir, args.chapterFile), 'utf8')
          const body = parseFrontmatter(raw).body
          const frontmatterPrefix = raw.slice(0, raw.length - body.length)
          const joined = body.trim()
            ? `${body.replace(/\s+$/, '')}\n\n${args.content.trim()}\n`
            : `\n${args.content.trim()}\n`
          const { queued, rejected } = await enqueueProposalItems(
            ctx.novelDir,
            `Chapter edit: ${entry.title}`,
            [
              {
                path: args.chapterFile,
                newContent: frontmatterPrefix + joined,
                rationale: args.rationale ?? 'Content appended from chat',
                base: raw
              }
            ],
            (p) => p === args.chapterFile
          )
          notifyProposalsChanged(ctx.sender)
          if (queued > 0) {
            return `Done: the addition to "${entry.title}" is in the review queue. The chapter is untouched until the author accepts it.`
          }
          return `Nothing queued — ${rejected.join('; ')}`
        }
        case 'edit_chapter': {
          let args: { instructions?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          if (!args.instructions?.trim()) return 'Error: "instructions" is required.'
          if (!ctx.activeFile?.startsWith('chapters/')) {
            return 'Error: no chapter is open in the editor.'
          }
          const chapterFile = ctx.activeFile
          const instructions = args.instructions
          ctx.defer({
            label: 'Revising the chapter…',
            run: async (onStatus) => {
              await flushAutocommit(ctx.novelDir)
              const result = await runChapterEdit({
                novelDir: ctx.novelDir,
                chapterFile,
                instructions,
                provider: ctx.provider,
                modelId: ctx.modelId,
                onStatus,
                ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {})
              })
              return result.status === 'ran'
                ? 'Chapter revision ready for review'
                : 'The revision matched the current chapter'
            }
          })
          return 'Queued: the chapter revision will be generated as soon as this reply finishes and will appear in the review queue as a word-level diff. The chapter file is untouched until the author accepts it. Keep your reply to one short sentence.'
        }
        case 'generate_outline': {
          let args: { scope?: string; guidance?: string } = {}
          try {
            args = JSON.parse(argsJson || '{}')
          } catch {
            return 'Error: could not parse the tool arguments.'
          }
          const scope = args.scope === 'chapter' ? 'chapter' : 'novel'
          if (scope === 'chapter' && !ctx.activeFile?.startsWith('chapters/')) {
            return 'Error: no chapter is open in the editor; open a chapter or use scope "novel".'
          }
          const chapterFile = ctx.activeFile
          const guidance = args.guidance
          ctx.defer({
            label: 'Generating an outline…',
            run: async (onStatus) => {
              await flushAutocommit(ctx.novelDir)
              const result = await runOutlineGeneration({
                novelDir: ctx.novelDir,
                scope,
                ...(scope === 'chapter' ? { chapterFile: chapterFile! } : {}),
                ...(guidance ? { guidance } : {}),
                provider: ctx.provider,
                modelId: ctx.modelId,
                onStatus,
                ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {})
              })
              return result.status === 'ran'
                ? 'Outline ready for review'
                : 'No outline changes suggested'
            }
          })
          return `Queued: the ${scope} outline will be generated as soon as this reply finishes and will appear in the review queue for the author to accept, edit, or reject. Keep your reply to one short sentence.`
        }
        default:
          return `Error: unknown tool "${name}".`
      }
    } catch (err) {
      logError('tools', `${name} failed`, err)
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export const TOOL_SYSTEM_NOTE = `

You have tools that act on the novel's Codex — its canon reference. When the author asks you to create, update, or fix Codex documents, character sheets, world/system docs, outlines, the synopsis, glossary, or timeline — CALL A TOOL. Never describe changes in chat as if you made them; without a tool call, nothing happens.

Choosing a tool:
- One specific document (e.g. "create a profile for Mira", "write up the magic system we just discussed"): call list_codex_docs first to check what exists (and read_codex_doc if updating), then write_codex_doc with the COMPLETE new file content.
- A broad sweep from the open chapter ("update the codex from this chapter"): update_codex. The analysis runs right after your reply finishes — keep the reply to one short sentence and do not claim results.
- Outlines: generate_outline (runs right after your reply — keep it short), or write_codex_doc when the author dictated the outline content in chat.

You also have chapter tools:
- list_chapters: the novel's structure (paths, statuses, which chapter is open).
- create_chapter(title): adds a new empty chapter to the end of the novel.
- draft_chapter(instructions, chapterFile?): streams NEW prose into a chapter in the editor. Use for "write/draft/continue the chapter". Synthesize instructions from the conversation. Keep your reply short — the draft starts when it ends.
- edit_chapter_section(find, replacement, chapterFile?): THE DEFAULT for revisions. Replace one exact passage — quote "find" verbatim from the chapter (find_in_chapter fetches exact text), author the replacement yourself from the conversation. Small reviewable diff; repeat for multiple spots.
- append_to_chapter(chapterFile, content): add content to the end of an existing chapter (fine on empty ones).
- To MOVE a passage between chapters: find_in_chapter to get the exact text → edit_chapter_section on the source with replacement "" (cut) → append_to_chapter on the destination with that text (paste). Two review items; NEVER create a new chapter for a move.
- find_in_chapter(query, chapterFile?): locate passages and get their exact wording with context.
- edit_chapter(instructions): full-chapter rewrite via a separate generation that runs right after your reply finishes. Only for sweeping revisions (POV/tense/whole-tone changes) where section edits are impractical. Keep the reply short and do not claim the revision is done.

Discipline: call each tool at most once per distinct purpose, verify with list_chapters/list_codex_docs BEFORE creating anything, and never create a chapter or document that already exists. When a tool returns an Error, fix your arguments and retry once — do not switch to creating new things. After your tools succeed, STOP and reply to the author.

Do not stall. When the author asks you to rewrite, revise, or edit a chapter, the conversation almost always already contains enough direction — synthesize it into instructions and CALL edit_chapter or edit_chapter_section NOW. Never respond with only "how would you like me to edit it?" — at most, act on your best understanding and mention what you assumed. A request to edit the chapter is NOT a Codex request: do not substitute update_codex or write_codex_doc for a chapter edit.

Codex file conventions for write_codex_doc:
- metadata/characters/<slug>.md — frontmatter: name, aliases (list), logline (ONE sentence identifying the character — always include it; it powers the codex index), role, status, first_appearance, attributes (map; stats/level/realm for LitRPG), relationships (list of {character, type}). Body: ## Appearance / ## Personality / ## Arc notes prose.
- metadata/world/<slug>.md — frontmatter: logline (ONE sentence saying what this doc covers — always include it), system (free-form map for structured rules: tiers, requirements, stat tables). Body: prose explanation.
- metadata/synopsis.md — frontmatter: logline, themes (list), status. Body: running whole-novel synopsis.
- metadata/glossary.md — frontmatter: entries (list of {term, definition}).
- metadata/summaries/<chapter-file-name> — frontmatter: title, logline. Body: 3-8 sentence chapter summary.
- metadata/timeline.yaml — pure YAML list of {id, when, chapter, summary, characters}.
- outlines/novel.md and outlines/<chapter-file-name> — frontmatter: scope (novel|chapter), status. Body: markdown outline.

Every tool result goes to a review queue — the author accepts, edits, or rejects each suggestion. After a successful call, tell the author to check the suggestions badge.`
