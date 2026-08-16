/**
 * Verifies the curated catalog against Hugging Face and OpenRouter.
 *
 * Recommending a model that 404s, or whose download button is disabled because
 * the repo turned out to be gated, is worse than recommending nothing. This
 * script is the check that keeps the catalog honest — run it whenever the
 * picks change, and before publishing site/catalog.json.
 *
 * It hits the network, so it is deliberately NOT part of `npm run test`; the
 * offline invariants live in src/main/llm/catalog.test.ts.
 *
 *   npm run verify:catalog          # check only
 *   npm run verify:catalog -- --write  # also re-measure memory profiles
 *
 * `--write` reads each model's GGUF header over HTTP (only the header — not the
 * gigabytes behind it) and rewrites the `memory` block from node-llama-cpp's
 * own estimator. That block is what lets the app tell a user how much context
 * their machine will actually give a model *before* they download it, so it is
 * measured, never hand-authored.
 *
 * Node strips the types natively (Node 22.6+), so there is no build step and
 * no extra dependency.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CatalogFileSchema, type CatalogModel, type HostedPick } from '../src/shared/llm/catalog.ts'
import { CONTEXT_SAMPLES, type MemoryProfile } from '../src/shared/llm/memory.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLED = join(root, 'src/main/llm/catalog.json')
const PUBLISHED = join(root, 'site/catalog.json')

let failures = 0
let warnings = 0

function fail(id: string, message: string): void {
  failures++
  console.error(`  \x1b[31m✗\x1b[0m ${id}: ${message}`)
}

function warn(id: string, message: string): void {
  warnings++
  console.warn(`  \x1b[33m!\x1b[0m ${id}: ${message}`)
}

function ok(id: string, message: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${id} ${message}`)
}

interface HfTreeEntry {
  path: string
  size?: number
}

/** Splits `hf:owner/repo/path/to/file.gguf` into repo id and file path. */
function parseHfUri(uri: string): { repoId: string; filePath: string } | null {
  const rest = uri.slice('hf:'.length)
  const parts = rest.split('/')
  if (parts.length < 3) return null
  return { repoId: `${parts[0]}/${parts[1]}`, filePath: parts.slice(2).join('/') }
}

function downloadUrl(repoId: string, filePath: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${filePath}`
}

/**
 * Measures a model's weights and KV-cache cost from its GGUF header.
 *
 * `readGgufFileInfo` fetches only the header, so this costs a few seconds and a
 * few megabytes rather than a full download. The numbers come from
 * node-llama-cpp's own estimator — the same code that decides the real context
 * size at load time — so the catalog's advice and the runtime agree.
 */
async function measureMemory(model: CatalogModel): Promise<MemoryProfile | null> {
  const parsed = parseHfUri(model.hfUri)
  if (!parsed) return null
  const { readGgufFileInfo, GgufInsights } = await import('node-llama-cpp')
  const info = await readGgufFileInfo(downloadUrl(parsed.repoId, parsed.filePath), {
    readTensorInfo: true,
    logWarnings: false
  })
  const insights = await GgufInsights.from(info)
  const gpuLayers = insights.totalLayers
  const weights = insights.estimateModelResourceRequirements({ gpuLayers })
  const trainContextLength = insights.trainContextSize ?? model.contextLength

  const contextCost = CONTEXT_SAMPLES.filter((c) => c <= trainContextLength).map(
    (contextSize) => {
      const r = insights.estimateContextResourceRequirements({
        contextSize,
        modelGpuLayers: gpuLayers
      })
      return { contextSize, bytes: Math.round(r.gpuVram + r.cpuRam) }
    }
  )

  return {
    weightsBytes: Math.round(weights.gpuVram + weights.cpuRam),
    trainContextLength,
    contextCost
  }
}

async function verifyModel(model: CatalogModel): Promise<void> {
  const parsed = parseHfUri(model.hfUri)
  if (!parsed) {
    fail(model.id, `hfUri is not owner/repo/file: ${model.hfUri}`)
    return
  }
  const { repoId, filePath } = parsed

  if (!filePath.endsWith(model.filename)) {
    fail(model.id, `filename "${model.filename}" does not match hfUri path "${filePath}"`)
  }

  const infoRes = await fetch(`https://huggingface.co/api/models/${repoId}`)
  if (!infoRes.ok) {
    fail(model.id, `repo ${repoId} returned HTTP ${infoRes.status}`)
    return
  }
  const info = (await infoRes.json()) as { gated?: boolean | string; downloads?: number }

  // Gated repos need a license accepted while signed in, which the in-app
  // downloader cannot do — the button would just fail.
  if (info.gated) fail(model.id, `repo ${repoId} is gated (${info.gated}) — not downloadable in-app`)

  const treeRes = await fetch(`https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`)
  if (!treeRes.ok) {
    fail(model.id, `file listing for ${repoId} returned HTTP ${treeRes.status}`)
    return
  }
  const tree = (await treeRes.json()) as HfTreeEntry[]
  const entry = tree.find((f) => f.path === filePath)
  if (!entry) {
    fail(model.id, `file "${filePath}" not found in ${repoId}`)
    return
  }

  if (entry.size !== undefined && entry.size !== model.sizeBytes) {
    fail(
      model.id,
      `sizeBytes is ${model.sizeBytes.toLocaleString()}, Hugging Face reports ${entry.size.toLocaleString()}`
    )
    return
  }

  const sizeGB = model.sizeBytes / 1024 ** 3

  // The memory profile drives every recommendation, so a stale one is worse
  // than a missing one.
  if (model.memory.weightsBytes < model.sizeBytes * 0.9) {
    warn(
      model.id,
      `weightsBytes ${(model.memory.weightsBytes / 1024 ** 3).toFixed(1)}GB is below the file size — re-run with --write`
    )
  }
  if (model.memory.trainContextLength < model.contextLength) {
    warn(
      model.id,
      `contextLength ${model.contextLength} exceeds the measured trained window ${model.memory.trainContextLength}`
    )
  }

  ok(model.id, `${repoId} · ${sizeGB.toFixed(1)}GB · ${(info.downloads ?? 0).toLocaleString()} downloads`)
}

