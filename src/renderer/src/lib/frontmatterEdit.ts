/**
 * Frontmatter suggestions, field by field.
 *
 * The body has tracked changes; the details strip has these. Both follow the
 * same rule: accepting is an ordinary edit to the document (the author could
 * have typed it themselves), and rejecting has to be recorded, because
 * "proposed still differs from current" is otherwise indistinguishable from
 * "not decided yet" and the suggestion would come back forever.
 */

import { sameEntry } from './timelineEntries'

export interface FieldSuggestion {
  key: string
  /** The current value; undefined when the proposal adds the field. */
  current?: unknown
  /** The proposed value; undefined when the proposal removes the field. */
  proposed?: unknown
  /** Where it came from, for the tooltip. */
  sourceLabel: string
}

// Key-order-insensitive, like the timeline's: a proposal re-emitting a
// structured value with its keys in another order is not a suggestion, and
// treating it as one kept the item pending on a field nobody changed.
const same = sameEntry

/** Fields a proposal still suggests: not already matching, not rejected. */
export function fieldSuggestions(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
  rejected: readonly string[],
  sourceLabel: string
): FieldSuggestion[] {
  const out: FieldSuggestion[] = []
  const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])]
  for (const key of keys) {
    if (rejected.includes(key)) continue
    const has = key in proposed
    if (same(current[key], proposed[key]) && has === key in current) continue
    out.push({
      key,
      ...(key in current ? { current: current[key] } : {}),
      ...(has ? { proposed: proposed[key] } : {}),
      sourceLabel
    })
  }
  return out
}

/** The data after accepting one field's suggestion. */
export function withField(
  data: Record<string, unknown>,
  key: string,
  value: unknown | undefined
): Record<string, unknown> {
  const next = { ...data }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/**
 * The frontmatter one proposal still proposes: everything decided, plus its
 * own fields that are neither accepted (already equal) nor rejected.
 */
export function remainingData(
  decided: Record<string, unknown>,
  proposed: Record<string, unknown>,
  rejected: readonly string[]
): Record<string, unknown> {
  let out = { ...decided }
  for (const s of fieldSuggestions(decided, proposed, rejected, '')) {
    out = withField(out, s.key, s.proposed)
  }
  return out
}
