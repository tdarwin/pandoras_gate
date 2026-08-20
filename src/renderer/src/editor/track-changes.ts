import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { StepMap } from '@tiptap/pm/transform'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Change, ChangeSet, simplifyChanges, type TokenEncoder } from 'prosemirror-changeset'
import { markdownToDoc } from './markdown'

/**
 * Tracked-changes review inside the WYSIWYG editor. The document being
 * edited is the PROPOSAL; the extension holds the on-disk ORIGINAL and
 * renders the difference as suggestions — insertions highlighted, deletions
 * as struck-through inline widgets — each chunk with ✓/✕ controls.
 *
 * Mechanics (prosemirror-changeset):
 * - The initial ChangeSet comes from a whole-doc replace map; changeset's
 *   computeDiff minimizes it to fine-grained changes.
 * - User edits stream through addSteps, so typing during review is tracked
 *   against the original like any other suggested change.
 * - REJECT replaces the chunk with the original's slice; the re-diff sees
 *   identical content and the change evaporates. Undo brings it back.
 * - ACCEPT records the range as resolved (remapped through later edits);
 *   the content is already in the doc, so accepting only clears the badges.
 *   "Apply" in the surrounding UI serializes the current doc — unclicked
 *   chunks therefore default to accepted, matching the old merge view.
 */

interface TrackState {
  original: PMNode
  set: ChangeSet
  /** Ranges (in current-doc coordinates) the author explicitly accepted. */
  accepted: { from: number; to: number }[]
}

interface TrackMeta {
  accept?: { from: number; to: number }
  acceptAll?: boolean
}

export const trackChangesKey = new PluginKey<TrackState>('trackChanges')

/**
 * The default changeset encoder compares node tokens by TYPE only, so a
 * styled block's alignment change or an image swap (same node type, new
 * attrs) diffed as "no change" — invisible in review and immune to reject.
 * Attrs are folded into the start tokens instead. Character tokens keep the
 * default mark-blind encoding: surfacing every bold/italic toggle as a
 * reviewable change is a separate (pre-existing) question.
 */
const attrsAwareEncoder: TokenEncoder<string | number> = {
  encodeCharacter: (char) => char,
  encodeNodeStart: (node) => {
    for (const key in node.attrs) {
      if (node.attrs[key] !== null) return node.type.name + JSON.stringify(node.attrs)
    }
    return node.type.name
  },
  encodeNodeEnd: (node) => `/${node.type.name}`,
  compareTokens: (a, b) => a === b
}

function diffChangeSet(original: PMNode, current: PMNode): ChangeSet {
  const map = new StepMap([0, original.content.size, current.content.size])
  return ChangeSet.create(original, undefined, attrsAwareEncoder).addSteps(current, [map], null)
}

/** The styled block containing (or starting at) pos, as [from, to]. */
function styledBlockRangeAt(doc: PMNode, pos: number): [number, number] | null {
  const $pos = doc.resolve(Math.min(pos, doc.content.size))
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'styledBlock') return [$pos.before(d), $pos.after(d)]
  }
  const node = pos < doc.content.size ? doc.nodeAt(pos) : null
  if (node?.type.name === 'styledBlock') return [pos, pos + node.nodeSize]
  return null
}

/**
 * A styled-block wrap, unwrap, or attribute change surfaces as token-level
 * changes carrying no text (the open/close tokens themselves). Individually
 * those are unactionable — rejecting just an open token would splice half a
 * wrap — so all structural changes belonging to one styled block merge into
 * a single change spanning the whole block, which then displays, accepts,
 * and rejects as a unit. Blocks that also contain text changes are left
 * alone; their chunks already carry the story.
 */
