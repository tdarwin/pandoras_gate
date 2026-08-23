import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  NovelManifest,
  SeriesManifest,
  ChapterEntry,
  type NovelState,
  PANDORA_FORMAT_VERSION
} from '../../shared/schemas/project'
import { parseFrontmatter, serializeFrontmatter } from '../../shared/frontmatter'
import { slugify, chapterPrefix } from '../../shared/slug'
import { resolveInside } from '../paths'

const NOVEL_MANIFEST = 'novel.yaml'
const SERIES_MANIFEST = 'series.yaml'

const NOVEL_SUBDIRS = [
  'chapters',
  'metadata',
  'metadata/summaries',
  'metadata/characters',
  'metadata/world',
  'outlines',
  '.pandora'
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readNovelManifest(novelDir: string): Promise<NovelManifest> {
  const raw = await readFile(join(novelDir, NOVEL_MANIFEST), 'utf8')
  return NovelManifest.parse(parseYaml(raw))
}

export async function writeNovelManifest(novelDir: string, manifest: NovelManifest): Promise<void> {
  await writeFile(join(novelDir, NOVEL_MANIFEST), stringifyYaml(manifest), 'utf8')
}

export async function readSeriesManifest(seriesDir: string): Promise<SeriesManifest> {
  const raw = await readFile(join(seriesDir, SERIES_MANIFEST), 'utf8')
  return SeriesManifest.parse(parseYaml(raw))
}

export interface CreateNovelParams {
  /** Directory the novel dir will be created inside (or the series dir). */
  parentDir: string
  title: string
  author: string
  /** When set, the parent is treated as / turned into a series. */
  seriesTitle?: string
}

/**
 * Creates the on-disk skeleton for a novel (and optionally its series wrapper):
 * manifest, chapter/metadata subdirectories, and .pandora private state.
 */
export async function createNovel(params: CreateNovelParams): Promise<NovelState> {
  let parentDir = resolve(params.parentDir)
  let seriesRef: string | undefined
  let seriesTitle: string | undefined

  if (params.seriesTitle) {
    const seriesDir = join(parentDir, slugify(params.seriesTitle))
    if (!(await exists(join(seriesDir, SERIES_MANIFEST)))) {
      await mkdir(join(seriesDir, 'metadata'), { recursive: true })
      const series: SeriesManifest = SeriesManifest.parse({
        pandora: PANDORA_FORMAT_VERSION,
        title: params.seriesTitle,
        author: params.author,
        novels: []
      })
      await writeFile(join(seriesDir, SERIES_MANIFEST), stringifyYaml(series), 'utf8')
    }
    parentDir = seriesDir
    seriesRef = `../${SERIES_MANIFEST}`
    seriesTitle = params.seriesTitle
  }

  const novelDir = join(parentDir, slugify(params.title))
  if (await exists(join(novelDir, NOVEL_MANIFEST))) {
    throw new Error(`A novel already exists at ${novelDir}`)
  }

  for (const sub of NOVEL_SUBDIRS) {
    await mkdir(join(novelDir, sub), { recursive: true })
  }

  const manifest: NovelManifest = NovelManifest.parse({
    pandora: PANDORA_FORMAT_VERSION,
    title: params.title,
    author: params.author,
    ...(seriesRef ? { series: seriesRef } : {}),
    chapters: []
  })
  await writeNovelManifest(novelDir, manifest)

  // .pandora holds app-private state; chats and proposals stay out of git.
  await writeFile(
    join(novelDir, '.gitignore'),
    '.pandora/chats/\n.pandora/proposals/\n.DS_Store\n',
    'utf8'
  )
  await writeFile(join(novelDir, '.pandora', 'state.json'), JSON.stringify({ chapters: {} }), 'utf8')

  // Seed the Codex with editable starter docs.
  await writeFile(
    join(novelDir, 'metadata', 'synopsis.md'),
    `---\nlogline: ''\nthemes: []\nstatus: draft\n---\n\nA working synopsis of the whole novel. Replace this with a few paragraphs about where the story is going — the AI keeps it updated as you write, and uses it to stay oriented.\n`,
    'utf8'
  )
  await writeFile(
    join(novelDir, 'metadata', 'glossary.md'),
    `---\nentries: []\n---\n\nTerms, places, factions, items. Structured entries live in the frontmatter above as \`- term: …\` / \`definition: …\` pairs so the AI can look them up precisely.\n`,
    'utf8'
  )
  await writeFile(join(novelDir, 'metadata', 'timeline.yaml'), '# In-story events, in order. The AI appends here as chapters are saved.\n[]\n', 'utf8')

  if (params.seriesTitle) {
    const series = await readSeriesManifest(parentDir)
    const novelDirName = basename(novelDir)
    if (!series.novels.includes(novelDirName)) {
      series.novels.push(novelDirName)
      await writeFile(join(parentDir, SERIES_MANIFEST), stringifyYaml(series), 'utf8')
    }
  }

  return { dir: novelDir, manifest, seriesTitle }
}

/** Opens an existing novel directory, validating and returning its state. */
export async function openNovel(novelDir: string): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  let seriesTitle: string | undefined
  if (manifest.series) {
    try {
      // The app only ever writes `../series.yaml`; a ref reaching anywhere
      // but the novel's parent dir is hand-edited or foreign, and following
      // it would read an attacker-chosen path. Treat it as broken instead.
      const seriesPath = resolve(novelDir, manifest.series)
      if (dirname(seriesPath) !== dirname(resolve(novelDir))) {
        throw new Error(`series ref escapes the parent folder: ${manifest.series}`)
      }
      const series = await readSeriesManifest(dirname(seriesPath))
      seriesTitle = series.title
    } catch {
      // Series ref is broken — the novel still opens fine on its own.
    }
  }
  return { dir: novelDir, manifest, seriesTitle }
}

