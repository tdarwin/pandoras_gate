import type { WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMProvider, ToolDefinition } from '../../shared/llm/types'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  runChapterEdit,
  enqueueProposalItems,
  isAllowedProposalPath
} from '../metadata/pipeline'
import { listMetadata, createChapter, readNovelManifest } from '../project/service'
import { flushAutocommit, commitAll } from '../git/service'
import { logInfo, logError } from '../log'
import { withSpan } from '../telemetry'

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
}

export function chatToolDefinitions(ctx: ToolContext): ToolDefinition[] {
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
        'Revise the currently open chapter according to the author\'s instructions ("make the fight happen at night", "tighten the dialogue in the opening"). Produces a complete revision the author reviews as a word-level diff — the chapter file is untouched until they accept. Synthesize the instructions from the conversation so they are specific and self-contained.',
      parameters: {
        type: 'object',
        properties: { instructions: { type: 'string' } },
        required: ['instructions'],
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
  return withSpan(`tool ${name}`, { 'tool.name': name, 'llm.model': ctx.modelId }, async () => {
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
          await flushAutocommit(ctx.novelDir)
          const result = await runMetadataUpdate({
            novelDir: ctx.novelDir,
            chapterFile: ctx.activeFile,
            provider: ctx.provider,
            modelId: ctx.modelId,
            // An explicit request always runs, even if the chapter is unchanged.
            force: true
          })
          notifyProposalsChanged(ctx.sender)
          if (result.status === 'ran') {
            return `Done: ${result.itemCount} Codex suggestion(s) are now waiting in the review queue (the badge in the toolbar). Nothing is saved until the author accepts them.`
          }
          return 'The chapter was analyzed but produced no Codex changes worth suggesting.'
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
          await flushAutocommit(ctx.novelDir)
          const result = await runChapterEdit({
            novelDir: ctx.novelDir,
            chapterFile: ctx.activeFile,
            instructions: args.instructions,
            provider: ctx.provider,
            modelId: ctx.modelId
          })
          notifyProposalsChanged(ctx.sender)
          if (result.status === 'ran') {
            return 'Done: the revised chapter is in the review queue as a word-level diff (the suggestions badge). The chapter file is untouched until the author accepts it.'
          }
          return 'The revision came back identical to the current chapter — nothing to suggest.'
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
          await flushAutocommit(ctx.novelDir)
          const result = await runOutlineGeneration({
            novelDir: ctx.novelDir,
            scope,
            ...(scope === 'chapter' ? { chapterFile: ctx.activeFile! } : {}),
            ...(args.guidance ? { guidance: args.guidance } : {}),
            provider: ctx.provider,
            modelId: ctx.modelId
          })
          notifyProposalsChanged(ctx.sender)
          if (result.status === 'ran') {
            return `Done: the ${scope} outline suggestion is in the review queue for the author to accept, edit, or reject.`
          }
          return 'The outline was generated but matches what already exists — nothing new to suggest.'
        }
        default:
          return `Error: unknown tool "${name}".`
      }
    } catch (err) {
      logError('tools', `${name} failed`, err)
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  })
}

export const TOOL_SYSTEM_NOTE = `

You have tools that act on the novel's Codex (its story bible). When the author asks you to create, update, or fix Codex documents, character sheets, world/system docs, outlines, the synopsis, glossary, or timeline — CALL A TOOL. Never describe changes in chat as if you made them; without a tool call, nothing happens.

Choosing a tool:
- One specific document (e.g. "create a profile for Mira", "write up the magic system we just discussed"): call list_codex_docs first to check what exists (and read_codex_doc if updating), then write_codex_doc with the COMPLETE new file content.
- A broad sweep from the open chapter ("update the codex from this chapter"): update_codex.
- Outlines: generate_outline, or write_codex_doc when the author dictated the outline content in chat.

You also have chapter tools:
- list_chapters: the novel's structure (paths, statuses, which chapter is open).
- create_chapter(title): adds a new empty chapter to the end of the novel.
- draft_chapter(instructions, chapterFile?): streams NEW prose into a chapter in the editor. Use for "write/draft/continue the chapter". Synthesize instructions from the conversation. Keep your reply short — the draft starts when it ends.
- edit_chapter(instructions): revises the OPEN chapter's existing text per the author's instructions; delivered as a reviewable word-diff, nothing changes until accepted. Use for "change/revise/tighten/fix the chapter". Make the instructions specific and self-contained (include names, scenes, and the outcome the author wants).

Codex file conventions for write_codex_doc:
- metadata/characters/<slug>.md — frontmatter: name, aliases (list), role, status, first_appearance, attributes (map; stats/level/realm for LitRPG), relationships (list of {character, type}). Body: ## Appearance / ## Personality / ## Arc notes prose.
- metadata/world/<slug>.md — frontmatter: system (free-form map for structured rules: tiers, requirements, stat tables). Body: prose explanation.
- metadata/synopsis.md — frontmatter: logline, themes (list), status. Body: running whole-novel synopsis.
- metadata/glossary.md — frontmatter: entries (list of {term, definition}).
- metadata/summaries/<chapter-file-name> — frontmatter: title, logline. Body: 3-8 sentence chapter summary.
- metadata/timeline.yaml — pure YAML list of {id, when, chapter, summary, characters}.
- outlines/novel.md and outlines/<chapter-file-name> — frontmatter: scope (novel|chapter), status. Body: markdown outline.

Every tool result goes to a review queue — the author accepts, edits, or rejects each suggestion. After a successful call, tell the author to check the suggestions badge.`
