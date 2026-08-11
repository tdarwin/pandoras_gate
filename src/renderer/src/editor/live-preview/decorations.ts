import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { parseFrontmatter } from '@shared/frontmatter'

/**
 * Live-preview decorations, Obsidian-style:
 *  - markdown syntax (heading marks, emphasis delimiters, link targets, …)
 *    is hidden and the content styled as it will read,
 *  - EXCEPT on lines the selection touches, where raw markdown is revealed
 *    so the syntax stays editable.
 */

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('hr')
    hr.className = 'cm-lp-hr'
    return hr
  }
  override ignoreEvent(): boolean {
    return false
  }
}

class FrontmatterWidget extends WidgetType {
  constructor(private readonly raw: string) {
    super()
  }
  override eq(other: FrontmatterWidget): boolean {
    return other.raw === this.raw
  }
  toDOM(): HTMLElement {
    const { data } = parseFrontmatter(this.raw)
    const el = document.createElement('div')
    el.className = 'cm-lp-frontmatter'
    const title = typeof data['title'] === 'string' && data['title'] ? data['title'] : 'Chapter'
    const status = typeof data['status'] === 'string' ? data['status'] : ''
    el.textContent = title
    if (status) {
      const chip = document.createElement('span')
      chip.className = `cm-lp-status cm-lp-status-${status}`
      chip.textContent = status
      el.appendChild(chip)
    }
    el.title = 'Click to edit chapter metadata'
    return el
  }
  override ignoreEvent(): boolean {
    return false
  }
}

const hide = Decoration.replace({})
const hrWidget = Decoration.replace({ widget: new HorizontalRuleWidget() })

const headingLine = (level: number): Decoration =>
  Decoration.line({ class: `cm-lp-heading cm-lp-h${level}` })
const quoteLine = Decoration.line({ class: 'cm-lp-blockquote' })

const strong = Decoration.mark({ class: 'cm-lp-strong' })
const emphasis = Decoration.mark({ class: 'cm-lp-em' })
const strikethrough = Decoration.mark({ class: 'cm-lp-strike' })
const inlineCode = Decoration.mark({ class: 'cm-lp-code' })
const linkText = Decoration.mark({ class: 'cm-lp-link' })
const listBullet = Decoration.mark({ class: 'cm-lp-bullet' })

interface LineRange {
  from: number
  to: number
}

/** Lines (expanded to full line boundaries) that any selection range touches. */
function revealedRanges(state: EditorState): LineRange[] {
  const ranges: LineRange[] = []
  for (const sel of state.selection.ranges) {
    const fromLine = state.doc.lineAt(sel.from)
    const toLine = state.doc.lineAt(sel.to)
    ranges.push({ from: fromLine.from, to: toLine.to })
  }
  return ranges
}

function isRevealed(ranges: LineRange[], from: number, to: number): boolean {
  return ranges.some((r) => from <= r.to && to >= r.from)
}

export interface LivePreviewSets {
  decorations: DecorationSet
  /**
   * Replace decorations only — registered as atomic ranges so the cursor
   * steps over hidden syntax instead of getting trapped inside it (the cause
   * of caret "bouncing" between lines).
   */
  atomic: DecorationSet
}

/**
 * Pure decoration computation over an EditorState — exported separately from
 * the ViewPlugin so tests can exercise it without a DOM.
 */