export async function createChapter(novelDir: string, title: string): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  const n = manifest.chapters.length + 1
  let file = `chapters/${chapterPrefix(n)}-${slugify(title)}.md`
  // Guard against collisions from renamed/reordered chapters sharing a slug.
  let attempt = n
  while (await exists(join(novelDir, file))) {
    attempt += 1
    file = `chapters/${chapterPrefix(attempt)}-${slugify(title)}.md`
  }

  const content = serializeFrontmatter({ data: { title, status: 'draft' }, body: '\n' })
  await writeFile(join(novelDir, file), content, 'utf8')

  manifest.chapters.push(ChapterEntry.parse({ file, title, status: 'draft' }))
  await writeNovelManifest(novelDir, manifest)
  return { dir: novelDir, manifest }
}

export async function renameChapter(
  novelDir: string,
  file: string,
  newTitle: string
): Promise<{ novel: NovelState; file: string }> {
  const manifest = await readNovelManifest(novelDir)
  const entry = manifest.chapters.find((c) => c.file === file)
  if (!entry) throw new Error(`Chapter not in manifest: ${file}`)

  // Keep the numeric prefix, refresh the slug.
  const prefix = basename(file).slice(0, 3)
  let newFile = `chapters/${prefix}-${slugify(newTitle)}.md`

  const source = resolveInside(novelDir, file)
  const raw = await readFile(source, 'utf8')
  const doc = parseFrontmatter(raw)
  if (doc.rawFrontmatter !== null) {
    throw new Error(
      `This chapter's details block isn't readable as YAML, so renaming it would write a second block over it. Open the chapter and fix the block in the details panel first.`
    )
  }
  doc.data['title'] = newTitle
  await writeFile(source, serializeFrontmatter(doc), 'utf8')

  if (newFile !== file) {
    // Titles repeat in fiction ("Interlude") — never silently keep the old
    // slug or land on another chapter's file. Pick a free name instead.
    let attempt = 2
    while (await exists(join(novelDir, newFile))) {
      newFile = `chapters/${prefix}-${slugify(newTitle)}-${attempt}.md`
      attempt += 1
    }
    await rename(source, join(novelDir, newFile))
    entry.file = newFile
  }
  entry.title = newTitle
  await writeNovelManifest(novelDir, manifest)
  // The new path is returned explicitly: resolving it client-side by title
  // used to retarget the open buffer at ANOTHER chapter with the same title.
  return { novel: { dir: novelDir, manifest }, file: entry.file }
}