function mergeBlockStructuralChanges(changes: Change[], original: PMNode, doc: PMNode): Change[] {
  const structural = (c: Change): boolean =>
    doc.textBetween(c.fromB, c.toB, ' ') === '' && original.textBetween(c.fromA, c.toA, ' ') === ''

  const groups = new Map<number, { range: [number, number]; members: Change[] }>()
  for (const change of changes) {
    if (!structural(change)) continue
    const range = styledBlockRangeAt(doc, change.fromB)
    if (!range) continue
    const group = groups.get(range[0]) ?? { range, members: [] }
    group.members.push(change)
    groups.set(range[0], group)
  }

  const out: Change[] = []
  const merged = new Set<Change>()
  const replacements: Change[] = []
  for (const { range, members } of groups.values()) {
    const blockHasTextChange = changes.some(
      (c) => !structural(c) && c.fromB < range[1] && c.toB > range[0]
    )
    if (blockHasTextChange) continue
    const fromB = range[0]
    const toB = range[1]
    const first = members[0]!
    const last = members[members.length - 1]!
    // Widen the A range by the same margins the B range gained, clamped —
    // with no text changes inside, the surrounding content is identical.
    const fromA = Math.max(0, first.fromA - (first.fromB - fromB))
    const toA = Math.min(original.content.size, last.toA + (toB - last.toB))
    for (const m of members) merged.add(m)
    replacements.push(
      Change.fromJSON({
        fromA,
        toA,
        fromB,
        toB,
        deleted: toA > fromA ? [{ length: toA - fromA, data: null }] : [],
        inserted: toB > fromB ? [{ length: toB - fromB, data: null }] : []
      })
    )
  }
  if (replacements.length === 0) return changes
  for (const change of changes) {
    if (!merged.has(change)) out.push(change)
  }
  out.push(...replacements)
  return out.sort((a, b) => a.fromB - b.fromB)
}

function visibleChanges(state: TrackState, doc: PMNode): Change[] {
  const simplified = mergeBlockStructuralChanges(
    simplifyChanges(state.set.changes, doc),
    state.original,
    doc
  )
  if (state.accepted.length === 0) return simplified
  return simplified.filter(
    (c) => !state.accepted.some((a) => c.fromB >= a.from && c.toB <= a.to)
  )
}

function deletionWidget(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'tc-del'
  span.setAttribute('contenteditable', 'false')
  span.textContent = text
  return span
}

function controlsWidget(
  accept: (pos: number) => void,
  reject: (pos: number) => void,
  pos: number
): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'tc-ctrl'
  wrap.setAttribute('contenteditable', 'false')
  const mk = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    // mousedown would steal the selection; act without focusing.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      onClick()
    })
    return b
  }
  wrap.appendChild(mk('✓', 'Accept this change', () => accept(pos)))
  wrap.appendChild(mk('✕', 'Reject this change', () => reject(pos)))
  return wrap
}

export interface TrackChangesOptions {
  /** Markdown of the on-disk document the proposal is diffed against. */
  original: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      /** Accept the suggested change containing the given position. */
      acceptChangeAt: (pos: number) => ReturnType
      /** Reject the suggested change containing the given position. */
      rejectChangeAt: (pos: number) => ReturnType
      acceptAllChanges: () => ReturnType
      rejectAllChanges: () => ReturnType
    }
  }
}

/** Unresolved suggested changes, simplified to display chunks. */
export function pendingChanges(state: EditorState): Change[] {
  const track = trackChangesKey.getState(state)
  return track ? visibleChanges(track, state.doc) : []
}

/** Number of unresolved suggested changes (for badges/tests). */
export function pendingChangeCount(state: EditorState): number {
  return pendingChanges(state).length
}