export function computeDecorations(state: EditorState, visible: LineRange[]): LivePreviewSets {
  const builder = new RangeSetBuilder<Decoration>()
  const atomicBuilder = new RangeSetBuilder<Decoration>()
  const revealed = revealedRanges(state)
  const doc = state.doc

  // Collected per-node decorations must be added to the builder in document
  // order, so gather first, sort, then emit.
  const marks: { from: number; to: number; deco: Decoration }[] = []
  const add = (from: number, to: number, deco: Decoration): void => {
    marks.push({ from, to, deco })
  }

  // Frontmatter: fold the leading YAML block into a summary widget, and keep
  // markdown decorations out of it entirely (its "---" lines otherwise parse
  // as headings/rules and render nonsense).
  let fmEnd = 0
  const head = doc.sliceString(0, Math.min(doc.length, 4000))
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(head)
  if (fm) {
    fmEnd = fm[0].length
    if (!isRevealed(revealed, 0, fmEnd)) {
      add(
        0,
        fmEnd,
        Decoration.replace({ widget: new FrontmatterWidget(fm[0] + '\n'), block: true })
      )
    }
  }

  for (const { from, to } of visible) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        // Skip everything inside the frontmatter block.
        if (fmEnd > 0 && node.name !== 'Document' && node.to <= fmEnd) return false
        switch (node.name) {
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6': {
            const level = Number(node.name.slice(-1))
            const line = doc.lineAt(node.from)
            add(line.from, line.from, headingLine(level))
            if (!isRevealed(revealed, node.from, node.to)) {
              // Hide the "### " prefix (HeaderMark plus the following space).
              const mark = node.node.getChild('HeaderMark')
              if (mark) {
                const spaceEnd = Math.min(mark.to + 1, line.to)
                add(mark.from, spaceEnd, hide)
              }
            }
            break
          }
          case 'SetextHeading1':
          case 'SetextHeading2': {
            const level = Number(node.name.slice(-1))
            const line = doc.lineAt(node.from)
            add(line.from, line.from, headingLine(level))
            break
          }
          case 'StrongEmphasis': {
            add(node.from, node.to, strong)
            if (!isRevealed(revealed, node.from, node.to)) {
              add(node.from, node.from + 2, hide)
              add(node.to - 2, node.to, hide)
            }
            break
          }
          case 'Emphasis': {
            add(node.from, node.to, emphasis)
            if (!isRevealed(revealed, node.from, node.to)) {
              add(node.from, node.from + 1, hide)
              add(node.to - 1, node.to, hide)
            }
            break
          }
          case 'Strikethrough': {
            add(node.from, node.to, strikethrough)
            if (!isRevealed(revealed, node.from, node.to)) {
              add(node.from, node.from + 2, hide)
              add(node.to - 2, node.to, hide)
            }
            break
          }
          case 'InlineCode': {
            add(node.from, node.to, inlineCode)
            if (!isRevealed(revealed, node.from, node.to)) {
              const n = node.node
              const firstMark = n.firstChild
              const lastMark = n.lastChild
              if (firstMark?.name === 'CodeMark') add(firstMark.from, firstMark.to, hide)
              if (lastMark?.name === 'CodeMark' && lastMark.from > node.from)
                add(lastMark.from, lastMark.to, hide)
            }
            break
          }
          case 'Link': {
            const n = node.node
            const revealedHere = isRevealed(revealed, node.from, node.to)
            // [text](url) -> show styled text only.
            const linkMarks = n.getChildren('LinkMark')
            const url = n.getChild('URL')
            if (!revealedHere) {
              for (const m of linkMarks) add(m.from, m.to, hide)
              if (url) {
                // Hide "(url)" — from the closing "]" mark's end to node end.
                const closeBracket = linkMarks[1]
                const start = closeBracket ? closeBracket.to : url.from
                add(start, node.to, hide)
              }
            }
            const open = linkMarks[0]
            const close = linkMarks[1]
            if (open && close) add(open.to, close.from, linkText)
            break
          }
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to; ) {
              const line = doc.lineAt(pos)
              add(line.from, line.from, quoteLine)
              if (!isRevealed(revealed, line.from, line.to)) {
                const text = line.text
                const m = /^\s*>\s?/.exec(text)
                if (m) add(line.from, line.from + m[0].length, hide)
              }
              if (line.to >= node.to) break
              pos = line.to + 1
            }
            break
          }
          case 'ListMark': {
            add(node.from, node.to, listBullet)
            break
          }
          case 'HorizontalRule': {
            if (!isRevealed(revealed, node.from, node.to)) {
              add(node.from, node.to, hrWidget)
            }
            break
          }
        }
        return undefined
      }
    })
  }

  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  // RangeSetBuilder requires strictly ordered, and line decorations must come
  // before marks at the same position — the sort above plus stable insertion
  // keeps that invariant.
  const isReplace = (deco: Decoration): boolean =>
    deco === hide || deco.spec['widget'] !== undefined
  for (const m of marks) {
    builder.add(m.from, m.to, m.deco)
    if (isReplace(m.deco) && m.from < m.to) atomicBuilder.add(m.from, m.to, m.deco)
  }
  return { decorations: builder.finish(), atomic: atomicBuilder.finish() }
}

class LivePreviewPluginValue {
  decorations: DecorationSet
  atomic: DecorationSet

  constructor(view: EditorView) {
    const sets = this.safeCompute(view)
    this.decorations = sets.decorations
    this.atomic = sets.atomic
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      const sets = this.safeCompute(update.view)
      this.decorations = sets.decorations
      this.atomic = sets.atomic
    }
  }

  /** Decoration bugs must degrade to plain markdown, never a blank app. */
  private safeCompute(view: EditorView): LivePreviewSets {
    try {
      return computeDecorations(view.state, [...view.visibleRanges])
    } catch (err) {
      console.error('live-preview decoration failure', err)
      return { decorations: Decoration.none, atomic: Decoration.none }
    }
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPluginValue, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
})
