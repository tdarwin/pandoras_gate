import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNovel,
  openNovel,
  createChapter,
  renameChapter,
  reorderChapters,
  archiveChapter,
  deleteChapter,
  readChapter,
  writeChapter,
  readNovelManifest,
  listMetadata,
  createMetadataDoc,
  deleteMetadataDoc,
  importAsset
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

describe('codex', () => {
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

describe('path containment', () => {
  it('chapter reads and writes refuse paths that escape the novel folder', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await writeFile(join(dir, 'outside.md'), 'secret', 'utf8')
    await expect(readChapter(novelDir, '../outside.md')).rejects.toThrow(/\.\./)
    await expect(writeChapter(novelDir, '../outside.md', 'pwn')).rejects.toThrow(/\.\./)
    await expect(deleteMetadataDoc(novelDir, 'metadata/../../outside.md')).rejects.toThrow(/\.\./)
    expect(await readFile(join(dir, 'outside.md'), 'utf8')).toBe('secret')
  })

  it('a hand-edited manifest with a traversal chapter path degrades with a readable message', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    const manifestPath = join(novelDir, 'novel.yaml')
    const raw = await readFile(manifestPath, 'utf8')
    await writeFile(
      manifestPath,
      raw.replace('chapters: []', 'chapters:\n  - file: ../../.zshrc\n    title: Innocent\n'),
      'utf8'
    )
    await expect(openNovel(novelDir)).rejects.toThrow(/chapter paths must look like/)
  })

  it('a series ref reaching outside the parent folder is treated as broken, not followed', async () => {
    // A series.yaml two levels up — real, readable, but outside the novel's
    // parent dir, so the ref may not be followed.
    await writeFile(join(dir, 'series.yaml'), 'pandora: 1\ntitle: Foreign\nnovels: []\n', 'utf8')
    const { dir: novelDir } = await createNovel({
      parentDir: join(dir, 'nested'),
      title: 'Solo',
      author: 'D'
    })
    const manifestPath = join(novelDir, 'novel.yaml')
    const raw = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, `${raw}series: ../../series.yaml\n`, 'utf8')
    const opened = await openNovel(novelDir)
    expect(opened.seriesTitle).toBeUndefined()
  })
})

describe('importAsset', () => {
  it('writes into assets/ (created lazily), de-duplicating names', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    const bytes = new Uint8Array([1, 2, 3])
    expect((await importAsset(novelDir, 'Cover Art.PNG', bytes)).rel).toBe('assets/cover-art.png')
    expect((await importAsset(novelDir, 'Cover Art.png', bytes)).rel).toBe('assets/cover-art-2.png')
    expect(await readFile(join(novelDir, 'assets', 'cover-art.png'))).toEqual(Buffer.from(bytes))
  })

  it('rejects non-image extensions, empty data, and oversize files readably', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await expect(importAsset(novelDir, 'script.js', new Uint8Array([1]))).rejects.toThrow(
      /Unsupported image type/
    )
    await expect(importAsset(novelDir, 'noext', new Uint8Array([1]))).rejects.toThrow(
      /Unsupported image type/
    )
    await expect(importAsset(novelDir, 'x.png', new Uint8Array(0))).rejects.toThrow(/empty/)
    await expect(
      importAsset(novelDir, 'x.png', new Uint8Array(21 * 1024 * 1024))
    ).rejects.toThrow(/20 MB/)
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
    const result = await renameChapter(novelDir, 'chapters/001-old-title.md', 'New Dawn')

    // The new path is returned explicitly for the renderer to re-point at.
    expect(result.file).toBe('chapters/001-new-dawn.md')
    expect(result.novel.manifest.chapters[0]!.file).toBe('chapters/001-new-dawn.md')
    expect(result.novel.manifest.chapters[0]!.title).toBe('New Dawn')
    const raw = await readChapter(novelDir, 'chapters/001-new-dawn.md')
    expect(raw).toContain('title: New Dawn')
  })

  it('renaming to a title another chapter holds keeps both files distinct', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Interlude')
    await createChapter(novelDir, 'Chapter Seven')
    await writeChapter(
      novelDir,
      'chapters/002-chapter-seven.md',
      '---\ntitle: Chapter Seven\nstatus: draft\n---\nSeven prose.\n'
    )

    const result = await renameChapter(novelDir, 'chapters/002-chapter-seven.md', 'Interlude')
    // Its own prefix keeps the slug distinct — never chapter one's file.
    expect(result.file).toBe('chapters/002-interlude.md')
    expect(result.novel.manifest.chapters.map((c) => c.file)).toEqual([
      'chapters/001-interlude.md',
      'chapters/002-interlude.md'
    ])
    // Chapter one's content is untouched; seven's prose lives at the new path.
    expect(await readChapter(novelDir, 'chapters/002-interlude.md')).toContain('Seven prose.')
  })

  it('rename routes around a file already sitting at the target path', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Chapter One')
    // A hand-dropped file (users may edit the folder directly) claims the slug.
    await writeFile(join(novelDir, 'chapters/001-interlude.md'), 'stray file\n', 'utf8')

    const result = await renameChapter(novelDir, 'chapters/001-chapter-one.md', 'Interlude')
    expect(result.file).toBe('chapters/001-interlude-2.md')
    // The stray file is untouched.
    expect(await readFile(join(novelDir, 'chapters/001-interlude.md'), 'utf8')).toBe('stray file\n')
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

  it('archives a chapter: file moves, manifest entry drops', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Keep Me')
    await createChapter(novelDir, 'Archive Me')
    const state = await archiveChapter(novelDir, 'chapters/002-archive-me.md')

    expect(state.manifest.chapters.map((c) => c.title)).toEqual(['Keep Me'])
    await expect(access(join(novelDir, 'archive/002-archive-me.md'))).resolves.toBeUndefined()
    await expect(access(join(novelDir, 'chapters/002-archive-me.md'))).rejects.toThrow()
  })

  it('archive avoids name collisions', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Twice')
    await archiveChapter(novelDir, 'chapters/001-twice.md')
    await createChapter(novelDir, 'Twice')
    await archiveChapter(novelDir, 'chapters/001-twice.md')
    await expect(access(join(novelDir, 'archive/001-twice.md'))).resolves.toBeUndefined()
    await expect(access(join(novelDir, 'archive/001-twice-2.md'))).resolves.toBeUndefined()
  })

  it('deletes a chapter file and manifest entry', async () => {
    const { dir: novelDir } = await createNovel({ parentDir: dir, title: 'N', author: 'D' })
    await createChapter(novelDir, 'Doomed')
    const state = await deleteChapter(novelDir, 'chapters/001-doomed.md')
    expect(state.manifest.chapters).toEqual([])
    await expect(access(join(novelDir, 'chapters/001-doomed.md'))).rejects.toThrow()
    await expect(deleteChapter(novelDir, 'chapters/001-doomed.md')).rejects.toThrow(/not in manifest/)
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