/** Reorders chapters to match the given file list (must be a permutation). */
export async function reorderChapters(novelDir: string, orderedFiles: string[]): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  const byFile = new Map(manifest.chapters.map((c) => [c.file, c]))
  if (
    orderedFiles.length !== manifest.chapters.length ||
    !orderedFiles.every((f) => byFile.has(f))
  ) {
    throw new Error('Reorder list must contain exactly the existing chapters')
  }
  manifest.chapters = orderedFiles.map((f) => byFile.get(f)!)
  await writeNovelManifest(novelDir, manifest)
  return { dir: novelDir, manifest }
}

export async function readChapter(novelDir: string, file: string): Promise<string> {
  return readFile(resolveInside(novelDir, file), 'utf8')
}

export async function writeChapter(novelDir: string, file: string, content: string): Promise<void> {
  await writeFile(resolveInside(novelDir, file), content, 'utf8')
}

/**
 * Moves a chapter out of the manifest into archive/ — recoverable by hand,
 * and its history stays in git.
 */
export async function archiveChapter(novelDir: string, file: string): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  const entry = manifest.chapters.find((c) => c.file === file)
  if (!entry) throw new Error(`Chapter not in manifest: ${file}`)
  await mkdir(join(novelDir, 'archive'), { recursive: true })
  let target = `archive/${basename(file)}`
  let n = 1
  while (await exists(join(novelDir, target))) {
    target = `archive/${basename(file, '.md')}-${++n}.md`
  }
  await rename(resolveInside(novelDir, file), join(novelDir, target))
  manifest.chapters = manifest.chapters.filter((c) => c.file !== file)
  await writeNovelManifest(novelDir, manifest)
  return { dir: novelDir, manifest }
}

/**
 * Deletes a chapter file and its manifest entry. The file stays recoverable
 * from git history (deletion is itself a commit).
 */
export async function deleteChapter(novelDir: string, file: string): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  if (!manifest.chapters.some((c) => c.file === file)) {
    throw new Error(`Chapter not in manifest: ${file}`)
  }
  const { rm } = await import('node:fs/promises')
  await rm(resolveInside(novelDir, file), { force: true })
  manifest.chapters = manifest.chapters.filter((c) => c.file !== file)
  await writeNovelManifest(novelDir, manifest)
  return { dir: novelDir, manifest }
}

/** Archived chapters: archive/*.md with their frontmatter titles. */
export async function listArchivedChapters(
  novelDir: string
): Promise<{ file: string; title: string }[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(join(novelDir, 'archive'))).filter((f) => f.endsWith('.md')).sort()
    const out: { file: string; title: string }[] = []
    for (const f of files) {
      const raw = await readFile(join(novelDir, 'archive', f), 'utf8').catch(() => '')
      const { data } = parseFrontmatter(raw)
      out.push({
        file: `archive/${f}`,
        title: typeof data['title'] === 'string' && data['title'] ? data['title'] : basename(f, '.md')
      })
    }
    return out
  } catch {
    return []
  }
}

