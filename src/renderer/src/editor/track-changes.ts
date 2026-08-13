import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { StepMap } from '@tiptap/pm/transform'
import type { Node as PMNode } from '@tiptap/pm/model'
import { ChangeSet, simplifyChanges, type Change } from 'prosemirror-changeset'
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

function diffChangeSet(original: PMNode, current: PMNode): ChangeSet {
  const map = new StepMap([0, original.content.size, current.content.size])
  return ChangeSet.create(original).addSteps(current, [map], null)
}

function visibleChanges(state: TrackState, doc: PMNode): Change[] {
  const simplified = simplifyChanges(state.set.changes, doc)
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
              if (fromB < toB) {
                decos.push(Decoration.inline(fromB, toB, { class: 'tc-ins' }))
              }
              if (fromA < toA) {
                const text = track.original.textBetween(fromA, toA, ' ¶ ')
                if (text) {
                  decos.push(
                    Decoration.widget(fromB, () => deletionWidget(text), { side: -1 })
                  )
                }
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
