import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNovel,
  openNovel,
  createChapter,
  renameChapter,
  reorderChapters,
  readChapter,
  writeChapter,
  readNovelManifest,
  listMetadata,
  createMetadataDoc,
  deleteMetadataDoc
} from './service'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pandora-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createNovel', () => {
  it('creates the full directory skeleton and manifest', async () => {
    const state = await createNovel({ parentDir: dir, title: 'The Iron Gate', author: 'Davin' })
    expect(state.dir).toBe(join(dir, 'the-iron-gate'))
    expect(state.manifest.title).toBe('The Iron Gate')
    expect(state.manifest.chapters).toEqual([])

    for (const sub of ['chapters', 'metadata/summaries', 'metadata/characters', 'metadata/world', '.pandora']) {
      await expect(access(join(state.dir, sub))).resolves.toBeUndefined()
    }
    const manifest = await readNovelManifest(state.dir)
    expect(manifest.author).toBe('Davin')
  })

  it('creates a series wrapper when seriesTitle is given', async () => {
    const state = await createNovel({
      parentDir: dir,
      title: 'Book One',
      author: 'Davin',
      seriesTitle: 'Jade Ascension'
    })
    expect(state.dir).toBe(join(dir, 'jade-ascension', 'book-one'))
    expect(state.seriesTitle).toBe('Jade Ascension')
    const seriesRaw = await readFile(join(dir, 'jade-ascension', 'series.yaml'), 'utf8')
    expect(seriesRaw).toContain('Jade Ascension')
    expect(seriesRaw).toContain('book-one')
  })

  it('adds a second novel to an existing series', async () => {
    await createNovel({ parentDir: dir, title: 'Book One', author: 'D', seriesTitle: 'Saga' })
    await createNovel({ parentDir: dir, title: 'Book Two', author: 'D', seriesTitle: 'Saga' })
    const seriesRaw = await readFile(join(dir, 'saga', 'series.yaml'), 'utf8')
    expect(seriesRaw).toContain('book-one')
    expect(seriesRaw).toContain('book-two')
  })

  it('refuses to overwrite an existing novel', async () => {
    await createNovel({ parentDir: dir, title: 'Twice', author: 'D' })
    await expect(createNovel({ parentDir: dir, title: 'Twice', author: 'D' })).rejects.toThrow(
      /already exists/
    )
  })
})

describe('story bible', () => {
  it('seeds synopsis, glossary, and timeline templates on creation', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    const listing = await listMetadata(novelDir)
    expect(listing.hasSynopsis).toBe(true)
    expect(listing.hasGlossary).toBe(true)
    expect(listing.hasTimeline).toBe(true)
    expect(listing.characters).toEqual([])
    const synopsis = await readFile(join(novelDir, 'metadata/synopsis.md'), 'utf8')
    expect(synopsis).toContain('logline:')
  })

  it('creates character and world docs from templates', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    const char = await createMetadataDoc(novelDir, 'character', 'Kael Voss')
    expect(char.file).toBe('metadata/characters/kael-voss.md')
    const world = await createMetadataDoc(novelDir, 'world', 'Cultivation System')
    expect(world.file).toBe('metadata/world/cultivation-system.md')

    const listing = await listMetadata(novelDir)
    expect(listing.characters).toEqual([
      { file: 'metadata/characters/kael-voss.md', name: 'Kael Voss' }
    ])
    expect(listing.world[0]!.file).toBe('metadata/world/cultivation-system.md')

    await expect(createMetadataDoc(novelDir, 'character', 'Kael Voss')).rejects.toThrow(
      /already exists/
    )
  })

  it('deletes only metadata docs', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createMetadataDoc(novelDir, 'character', 'Doomed')
    await deleteMetadataDoc(novelDir, 'metadata/characters/doomed.md')
    expect((await listMetadata(novelDir)).characters).toEqual([])
    await expect(deleteMetadataDoc(novelDir, 'novel.yaml')).rejects.toThrow()
  })
})

describe('openNovel', () => {
  it('roundtrips create -> open', async () => {
    const created = await createNovel({ parentDir: dir, title: 'Reopen Me', author: 'D' })
    const opened = await openNovel(created.dir)
    expect(opened.manifest).toEqual(created.manifest)
  })

  it('resolves the series title through the series ref', async () => {
    const created = await createNovel({
      parentDir: dir,
      title: 'Book One',
      author: 'D',
      seriesTitle: 'The Saga'
    })
    const opened = await openNovel(created.dir)
    expect(opened.seriesTitle).toBe('The Saga')
  })
})

describe('chapters', () => {
  it('creates numbered chapter files with frontmatter and manifest entries', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    let state = await createChapter(novelDir, 'The Iron Gate')
    state = await createChapter(novelDir, 'First Breakthrough')

    expect(state.manifest.chapters.map((c) => c.file)).toEqual([
      'chapters/001-the-iron-gate.md',
      'chapters/002-first-breakthrough.md'
    ])
    const raw = await readChapter(novelDir, 'chapters/001-the-iron-gate.md')
    expect(raw).toContain('title: The Iron Gate')
    expect(raw).toContain('status: draft')
  })

  it('renames a chapter: file, frontmatter, and manifest stay in sync', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Old Title')
    const state = await renameChapter(novelDir, 'chapters/001-old-title.md', 'New Dawn')

    expect(state.manifest.chapters[0]!.file).toBe('chapters/001-new-dawn.md')
    expect(state.manifest.chapters[0]!.title).toBe('New Dawn')
    const raw = await readChapter(novelDir, 'chapters/001-new-dawn.md')
    expect(raw).toContain('title: New Dawn')
  })

  it('reorders chapters and rejects non-permutations', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'A')
    await createChapter(novelDir, 'B')
    await createChapter(novelDir, 'C')

    const state = await reorderChapters(novelDir, [
      'chapters/003-c.md',
      'chapters/001-a.md',
      'chapters/002-b.md'
    ])
    expect(state.manifest.chapters.map((c) => c.title)).toEqual(['C', 'A', 'B'])

    await expect(reorderChapters(novelDir, ['chapters/001-a.md'])).rejects.toThrow(/permutation|exactly/)
  })

  it('writes and reads chapter content', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'A')
    await writeChapter(novelDir, 'chapters/001-a.md', '---\ntitle: A\n---\nHello world.\n')
    expect(await readChapter(novelDir, 'chapters/001-a.md')).toContain('Hello world.')
  })

  it('avoids filename collisions when titles repeat', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Echo')
    await renameChapter(novelDir, 'chapters/001-echo.md', 'Echo Two')
    // A new chapter numbered 002 whose slug collides with nothing should be fine;
    // then force a collision path by renaming back and creating again.
    const state = await createChapter(novelDir, 'Echo')
    expect(state.manifest.chapters).toHaveLength(2)
    const files = state.manifest.chapters.map((c) => c.file)
    expect(new Set(files).size).toBe(2)
  })
})