/** Moves an archived chapter back into the manifest (at the end). */
export async function restoreArchivedChapter(novelDir: string, file: string): Promise<NovelState> {
  if (!file.startsWith('archive/')) throw new Error('Not an archived chapter')
  const source = resolveInside(novelDir, file)
  const raw = await readFile(source, 'utf8')
  const { data } = parseFrontmatter(raw)
  const title =
    typeof data['title'] === 'string' && data['title'] ? data['title'] : basename(file, '.md')

  const manifest = await readNovelManifest(novelDir)
  const n = manifest.chapters.length + 1
  let target = `chapters/${chapterPrefix(n)}-${slugify(title)}.md`
  let attempt = n
  while (await exists(join(novelDir, target))) {
    target = `chapters/${chapterPrefix(++attempt)}-${slugify(title)}.md`
  }
  await rename(source, join(novelDir, target))
  manifest.chapters.push(ChapterEntry.parse({ file: target, title, status: 'draft' }))
  await writeNovelManifest(novelDir, manifest)
  return { dir: novelDir, manifest }
}

/** Permanently removes an archived chapter file (history stays in git). */
export async function deleteArchivedChapter(novelDir: string, file: string): Promise<void> {
  if (!file.startsWith('archive/')) throw new Error('Not an archived chapter')
  const { rm } = await import('node:fs/promises')
  await rm(resolveInside(novelDir, file), { force: true })
}

/* ------------------------------------------------------------------ */
/* Codex (metadata docs)                                               */
/* ------------------------------------------------------------------ */

export interface MetadataListing {
  characters: { file: string; name: string }[]
  world: { file: string; name: string }[]
  summaries: { file: string; title: string }[]
  outlines: { file: string; title: string }[]
  /** Editing-review reports the author accepted (metadata/reviews/). */
  reviews: { file: string; title: string }[]
  hasSynopsis: boolean
  hasGlossary: boolean
  hasTimeline: boolean
}

async function listDocs(dir: string): Promise<{ file: string; name: string }[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
    const out: { file: string; name: string }[] = []
    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8').catch(() => '')
      const { data } = parseFrontmatter(raw)
      const name = typeof data['name'] === 'string' && data['name'] ? data['name'] : basename(f, '.md')
      out.push({ file: f, name })
    }
    return out
  } catch {
    return []
  }
}

/** Human title for an outline file: novel.md -> "Novel outline"; chapter files use the manifest title. */
async function outlineTitles(novelDir: string): Promise<{ file: string; title: string }[]> {
  const docs = await listDocs(join(novelDir, 'outlines'))
  if (docs.length === 0) return []
  const manifest = await readNovelManifest(novelDir).catch(() => null)
  return docs.map((d) => {
    if (d.file === 'novel.md') return { file: 'outlines/novel.md', title: 'Novel outline' }
    const chapter = manifest?.chapters.find((c) => basename(c.file) === d.file)
    return { file: `outlines/${d.file}`, title: chapter ? `${chapter.title} (outline)` : d.name }
  })
}

export async function listMetadata(novelDir: string): Promise<MetadataListing> {
  const characters = (await listDocs(join(novelDir, 'metadata/characters'))).map((d) => ({
    file: `metadata/characters/${d.file}`,
    name: d.name
  }))
  const world = (await listDocs(join(novelDir, 'metadata/world'))).map((d) => ({
    file: `metadata/world/${d.file}`,
    name: d.name
  }))
  const summaries = (await listDocs(join(novelDir, 'metadata/summaries'))).map((d) => ({
    file: `metadata/summaries/${d.file}`,
    title: d.name
  }))
  const reviews = (await listDocs(join(novelDir, 'metadata/reviews'))).map((d) => ({
    file: `metadata/reviews/${d.file}`,
    title: d.name
  }))
  return {
    characters,
    world,
    summaries,
    reviews,
    outlines: await outlineTitles(novelDir),
    hasSynopsis: await exists(join(novelDir, 'metadata/synopsis.md')),
    hasGlossary: await exists(join(novelDir, 'metadata/glossary.md')),
    hasTimeline: await exists(join(novelDir, 'metadata/timeline.yaml'))
  }
}