async function verifyHosted(picks: HostedPick[]): Promise<void> {
  const res = await fetch('https://openrouter.ai/api/v1/models')
  if (!res.ok) {
    fail('hosted', `OpenRouter /models returned HTTP ${res.status}`)
    return
  }
  const body = (await res.json()) as {
    data: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[]
  }
  const bySlug = new Map(body.data.map((m) => [m.id, m]))

  for (const pick of picks) {
    const live = bySlug.get(pick.id)
    if (!live) {
      fail(pick.id, 'slug not offered by OpenRouter')
      continue
    }
    if (live.context_length && live.context_length !== pick.contextLength) {
      warn(pick.id, `contextLength ${pick.contextLength} vs live ${live.context_length}`)
    }
    // Pricing moves; the app reads it live, so a drift here is only stale copy.
    const livePrompt = Number(live.pricing?.prompt ?? 0) * 1_000_000
    if (livePrompt > 0 && Math.abs(livePrompt - pick.approxCostPerMTok.prompt) > livePrompt * 0.25) {
      warn(
        pick.id,
        `prompt cost $${pick.approxCostPerMTok.prompt}/Mtok vs live $${livePrompt.toFixed(2)}`
      )
    }
    ok(pick.id, `$${livePrompt.toFixed(2)}/Mtok in · ${live.context_length?.toLocaleString()} ctx`)
  }
}

/**
 * Re-measures every model and rewrites both catalog copies. Kept separate from
 * verification so a routine check can never mutate the catalog by accident.
 */
async function writeProfiles(raw: string): Promise<void> {
  const catalog = JSON.parse(raw) as { models: (CatalogModel & { memory?: MemoryProfile })[] }
  console.log(`\nMeasuring ${catalog.models.length} models from their GGUF headers…`)
  for (const model of catalog.models) {
    try {
      const memory = await measureMemory(model)
      if (!memory) {
        fail(model.id, 'could not parse hfUri')
        continue
      }
      model.memory = memory
      // Superseded by the measured profile; derived from it now.
      delete (model as Record<string, unknown>).minMemoryGB
      delete (model as Record<string, unknown>).recommendedMemoryGB
      const at16k = memory.contextCost.find((c) => c.contextSize === 16384)
      ok(
        model.id,
        `weights ${(memory.weightsBytes / 1024 ** 3).toFixed(1)}GB · ` +
          `16k ctx costs ${at16k ? (at16k.bytes / 1024 ** 3).toFixed(2) : '?'}GB · ` +
          `trained to ${Math.round(memory.trainContextLength / 1024)}k`
      )
    } catch (err) {
      fail(model.id, `measurement failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const out = JSON.stringify(catalog, null, 2) + '\n'
  await writeFile(BUNDLED, out, 'utf8')
  await writeFile(PUBLISHED, out, 'utf8')
  console.log(`\nWrote memory profiles to both catalog copies.`)
}

async function main(): Promise<void> {
  if (process.argv.includes('--write')) {
    await writeProfiles(await readFile(BUNDLED, 'utf8'))
    if (failures > 0) {
      console.error(`\n\x1b[31m${failures} measurement failure(s)\x1b[0m\n`)
      process.exit(1)
    }
  }

  const bundledRaw = await readFile(BUNDLED, 'utf8')
  const publishedRaw = await readFile(PUBLISHED, 'utf8').catch(() => null)

  if (publishedRaw === null) {
    fail('site/catalog.json', 'missing — the published copy is what shipped apps fetch')
  } else if (publishedRaw !== bundledRaw) {
    fail('site/catalog.json', 'differs from the bundled copy; they must stay byte-identical')
  }

  const parsed = CatalogFileSchema.safeParse(JSON.parse(bundledRaw))
  if (!parsed.success) {
    console.error('catalog.json failed schema validation:')
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    process.exit(1)
  }
  const catalog = parsed.data

  console.log(`\nLocal models (${catalog.models.length}):`)
  // Sequential on purpose: a burst of parallel requests gets rate-limited by
  // the Hugging Face API, which reads as a catalog failure.
  for (const model of catalog.models) await verifyModel(model)

  console.log(`\nHosted picks (${catalog.hosted.length}):`)
  await verifyHosted(catalog.hosted)

  console.log(
    `\n${failures === 0 ? '\x1b[32mCatalog OK\x1b[0m' : `\x1b[31m${failures} failure(s)\x1b[0m`}` +
      `${warnings > 0 ? `, ${warnings} warning(s)` : ''}\n`
  )
  process.exit(failures === 0 ? 0 : 1)
}

await main()
