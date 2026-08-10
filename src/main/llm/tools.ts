import type { WebContents } from 'electron'
import type { LLMProvider, ToolDefinition } from '../../shared/llm/types'
import { runMetadataUpdate, runOutlineGeneration } from '../metadata/pipeline'
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
      name: 'update_codex',
      description:
        'Analyze the currently open chapter and propose updates to the Codex (character profiles, world/system rules, chapter summary, synopsis, glossary, timeline). The author reviews every suggestion before it is saved. Call this when the author asks to update the codex/story bible/metadata.',
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
  // The codex tool needs an open chapter to analyze.
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
        case 'update_codex': {
          if (!ctx.activeFile?.startsWith('chapters/')) {
            return 'Error: no chapter is open in the editor, so there is nothing to analyze.'
          }
          await flushAutocommit(ctx.novelDir)
          const result = await runMetadataUpdate({
            novelDir: ctx.novelDir,
            chapterFile: ctx.activeFile,
            provider: ctx.provider,
            modelId: ctx.modelId
          })
          notifyProposalsChanged(ctx.sender)
          if (result.status === 'ran') {
            return `Done: ${result.itemCount} Codex suggestion(s) are now waiting in the review queue (the badge in the toolbar). Nothing is saved until the author accepts them.`
          }
          if (result.status === 'skipped-unchanged') {
            return 'The chapter has not changed since the Codex was last updated, so no new suggestions were generated.'
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

export const TOOL_SYSTEM_NOTE = `\n\nYou have tools available: update_codex (propose Codex updates from the open chapter) and generate_outline (propose a chapter or novel outline). When the author asks you to update the codex, story bible, metadata, character sheets, or outlines, CALL THE TOOL — do not describe changes in chat or claim you made them without calling it. Tool results go to a review queue; tell the author to check the suggestions badge afterwards.`
