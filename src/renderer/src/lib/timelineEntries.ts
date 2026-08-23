/**
 * The timeline as data: `metadata/timeline.yaml` is a list of event records,
 * not prose, so its suggestions are decided entry by entry rather than as
 * tracked changes.
 *
 * Kept apart from the component so it can be tested — and because a file the
 * author may have hand-edited into any shape at all deserves its own guards.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export type Entry = Record<string, unknown>

export function parseEntries(raw: string): Entry[] | null {
  try {
    const parsed: unknown = parseYaml(raw)
    if (parsed === null || parsed === undefined) return []
    if (!Array.isArray(parsed)) return null
    if (!parsed.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e))) return null
    return parsed as Entry[]
  } catch {
    return null
  }
}

/**
 * Stable identity for matching a proposed entry to a current one.
 *
 * `seen` disambiguates repeats: the prompt asks for ids but cannot guarantee
 * them, and a hand-written timeline routinely has several events on one
 * in-world day. Without this they all key to `when:Day 1`, the Maps below keep
 * only the last, and accepting a change to one deletes the others.
 */
export function entryKey(entry: Entry, index: number, seen?: Map<string, number>): string {
  let base = `#${index}`
  for (const field of ['id', 'when', 'date', 'title'] as const) {
    const v = entry[field]
    if (typeof v === 'string' && v.trim()) {
      base = `${field}:${v.trim()}`
      break
    }
  }
  if (!seen) return base
  const n = (seen.get(base) ?? 0) + 1
  seen.set(base, n)
  return n === 1 ? base : `${base}#${n}`
}

/** Key-order-insensitive equality: a re-emitted entry is not a change. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const fields = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return `{${fields.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`
}

export function sameEntry(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}

/**
 * Pairs the two lists entry by entry, and gives every pair a key.
 *
 * Naming an entry "the nth with this key" is not identity: drop or reorder one
 * of several events sharing a day and every later suffix shifts, so a proposal
 * that removes the first of two `Day 1` entries reads as "change the first,
 * remove the second" — accept one of those and the file ends up with the wrong
 * event twice and the other gone. Stored rejections drift the same way.
 *
 * So identical entries are matched to each other FIRST, in order, and only
 * what is left over gets a positional suffix. An entry that survives untouched
 * keeps its key no matter what happens around it.
 */
export function pairKeys(current: Entry[], proposed: Entry[]): [string[], string[]] {
  const aKeys: (string | null)[] = current.map(() => null)
  const bKeys: (string | null)[] = proposed.map(() => null)

  // Pass 1: exact matches, earliest first, each used once.
  const takenB = new Set<number>()
  const used = new Map<string, number>()
  const nextKey = (entry: Entry, index: number): string => entryKey(entry, index, used)
  for (let i = 0; i < current.length; i++) {
    for (let j = 0; j < proposed.length; j++) {
      if (takenB.has(j) || !sameEntry(current[i], proposed[j])) continue
      const key = nextKey(current[i]!, i)
      aKeys[i] = key
      bKeys[j] = key
      takenB.add(j)
      break
    }
  }

  // Pass 2: whatever is left, disambiguated positionally within its own list.
  const leftoverA = new Map<string, number>()
  const leftoverB = new Map<string, number>()
  for (let i = 0; i < current.length; i++) {
    if (aKeys[i] === null) aKeys[i] = `~${entryKey(current[i]!, i, leftoverA)}`
  }
  for (let j = 0; j < proposed.length; j++) {
    if (bKeys[j] === null) bKeys[j] = `~${entryKey(proposed[j]!, j, leftoverB)}`
  }
  return [aKeys as string[], bKeys as string[]]
}

export function serializeEntries(entries: Entry[]): string {
  return entries.length === 0 ? '[]\n' : stringifyYaml(entries)
}

/**
 * Names a change by what it does, not by where it sits.
 *
 * A rejection is remembered by key, and a positional key drifts: accept one of
 * several same-day entries and every later suffix shifts, so the stored
 * rejection stops matching — the suggestion comes back — or starts matching a
 * different entry that slid into the slot.
 */
function changeKey(kind: string, current: Entry | undefined, proposed: Entry | undefined): string {
  return `${kind}:${stableJson(current ?? null)}>${stableJson(proposed ?? null)}`
}

export interface EntryChange {
  key: string
  kind: 'added' | 'changed' | 'removed'
  current?: Entry
  proposed?: Entry
}

export function diffEntries(current: Entry[], proposed: Entry[]): EntryChange[] {
  const [currentKeys, proposedKeys] = pairKeys(current, proposed)
  const currentByKey = new Map(currentKeys.map((k, i) => [k, current[i]!]))
  const proposedByKey = new Map(proposedKeys.map((k, i) => [k, proposed[i]!]))
  const out: EntryChange[] = []
  for (const [key, entry] of proposedByKey) {
    const existing = currentByKey.get(key)
    if (!existing) {
      out.push({ key: changeKey('added', undefined, entry), kind: 'added', proposed: entry })
    } else if (!sameEntry(existing, entry)) {
      out.push({
        key: changeKey('changed', existing, entry),
        kind: 'changed',
        current: existing,
        proposed: entry
      })
    }
  }
  for (const [key, entry] of currentByKey) {
    if (!proposedByKey.has(key)) {
      out.push({ key: changeKey('removed', entry, undefined), kind: 'removed', current: entry })
    }
  }
  return out
}

/** Applies one entry change to a list, preserving position where it can. */
export function applyChange(entries: Entry[], change: EntryChange): Entry[] {
  // Located by the entry itself, not by key. Keys exist to name a decision
  // across a render; positions shift as soon as one decision is applied, and
  // an entry is the only thing that stays itself.
  const at = change.current ? entries.findIndex((e) => sameEntry(e, change.current)) : -1
  if (change.kind === 'removed') return at === -1 ? entries : entries.filter((_, i) => i !== at)
  if (at === -1) return [...entries, change.proposed!]
  return entries.map((e, i) => (i === at ? change.proposed! : e))
}

export const entryLabel = (entry: Entry | undefined): string => {
  if (!entry) return ''
  for (const field of ['when', 'date', 'title', 'id'] as const) {
    const v = entry[field]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return '(event)'
}

