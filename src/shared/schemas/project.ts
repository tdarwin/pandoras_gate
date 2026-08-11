import { z } from 'zod'

/** Format version stamped into every manifest we write. */
export const PANDORA_FORMAT_VERSION = 1

export const ChapterStatus = z.enum(['draft', 'ai-draft', 'revised', 'final'])
export type ChapterStatus = z.infer<typeof ChapterStatus>

export const ChapterEntry = z.object({
  /** Path relative to the novel dir, e.g. "chapters/001-the-iron-gate.md" */
  file: z.string(),
  title: z.string(),
  status: ChapterStatus.default('draft')
})
export type ChapterEntry = z.infer<typeof ChapterEntry>

/** novel.yaml — source of truth for chapter order and status. */
export const NovelManifest = z.object({
  pandora: z.number().default(PANDORA_FORMAT_VERSION),
  title: z.string().min(1),
  author: z.string().default(''),
  /** Relative path to a series.yaml when this novel is part of a series. */
  series: z.string().optional(),
  /**
   * Author's standing instructions for the AI on this novel (voice, tense,
   * content boundaries…) — appended to every system prompt.
   */
  chatInstructions: z.string().optional(),
  chapters: z.array(ChapterEntry).default([])
})
export type NovelManifest = z.infer<typeof NovelManifest>

/** series.yaml — the optional level above novels. */
export const SeriesManifest = z.object({
  pandora: z.number().default(PANDORA_FORMAT_VERSION),
  title: z.string().min(1),
  author: z.string().default(''),
  /** Novel directory names within the series dir, in reading order. */
  novels: z.array(z.string()).default([])
})
export type SeriesManifest = z.infer<typeof SeriesManifest>

/** Frontmatter kept in each chapter file (ordering lives in the manifest). */
export const ChapterFrontmatter = z.object({
  title: z.string().default(''),
  status: ChapterStatus.default('draft')
})
export type ChapterFrontmatter = z.infer<typeof ChapterFrontmatter>

/** What the renderer needs to display an open novel. */
export const NovelStateSchema = z.object({
  dir: z.string(),
  manifest: NovelManifest,
  seriesTitle: z.string().optional()
})
export type NovelState = z.infer<typeof NovelStateSchema>
