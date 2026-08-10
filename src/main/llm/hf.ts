/**
 * Hugging Face Hub integration: search GGUF repos and list their model files,
 * unauthenticated. Downloads themselves go through the shared downloader
 * (node-llama-cpp handles hf: URIs, resume, and multi-part models).
 */

const HF_API = 'https://huggingface.co/api'

export interface HfRepo {
  id: string
  downloads: number
  likes: number
  /** Gated repos need an HF account + license acceptance — we surface, not download. */
  gated: boolean
}

export interface HfGgufFile {
  /** First-part filename for multi-part models. */
  filename: string
  /** Total bytes across all parts. */
  sizeBytes: number
  /** Human quant label, e.g. "Q4_K_M". */
  quant: string
  parts: number
}

interface HfSearchResult {
  id: string
  private?: boolean
  gated?: boolean | string
  downloads?: number
  likes?: number
}

interface HfSibling {
  rfilename: string
  size?: number
}

export async function searchHfGgufModels(query: string): Promise<HfRepo[]> {
  const url = `${HF_API}/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=20`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Hugging Face search failed: ${res.status}`)
  const body = (await res.json()) as HfSearchResult[]
  return body
    .filter((m) => !m.private)
    .map((m) => ({
      id: m.id,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      gated: Boolean(m.gated)
    }))
}

const MULTIPART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i
const QUANT_RE = /[.-]((?:I?Q\d[_A-Z0-9]*|F16|BF16|F32))(?:-\d{5}-of-\d{5})?\.gguf$/i

export function quantOf(filename: string): string {
  const m = QUANT_RE.exec(filename)
  return m ? m[1]!.toUpperCase() : 'unknown'
}

/**
 * Groups sibling files into downloadable GGUF entries: single files pass
 * through; multi-part models collapse into their first part with a summed
 * size. Pure — unit tested against real-world naming patterns.
 */
export function parseGgufSiblings(siblings: HfSibling[]): HfGgufFile[] {
  const ggufs = siblings.filter((s) => s.rfilename.toLowerCase().endsWith('.gguf'))
  const out: HfGgufFile[] = []
  const partGroups = new Map<string, { first: string; total: number; parts: number }>()

  for (const s of ggufs) {
    const m = MULTIPART_RE.exec(s.rfilename)
    if (!m) {
      out.push({
        filename: s.rfilename,
        sizeBytes: s.size ?? 0,
        quant: quantOf(s.rfilename),
        parts: 1
      })
      continue
    }
    const groupKey = s.rfilename.replace(MULTIPART_RE, '')
    const group = partGroups.get(groupKey) ?? { first: '', total: 0, parts: 0 }
    group.total += s.size ?? 0
    group.parts += 1
    if (m[1] === '00001') group.first = s.rfilename
    partGroups.set(groupKey, group)
  }

  for (const group of partGroups.values()) {
    if (!group.first) continue
    out.push({
      filename: group.first,
      sizeBytes: group.total,
      quant: quantOf(group.first),
      parts: group.parts
    })
  }

  return out.sort((a, b) => a.sizeBytes - b.sizeBytes)
}

export async function listHfGgufFiles(
  repoId: string
): Promise<{ files: HfGgufFile[]; gated: boolean }> {
  const res = await fetch(`${HF_API}/models/${repoId}?blobs=true`)
  if (!res.ok) throw new Error(`Could not load ${repoId}: ${res.status}`)
  const body = (await res.json()) as { siblings?: HfSibling[]; gated?: boolean | string }
  return {
    files: parseGgufSiblings(body.siblings ?? []),
    gated: Boolean(body.gated)
  }
}