export const TrackChanges = Extension.create<TrackChangesOptions>({
  name: 'trackChanges',

  addOptions() {
    return { original: '' }
  },

  addCommands() {
    const findChange = (
      state: { doc: PMNode },
      pos: number
    ): { change: Change; track: TrackState } | null => {
      const track = trackChangesKey.getState(state as never)
      if (!track) return null
      const change = visibleChanges(track, state.doc).find(
        (c) => pos >= c.fromB && pos <= Math.max(c.toB, c.fromB)
      )
      return change ? { change, track } : null
    }

    return {
      acceptChangeAt:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const found = findChange(state, pos)
          if (!found) return false
          if (dispatch) {
            const { fromB, toB } = found.change
            tr.setMeta(trackChangesKey, {
              accept: { from: fromB, to: Math.max(toB, fromB) }
            } satisfies TrackMeta)
            dispatch(tr)
          }
          return true
        },
      rejectChangeAt:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const found = findChange(state, pos)
          if (!found) return false
          if (dispatch) {
            const { fromA, toA, fromB, toB } = found.change
            tr.replace(fromB, toB, found.track.original.slice(fromA, toA))
            dispatch(tr)
          }
          return true
        },
      acceptAllChanges:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(trackChangesKey, { acceptAll: true } satisfies TrackMeta)
            dispatch(tr)
          }
          return true
        },
      rejectAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const track = trackChangesKey.getState(state)
          if (!track) return false
          if (dispatch) {
            // Descending order keeps earlier positions valid within one tr.
            const changes = [...visibleChanges(track, state.doc)].sort(
              (a, b) => b.fromB - a.fromB
            )
            for (const c of changes) {
              tr.replace(c.fromB, c.toB, track.original.slice(c.fromA, c.toA))
            }
            dispatch(tr)
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const originalMarkdown = this.options.original

    return [
      new Plugin<TrackState>({
        key: trackChangesKey,
        state: {
          init: (_config, state) => {
            const original = markdownToDoc(state.schema, originalMarkdown)
            return { original, set: diffChangeSet(original, state.doc), accepted: [] }
          },
          apply: (tr, value, _old, newState) => {
            let { set, accepted } = value
            const meta = tr.getMeta(trackChangesKey) as TrackMeta | undefined
            if (tr.docChanged) {
              set = set.addSteps(newState.doc, tr.mapping.maps, null)
              accepted = accepted.map((r) => ({
                from: tr.mapping.map(r.from, -1),
                to: tr.mapping.map(r.to, 1)
              }))
            }
            if (meta?.acceptAll) {
              accepted = [{ from: 0, to: newState.doc.content.size }]
            } else if (meta?.accept) {
              accepted = [...accepted, meta.accept]
            }
            return { original: value.original, set, accepted }
          }
        },
        props: {
          decorations(state) {
            const track = trackChangesKey.getState(state)
            if (!track) return DecorationSet.empty
            const accept = (pos: number): void => {
              editor.chain().acceptChangeAt(pos).focus().run()
            }
            const reject = (pos: number): void => {
              editor.chain().rejectChangeAt(pos).focus().run()
            }
            const decos: Decoration[] = []
            for (const change of visibleChanges(track, state.doc)) {
              const { fromA, toA, fromB, toB } = change
              const insText = fromB < toB ? state.doc.textBetween(fromB, toB, ' ¶ ') : ''
              const delText = fromA < toA ? track.original.textBetween(fromA, toA, ' ¶ ') : ''
              // Identical text on both sides means the chunk is structural —
              // a styled-block attribute, a wrap/unwrap. Struck-through
              // "deleted" text identical to the highlighted text would read
              // as nonsense, so mark the range as a formatting change.
              const formattingOnly = insText !== '' && insText === delText
              if (fromB < toB) {
                decos.push(
                  Decoration.inline(
                    fromB,
                    toB,
                    formattingOnly
                      ? { class: 'tc-attr', title: 'Formatting change' }
                      : { class: 'tc-ins' }
                  )
                )
              }
              if (!formattingOnly && delText) {
                decos.push(
                  Decoration.widget(fromB, () => deletionWidget(delText), { side: -1 })
                )
              }
              decos.push(
                Decoration.widget(
                  Math.max(toB, fromB),
                  () => controlsWidget(accept, reject, fromB),
                  { side: 1 }
                )
              )
            }
            return DecorationSet.create(state.doc, decos)
          }
        }
      })
    ]
  }
})
