// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { NovelState } from '@shared/schemas/project'

/**
 * The draft store must stream into ITS chapter no matter what is open in the
 * editor — switching chapters mid-draft used to splice AI prose into whichever
 * file was active and commit it there.
 */

type Handler = (payload: unknown) => void

let handlers: Record<string, Handler>
let invokes: { channel: string; payload: Record<string, unknown> }[]

function stubBridge(): void {
  handlers = {}
  invokes = []
  ;(window as unknown as { pandora: unknown }).pandora = {
    invoke: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      invokes.push({ channel, payload })
      return { ok: true, data: { saved: true, snapshotted: false } }
    }),
    on: vi.fn((channel: string, cb: Handler) => {
      handlers[channel] = cb
      return () => {}
    })
  }
}

const NOVEL = { dir: '/tmp/novel' } as unknown as NovelState
const DRAFT_FILE = 'chapters/001-target.md'
const OTHER_FILE = 'chapters/002-elsewhere.md'

// Fresh module graph per test: the stores keep module-level latches.
async function loadStores(): Promise<{
  draft: typeof import('./draft')
  project: typeof import('./project')
}> {
  vi.resetModules()
  const project = await import('./project')
  const draft = await import('./draft')
  return { draft, project }
}

beforeEach(() => {
  vi.useFakeTimers()
  stubBridge()
})

afterEach(() => {
  vi.useRealTimers()
})

async function primeMidDraft(activeFile: string): Promise<{
  draft: typeof import('./draft')
  project: typeof import('./project')
}> {
  const stores = await loadStores()
  stores.project.useProjectStore.setState({
    novel: NOVEL,
    activeFile,
    content: activeFile === DRAFT_FILE ? 'Draft start. ' : 'Other chapter text.',
    dirty: false
  })
  stores.draft.useDraftStore.getState().init()
  stores.draft.useDraftStore.setState({
    drafting: true,
    requestId: 'req-1',
    draftFile: DRAFT_FILE,
    draftContent: 'Draft start. '
  })
  return stores
}

describe('draft streaming targets the draft file', () => {
  it('appends deltas to draftContent and writes them to the DRAFT file while another chapter is open', async () => {
    const { draft, project } = await primeMidDraft(OTHER_FILE)
    handlers['chat:event']!({ requestId: 'req-1', event: { type: 'delta', text: 'More prose.' } })

    expect(draft.useDraftStore.getState().draftContent).toBe('Draft start. More prose.')
    // The open chapter's buffer is untouched.
    expect(project.useProjectStore.getState().content).toBe('Other chapter text.')

    await vi.advanceTimersByTimeAsync(800)
    const write = invokes.find((c) => c.channel === 'chapter:write')
    expect(write).toBeDefined()
    expect(write!.payload.file).toBe(DRAFT_FILE)
    expect(write!.payload.content).toBe('Draft start. More prose.')
  })

  it('mirrors deltas into the buffer when the draft chapter IS open', async () => {
    const { project } = await primeMidDraft(DRAFT_FILE)
    handlers['chat:event']!({ requestId: 'req-1', event: { type: 'delta', text: 'More prose.' } })
    expect(project.useProjectStore.getState().content).toBe('Draft start. More prose.')
    expect(project.useProjectStore.getState().dirty).toBe(false)
  })

  it('finishes against the draft file, not the active one', async () => {
    const { draft } = await primeMidDraft(OTHER_FILE)
    handlers['chat:event']!({ requestId: 'req-1', event: { type: 'delta', text: 'End.' } })
    handlers['chat:event']!({ requestId: 'req-1', event: { type: 'done', finishReason: 'stop' } })
    await vi.advanceTimersByTimeAsync(10)

    const finish = invokes.find((c) => c.channel === 'draft:finish')
    expect(finish).toBeDefined()
    expect(finish!.payload.chapterFile).toBe(DRAFT_FILE)
    // The final text reached the draft file before the finish commit.
    const lastWrite = [...invokes].reverse().find((c) => c.channel === 'chapter:write')
    expect(lastWrite!.payload.file).toBe(DRAFT_FILE)
    expect(lastWrite!.payload.content).toBe('Draft start. End.')
    expect(invokes.indexOf(lastWrite!)).toBeLessThan(invokes.indexOf(finish!))
    expect(draft.useDraftStore.getState().drafting).toBe(false)
    expect(draft.useDraftStore.getState().draftFile).toBeNull()
  })

  it('resyncs the buffer from the store when the author returns to the draft chapter', async () => {
    const { project } = await primeMidDraft(OTHER_FILE)
    handlers['chat:event']!({ requestId: 'req-1', event: { type: 'delta', text: 'Streamed.' } })
    // Simulate openChapter loading a stale disk read of the draft chapter.
    project.useProjectStore.setState({ activeFile: DRAFT_FILE, content: 'stale disk read' })
    expect(project.useProjectStore.getState().content).toBe('Draft start. Streamed.')
  })

  it('ignores deltas for a foreign requestId', async () => {
    const { draft } = await primeMidDraft(OTHER_FILE)
    handlers['chat:event']!({ requestId: 'other', event: { type: 'delta', text: 'Nope.' } })
    expect(draft.useDraftStore.getState().draftContent).toBe('Draft start. ')
  })

  it('shows transient status lines without touching the text', async () => {
    const { draft } = await primeMidDraft(OTHER_FILE)
    handlers['chat:event']!({
      requestId: 'req-1',
      event: { type: 'status', text: 'Waiting for the current generation to finish…' }
    })
    expect(draft.useDraftStore.getState().status).toContain('Waiting')
    expect(draft.useDraftStore.getState().draftContent).toBe('Draft start. ')
  })
})
