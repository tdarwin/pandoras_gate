import type { WebContents } from 'electron'
import { basename } from 'node:path'
import { parseFrontmatter } from '../../shared/frontmatter'
import { readChapter, readNovelManifest, setChapterStatus } from '../project/service'
import type { NovelState } from '../../shared/schemas/project'
import { commitAll, flushAutocommit } from '../git/service'
import { assembleContext } from '../context/assembler'
import { gatherStorySource } from '../context/gather'
import { startChat } from '../llm/chat'

/**
 * AI chapter drafting: snapshot the chapter, mark it ai-draft, and stream
 * prose from the model. The renderer feeds deltas into the editor buffer
 * (the editor stays the source of truth); a pre-draft commit makes the whole
 * draft one revertible step.
 */

export interface DraftStartRequest {
  requestId: string
  novelDir: string
  chapterFile: string
  providerId: string
  modelId: string
  contextTokens: number
  instructions?: string
}

export async function startDraft(
  sender: WebContents,
  req: DraftStartRequest
): Promise<{ novel: NovelState; content: string }> {
  const { novelDir, chapterFile } = req
  const manifest = await readNovelManifest(novelDir)
  const entry = manifest.chapters.find((c) => c.file === chapterFile)
  if (!entry) throw new Error(`Chapter not in manifest: ${chapterFile}`)

  // Revert point: everything before the draft, as one commit.
  await flushAutocommit(novelDir)
  await commitAll(novelDir, `pre-draft snapshot: ${entry.title}`, [chapterFile])

  const novel = await setChapterStatus(novelDir, chapterFile, 'ai-draft')

  const chapterRaw = await readChapter(novelDir, chapterFile)
  const body = parseFrontmatter(chapterRaw).body

  const source = await gatherStorySource(novelDir, chapterFile)
  const hasText = body.trim().length > 0
  const userMessage = [
    hasText
      ? 'Continue this chapter from exactly where the existing text leaves off. Do not repeat or rewrite what is already written.'
      : 'Write the first draft of this chapter from the beginning.',
    req.instructions?.trim() ? `Author's direction: ${req.instructions.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const { messages } = assembleContext({
    source,
    chatHistory: [],
    userMessage,
    contextTokens: req.contextTokens,
    reservedOutput: 4096,
    task: 'draft'
  })

  startChat(sender, req.requestId, req.providerId, {
    modelId: req.modelId,
    messages,
    temperature: 0.8,
    maxTokens: 4096
  })

  return { novel, content: chapterRaw }
}

export async function finishDraft(novelDir: string, chapterFile: string): Promise<void> {
  await flushAutocommit(novelDir)
  const manifest = await readNovelManifest(novelDir).catch(() => null)
  const title = manifest?.chapters.find((c) => c.file === chapterFile)?.title ?? basename(chapterFile)
  await commitAll(novelDir, `ai draft: ${title}`, [chapterFile, 'novel.yaml'])
}
