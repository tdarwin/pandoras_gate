import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parseFrontmatter } from '../../shared/frontmatter'
import { readNovelManifest, readChapter } from '../project/service'
import type { StorySource, CharacterSource } from './assembler'

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

const TIMELINE_TAIL_EVENTS = 10

/**
 * Loads everything the assembler needs from a novel directory. Missing or
 * malformed files degrade to empty sections — never errors.
 */
export async function gatherStorySource(
  novelDir: string,
  activeFile: string | null
): Promise<StorySource> {
  const manifest = await readNovelManifest(novelDir)

  /* characters */
  const characters: CharacterSource[] = []
  for (const file of await listMarkdown(join(novelDir, 'metadata/characters'))) {
    const raw = await safeRead(join(novelDir, 'metadata/characters', file))
    if (!raw) continue
    const { data, body } = parseFrontmatter(raw)
    const name = typeof data['name'] === 'string' ? data['name'] : basename(file, '.md')
    const aliases = Array.isArray(data['aliases']) ? data['aliases'].map(String) : []
    characters.push({ name, aliases, facts: stringifyYaml(data).trim(), body })
  }

  /* world docs */
  const worldDocs: { name: string; content: string }[] = []
  for (const file of await listMarkdown(join(novelDir, 'metadata/world'))) {
    const raw = await safeRead(join(novelDir, 'metadata/world', file))
    if (!raw) continue
    const { data, body } = parseFrontmatter(raw)
    const structured = Object.keys(data).length > 0 ? `${stringifyYaml(data).trim()}\n\n` : ''
    worldDocs.push({ name: basename(file, '.md'), content: structured + body.trim() })
  }

  /* synopsis */
  const synopsisRaw = await safeRead(join(novelDir, 'metadata/synopsis.md'))
  const synopsis = synopsisRaw ? parseFrontmatter(synopsisRaw).body.trim() || null : null

  /* glossary: frontmatter entries[] plus body fallback */
  const glossary: { term: string; definition: string }[] = []
  const glossaryRaw = await safeRead(join(novelDir, 'metadata/glossary.md'))
  if (glossaryRaw) {
    const { data } = parseFrontmatter(glossaryRaw)
    if (Array.isArray(data['entries'])) {
      for (const raw of data['entries']) {
        const e = raw as Record<string, unknown> | null
        if (e && typeof e === 'object' && e['term'] !== undefined && e['definition'] !== undefined) {
          glossary.push({ term: String(e['term']), definition: String(e['definition']) })
        }
      }
    }
  }

  /* summaries in manifest order */
  const summaries: StorySource['summaries'] = []
  for (const ch of manifest.chapters) {
    const name = basename(ch.file)
    const raw = await safeRead(join(novelDir, 'metadata/summaries', name))
    if (!raw) {
      summaries.push({ title: ch.title, logline: '(no summary yet)', content: '' })
      continue
    }
    const { data, body } = parseFrontmatter(raw)
    summaries.push({
      title: ch.title,
      logline: typeof data['logline'] === 'string' && data['logline'] ? data['logline'] : body.trim().slice(0, 160),
      content: body.trim()
    })
  }

  /* timeline tail */
  let timelineTail: string | null = null
  const timelineRaw = await safeRead(join(novelDir, 'metadata/timeline.yaml'))
  if (timelineRaw) {
    try {
      const events = parseYaml(timelineRaw)
      if (Array.isArray(events) && events.length > 0) {
        timelineTail = stringifyYaml(events.slice(-TIMELINE_TAIL_EVENTS)).trim()
      }
    } catch {
      timelineTail = null
    }
  }

  /* active chapter */
  let activeChapter: StorySource['activeChapter'] = null
  let activeChapterIndex = -1
  if (activeFile) {
    activeChapterIndex = manifest.chapters.findIndex((c) => c.file === activeFile)
    const entry = manifest.chapters[activeChapterIndex]
    if (entry) {
      try {
        const raw = await readChapter(novelDir, activeFile)
        activeChapter = { title: entry.title, text: parseFrontmatter(raw).body }
      } catch {
        activeChapter = null
      }
    }
  }

  return {
    novelTitle: manifest.title,
    author: manifest.author,
    synopsis,
    worldDocs,
    characters,
    glossary,
    summaries,
    timelineTail,
    activeChapter,
    activeChapterIndex
  }
}