/** Sets a chapter's status in both the manifest and its frontmatter. */
export async function setChapterStatus(
  novelDir: string,
  file: string,
  status: 'draft' | 'ai-draft' | 'revised' | 'final'
): Promise<NovelState> {
  const manifest = await readNovelManifest(novelDir)
  const entry = manifest.chapters.find((c) => c.file === file)
  if (!entry) throw new Error(`Chapter not in manifest: ${file}`)
  // Read and vet the file BEFORE the manifest write: refusing afterwards would
  // leave the manifest saying one thing and the chapter another.
  const target = resolveInside(novelDir, file)
  const raw = await readFile(target, 'utf8')
  const doc = parseFrontmatter(raw)
  if (doc.rawFrontmatter !== null) {
    throw new Error(
      `This chapter's details block isn't readable as YAML, so changing its status would write a second block over it. Open the chapter and fix the block in the details panel first.`
    )
  }
  entry.status = status
  await writeNovelManifest(novelDir, manifest)
  doc.data['status'] = status
  await writeFile(target, serializeFrontmatter(doc), 'utf8')
  return { dir: novelDir, manifest }
}

const CHARACTER_TEMPLATE = (name: string): string =>
  `---\nname: ${name}\naliases: []\nrole: ''\nstatus: alive\nfirst_appearance: ''\nattributes: {}\nrelationships: []\n---\n\n## Appearance\n\n## Personality\n\n## Arc notes\n`

const WORLD_TEMPLATE = (name: string): string =>
  `---\nsystem: {}\n---\n\n# ${name}\n\nDescribe how this system works: rules, tiers, requirements, costs, limits. Structured facts (stat tables, tier lists) belong in the \`system:\` frontmatter map so the AI can read them precisely.\n`

export async function createMetadataDoc(
  novelDir: string,
  kind: 'character' | 'world',
  name: string
): Promise<{ file: string }> {
  const sub = kind === 'character' ? 'metadata/characters' : 'metadata/world'
  const file = `${sub}/${slugify(name)}.md`
  if (await exists(join(novelDir, file))) {
    throw new Error(`${name} already exists`)
  }
  const content = kind === 'character' ? CHARACTER_TEMPLATE(name) : WORLD_TEMPLATE(name)
  await writeFile(join(novelDir, file), content, 'utf8')
  return { file }
}

export async function deleteMetadataDoc(novelDir: string, file: string): Promise<void> {
  if (!file.startsWith('metadata/')) throw new Error('Only Codex docs can be deleted here')
  const { rm } = await import('node:fs/promises')
  await rm(resolveInside(novelDir, file), { force: true })
}

/* ------------------------------------------------------------------ */
/* Images (assets/)                                                    */
/* ------------------------------------------------------------------ */

/** Must match the pandora-asset:// scheme's allowlist. */
const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/**
 * Copies an image into `<novel>/assets/` and returns its novel-relative
 * path for the markdown link. The bytes land as a file, never as base64 in
 * the markdown — inlining would bloat chapters and kill diffs. `assets/` is
 * created lazily (like `archive/`) so existing novels pick it up on first
 * use.
 */
export async function importAsset(
  novelDir: string,
  name: string,
  bytes: Uint8Array
): Promise<{ rel: string }> {
  if (bytes.byteLength === 0) throw new Error('That image is empty')
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error('Images are capped at 20 MB — resize this one first')
  }
  const ext = basename(name).includes('.') ? basename(name).split('.').pop()!.toLowerCase() : ''
  if (!ASSET_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image type ".${ext}" — use png, jpg, gif, webp, avif, or svg`)
  }
  const base = slugify(basename(name).replace(/\.[^.]*$/, ''))
  await mkdir(join(novelDir, 'assets'), { recursive: true })
  let rel = `assets/${base}.${ext}`
  let attempt = 2
  while (await exists(join(novelDir, rel))) {
    rel = `assets/${base}-${attempt}.${ext}`
    attempt += 1
  }
  await writeFile(resolveInside(novelDir, rel), bytes)
  return { rel }
}
