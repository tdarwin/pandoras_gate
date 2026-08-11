import type { WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMProvider, ToolDefinition } from '../../shared/llm/types'
import {
  runMetadataUpdate,
  runOutlineGeneration,
  enqueueProposalItems,
  isAllowedProposalPath
} from '../metadata/pipeline'
import { listMetadata } from '../project/service'
import { flushAutocommit } from '../git/service'
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
  // The full-sweep tool needs an open chapter to analyze.
  return ctx.activeFile?.startsWith('chapters/')
    ? tools
    : tools.filter((t) => t.name !== 'update_codex')
}

/** Tells the renderer new proposals may exist (badge + list refresh). */
function notifyProposalsChanged(sender: WebContents): void {
  if (!sender.isDestroyed()) sender.send('proposals:changed', {})
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

Codex file conventions for write_codex_doc:
- metadata/characters/<slug>.md — frontmatter: name, aliases (list), role, status, first_appearance, attributes (map; stats/level/realm for LitRPG), relationships (list of {character, type}). Body: ## Appearance / ## Personality / ## Arc notes prose.
- metadata/world/<slug>.md — frontmatter: system (free-form map for structured rules: tiers, requirements, stat tables). Body: prose explanation.
- metadata/synopsis.md — frontmatter: logline, themes (list), status. Body: running whole-novel synopsis.
- metadata/glossary.md — frontmatter: entries (list of {term, definition}).
- metadata/summaries/<chapter-file-name> — frontmatter: title, logline. Body: 3-8 sentence chapter summary.
- metadata/timeline.yaml — pure YAML list of {id, when, chapter, summary, characters}.
- outlines/novel.md and outlines/<chapter-file-name> — frontmatter: scope (novel|chapter), status. Body: markdown outline.

Every tool result goes to a review queue — the author accepts, edits, or rejects each suggestion. After a successful call, tell the author to check the suggestions badge.`
