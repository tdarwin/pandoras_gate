// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NovelState } from '@shared/schemas/project'
import type { EditorHandle } from '../editor/MarkdownEditor'

/**
 * Saving a document that has suggestions must RECORD decisions, not write the
 * buffer over them — and the two documents it sends (what goes on disk, what
 * each proposal still proposes) both come from the editor, recomputed rather
 * than patched, so a crash mid-review leaves nothing to reconcile.
 */

type Handler = (payload: unknown) => void
type Invoke = { channel: string; payload: Record<string, unknown> }

let handlers: Record<string, Handler>
let invokes: Invoke[]
let responses: Record<string, unknown>

function stubBridge(): void {
  handlers = {}
  invokes = []
  responses = {}
  ;(window as unknown as { pandora: unknown }).pandora = {
    invoke: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      invokes.push({ channel, payload })
      return { ok: true, data: responses[channel] ?? {} }
    }),
    on: vi.fn((channel: string, cb: Handler) => {
      handlers[channel] = cb
      return () => {}
    })
  }
}

const NOVEL = { dir: '/tmp/novel' } as unknown as NovelState
const PATH = 'metadata/characters/kael-voss.md'
const CURRENT = '---\nname: Kael\n---\nAlpha.\n\nBeta.\n'

async function loadStores(): Promise<{
  proposals: typeof import('./proposals')
  project: typeof import('./project')
}> {
  vi.resetModules()
  const project = await import('./project')
  const proposals = await import('./proposals')
  return { proposals, project }
}

/** An editor that has decided the first hunk and left the second pending. */
function fakeHandle(savableBody: string, proposedBody: Record<string, string>): EditorHandle {
  return {
    proposedBody: (id: string) => proposedBody[id] ?? savableBody,
    suggestionCount: () => Object.keys(proposedBody).length,
    acceptAllSuggestions: vi.fn(),
    rejectAllSuggestions: vi.fn(),
    goToNextSuggestion: () => false,
    attachSuggestions: vi.fn(),
    detachSuggestions: vi.fn()
  } as unknown as EditorHandle
}

beforeEach(stubBridge)

describe('pending suggestions', () => {
  it('builds a path-keyed index whose identity survives unrelated updates', async () => {
    const { proposals, project } = await loadStores()
    project.useProjectStore.setState({ novel: NOVEL })
    responses['proposals:pending'] = {
      docs: [
        { path: PATH, action: 'create', count: 2, sources: ['Codex update'], blocked: 0 },
        { path: 'metadata/synopsis.md', action: 'update', count: 1, sources: ['Ch. 3'], blocked: 1 }
      ]
    }
    await proposals.useProposalsStore.getState().refresh()

    const first = proposals.useProposalsStore.getState().pendingByPath
    expect(first.get(PATH)?.count).toBe(2)
    expect(proposals.useProposalsStore.getState().pendingTotal).toBe(3)

    // The sidebar subscribes to this Map. A pipeline run ticking its status
    // must not hand it a new one, or every row re-renders per status line.
    proposals.useProposalsStore.setState({ runningStatus: 'Reading…' })
    expect(proposals.useProposalsStore.getState().pendingByPath).toBe(first)
  })

  it('clears when the novel changes', async () => {
    const { proposals, project } = await loadStores()
    project.useProjectStore.setState({ novel: NOVEL })
    responses['proposals:pending'] = {
      docs: [{ path: PATH, action: 'create', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    proposals.useProposalsStore.getState().init()
    await proposals.useProposalsStore.getState().refresh()
    expect(proposals.useProposalsStore.getState().pendingTotal).toBe(1)

    // Workspace stays mounted across File → Open Recent.
    project.useProjectStore.getState().setNovel({ dir: '/tmp/other' } as unknown as NovelState)
    expect(proposals.useProposalsStore.getState().pendingTotal).toBe(0)
    expect(proposals.useProposalsStore.getState().active).toBeNull()
  })
})

describe('saving a document with suggestions', () => {
  async function setUp(): Promise<Awaited<ReturnType<typeof loadStores>>> {
    const stores = await loadStores()
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: PATH })
    responses['proposals:pending'] = {
      docs: [{ path: PATH, action: 'update', count: 2, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: CURRENT,
      chain: [
        {
          proposalId: 'p1',
          sourceTitle: 'Codex update',
          rationale: 'Tighten',
          content: '---\nname: Kael\n---\nAlpha edited.\n\nBeta edited.\n'
        }
      ],
      blocked: []
    }
    responses['proposals:apply'] = { content: null, remaining: 1 }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()
    // The overlay is on the editor; without that the editor cannot speak for
    // the proposals and nothing is decided.
    stores.proposals.useProposalsStore.getState().setShown(true)
    return stores
  }

  it('sends the decided document and what is still proposed, in one call', async () => {
    const { proposals, project } = await setUp()
    expect(proposals.useProposalsStore.getState().active?.chain).toHaveLength(1)

    // The author accepted the first hunk and has not decided the second.
    proposals.setSuggestionHandle(
      fakeHandle('Alpha edited.\n\nBeta.\n', { p1: 'Alpha edited.\n\nBeta edited.\n' })
    )
    project.useProjectStore
      .getState()
      .setContent('---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    const apply = invokes.filter((i) => i.channel === 'proposals:apply')
    expect(apply).toHaveLength(1)
    // Never a bare chapter:write — that would put the undecided suggestion on
    // disk, or wipe the stored proposal, depending on which way the buffer went.
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)

    const payload = apply[0]!.payload as {
      write: string
      expectedCurrent: string
      decisions: { proposalId: string; newContent: string }[]
    }
    // Only the accepted hunk goes to disk.
    expect(payload.write).toContain('Alpha edited.')
    expect(payload.write).toContain('\nBeta.\n')
    expect(payload.write).not.toContain('Beta edited.')
    expect(payload.expectedCurrent).toBe(CURRENT)
    // And what is left stays a suggestion.
    expect(payload.decisions).toHaveLength(1)
    expect(payload.decisions[0]!.newContent).toContain('Beta edited.')
  })

  it('echoes back what main wrote, so the next save is not refused as stale', async () => {
    const { proposals, project } = await setUp()
    const written = '---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n'
    responses['proposals:apply'] = { content: written, remaining: 1 }
    proposals.setSuggestionHandle(fakeHandle('Alpha edited.\n\nBeta.\n', { p1: written }))
    project.useProjectStore.getState().setContent(written)
    await project.useProjectStore.getState().saveActiveChapter()

    expect(proposals.useProposalsStore.getState().active?.current).toBe(written)
    expect(project.useProjectStore.getState().dirty).toBe(false)
  })

  it('falls back to an ordinary write when main refuses, so typing is never lost', async () => {
    const { proposals, project } = await setUp()
    proposals.setSuggestionHandle(fakeHandle('Alpha edited.\n\nBeta.\n', { p1: CURRENT }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nMy own words.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(true)
    const write = invokes.find((i) => i.channel === 'chapter:write')
    expect(write?.payload.content).toContain('My own words.')
    expect(project.useProjectStore.getState().lastError).toMatch(/changed while you were reviewing/)
  })

  it('decides nothing while the overlay is deferred', async () => {
    const { proposals, project } = await setUp()
    // The author is typing, so the strip is offering "Show" and the plugin has
    // nothing attached — the editor would report every proposal as proposing
    // exactly what the file says, and main would resolve the lot.
    proposals.useProposalsStore.getState().setShown(false)
    proposals.setSuggestionHandle(fakeHandle(CURRENT, { p1: CURRENT }))
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nAlpha.\n\nBeta typed.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    const apply = invokes.filter((i) => i.channel === 'proposals:apply')
    expect(apply).toHaveLength(1)
    expect((apply[0]!.payload as { decisions: unknown[] }).decisions).toEqual([])
    // …and the author's typing still reaches disk.
    expect((apply[0]!.payload as { write: string }).write).toContain('Beta typed.')
  })

  it('writes the author\u2019s own frontmatter, not the proposal\u2019s, until they choose', async () => {
    const { proposals, project } = await setUp()
    proposals.setSuggestionHandle(fakeHandle('Alpha.\n\nBeta.\n', { p1: 'Alpha edited.\n\nBeta.\n' }))
    // The author renamed the character in the details panel.
    project.useProjectStore.getState().setContent('---\nname: Kael the Younger\n---\nAlpha.\n\nBeta.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    const write = (invokes.find((i) => i.channel === 'proposals:apply')!.payload as { write: string })
      .write
    expect(write).toContain('Kael the Younger')
  })

  it('re-anchors to what the fallback wrote, so the next save is not refused again', async () => {
    const { proposals, project } = await setUp()
    proposals.setSuggestionHandle(fakeHandle('Alpha.\n', { p1: 'Alpha edited.\n' }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    const typed = '---\nname: Kael\n---\nMine.\n'
    project.useProjectStore.getState().setContent(typed)
    await project.useProjectStore.getState().saveActiveChapter()

    // The apply was refused and the buffer fell through to a plain write.
    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(true)
    expect(invokes.find((i) => i.channel === 'chapter:write')?.payload.content).toBe(typed)
    // `current` must describe what that write left on disk. Re-anchoring
    // before it (to the pre-fallback text) cost a second refusal and a second
    // toast for one external change.
    expect(proposals.useProposalsStore.getState().active?.current).toBe(typed)
  })

  it('re-anchors a write-less refusal, which has no fallback to learn from', async () => {
    const { proposals, project } = await setUp()
    // A clean-buffer reject: nothing to write, so nothing else runs afterwards
    // and a stale `current` would refuse every reject after it.
    proposals.setSuggestionHandle(fakeHandle(CURRENT, { p1: CURRENT }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    // A clean buffer is the precondition: persistDecisions exists for
    // decisions that leave the text alone.
    project.useProjectStore.getState().setSavedContent(CURRENT)
    await proposals.useProposalsStore.getState().persistDecisions()

    const apply = invokes.find((i) => i.channel === 'proposals:apply')!
    expect((apply.payload as { write: string | null }).write).toBeNull()
    expect(invokes.filter((i) => i.channel === 'chapter:write')).toHaveLength(0)
    // Nothing wrote, so the re-fold is the only way back to a usable anchor.
    expect(invokes.filter((i) => i.channel === 'proposals:forPath').length).toBeGreaterThan(1)
  })

  it('does not drop keystrokes typed while the apply is in flight', async () => {
    const { proposals, project } = await setUp()
    const written = '---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n'
    proposals.setSuggestionHandle(fakeHandle('Alpha edited.\n\nBeta.\n', { p1: written }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          // The author keeps typing during the round trip.
          project.useProjectStore.getState().setContent('---\nname: Kael\n---\nStill typing…\n')
          return { ok: true, data: { content: written, remaining: 1 } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    // Syncing the buffer to what main wrote would have erased the newer text.
    expect(project.useProjectStore.getState().content).toContain('Still typing…')
  })

  it('re-reads the file a write-less refusal proved stale', async () => {
    const { proposals, project } = await setUp()
    const external = '---\nname: Kael\n---\nSomeone else wrote this.\n'
    proposals.setSuggestionHandle(fakeHandle(CURRENT, { p1: CURRENT }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        if (channel === 'chapter:read') return { ok: true, data: { content: external } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setSavedContent(CURRENT)
    await proposals.useProposalsStore.getState().persistDecisions()

    // Re-anchoring `current` alone left the buffer holding the pre-change text
    // with nothing to say it was stale — and the next snapshot wrote it back
    // over the external edit, silently and without a toast.
    expect(project.useProjectStore.getState().content).toBe(external)
  })

  it('leaves a buffer that moved during the save dirty, so autosave still carries it', async () => {
    const { proposals, project } = await setUp()
    const written = '---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n'
    proposals.setSuggestionHandle(fakeHandle('Alpha edited.\n\nBeta.\n', { p1: written }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          project.useProjectStore.getState().setContent('---\nname: Kael\n---\nStill typing…\n')
          return { ok: true, data: { content: written, remaining: 1 } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    // The quiet 5 s write only runs on a dirty buffer, so clearing the flag
    // here left those keystrokes in memory behind a "saved" indicator.
    expect(project.useProjectStore.getState().dirty).toBe(true)
  })

  it('does not fall back to a plain write after a write-less refusal', async () => {
    const { proposals, project } = await setUp()
    const external = '---\nname: Kael\n---\nSomeone else wrote this.\n'
    proposals.setSuggestionHandle(fakeHandle(CURRENT, { p1: CURRENT }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        if (channel === 'chapter:read') return { ok: true, data: { content: external } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setSavedContent(CURRENT)

    // Reject All on the open document drives the editor and then snapshots.
    await project.useProjectStore.getState().snapshotActiveChapter()

    // The writer had nothing to write, so the fallback could only put the
    // pre-change text back over the edit main had just objected to — which is
    // how "Reject all" quietly reverted a change made outside the app.
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)
    expect(project.useProjectStore.getState().content).toBe(external)
  })

  it('leaving a document that does not exist yet writes nothing at all', async () => {
    const stores = await loadStores()
    const CREATE = 'metadata/characters/mara-din.md'
    const PROPOSED = '---\nname: Mara Din\n---\nSharp-eyed.\n'
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: CREATE })
    responses['proposals:pending'] = {
      docs: [{ path: CREATE, action: 'create', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: '',
      chain: [
        { proposalId: 'p1', sourceTitle: 'Codex update', rationale: 'New character', content: PROPOSED }
      ],
      blocked: []
    }
    responses['proposals:apply'] = { content: null, remaining: 1 }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()
    stores.proposals.useProposalsStore.getState().setShown(true)
    stores.proposals.setSuggestionHandle(fakeHandle('', { p1: 'Sharp-eyed.\n' }))

    // Navigating away, blurring, ⌘S and the interval snapshot all land here.
    await stores.project.useProjectStore.getState().snapshotActiveChapter()

    const apply = invokes.find((i) => i.channel === 'proposals:apply')!
    expect((apply.payload as { write: string | null }).write).toBeNull()
    // The apply wrote nothing, so there is nothing to snapshot. Following it
    // with chapter:write re-created exactly the stub the null write avoided.
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)
  })

  it('a rejected document that never existed does not materialise as an empty file', async () => {
    const stores = await loadStores()
    const CREATE = 'metadata/characters/mara-din.md'
    stores.project.useProjectStore.setState({ novel: NOVEL })
    responses['chapter:read'] = undefined
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'chapter:read') return { ok: false, error: { message: 'ENOENT' } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    await stores.project.useProjectStore.getState().openChapter(CREATE, { allowMissing: true })
    expect(stores.project.useProjectStore.getState().activeMissing).toBe(true)

    // The proposal was rejected, so there is no suggestion writer for the path
    // any more — and the plain fallback used to create the file regardless.
    stores.proposals.useProposalsStore.setState({ active: null })
    invokes.length = 0
    await stores.project.useProjectStore.getState().snapshotActiveChapter()
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)
    expect(stores.project.useProjectStore.getState().lastError).toBeNull()
  })

  it('reloads a created document, so the buffer it started empty with is not written back', async () => {
    const stores = await loadStores()
    const CREATE = 'metadata/characters/mara-din.md'
    const PROPOSED = '---\nname: Mara Din\n---\nSharp-eyed.\n'
    let onDisk: string | null = null
    stores.project.useProjectStore.setState({ novel: NOVEL })
    responses['proposals:pending'] = {
      docs: [{ path: CREATE, action: 'create', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:resolveAll'] = { applied: 1, skipped: 0, conflicts: [] }
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'chapter:read') {
          return onDisk === null
            ? { ok: false, error: { message: 'ENOENT' } }
            : { ok: true, data: { content: onDisk } }
        }
        // Accepting is what creates the file.
        if (channel === 'proposals:resolveAll') onDisk = PROPOSED
        if (channel === 'proposals:pending' && onDisk !== null) return { ok: true, data: { docs: [] } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    await stores.project.useProjectStore.getState().openChapter(CREATE, { allowMissing: true })
    stores.project.useProjectStore.getState().setContent('my own note')

    await stores.proposals.useProposalsStore.getState().resolveDoc(CREATE, 'accept')

    // Skipping the reload for every missing document skipped it after an
    // accept too, and the next save put the empty start-state back over the
    // profile main had just written.
    expect(stores.project.useProjectStore.getState().content).toBe(PROPOSED)
    expect(stores.project.useProjectStore.getState().activeMissing).toBe(false)
  })

  it('lets the author empty a document the accept created', async () => {
    const stores = await loadStores()
    const CREATE = 'metadata/characters/mara-din.md'
    const PROPOSED = '---\nname: Mara Din\n---\nSharp-eyed.\n'
    stores.project.useProjectStore.setState({ novel: NOVEL })
    responses['proposals:pending'] = {
      docs: [{ path: CREATE, action: 'create', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: '',
      chain: [
        { proposalId: 'p1', sourceTitle: 'Codex update', rationale: 'New', content: PROPOSED }
      ],
      blocked: []
    }
    responses['proposals:apply'] = { content: PROPOSED, remaining: 0 }
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'chapter:read') return { ok: false, error: { message: 'ENOENT' } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    await stores.project.useProjectStore.getState().openChapter(CREATE, { allowMissing: true })
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()
    stores.proposals.useProposalsStore.getState().setShown(true)
    stores.proposals.setSuggestionHandle(fakeHandle('Sharp-eyed.\n', {}))
    stores.project.useProjectStore.getState().setContent(PROPOSED)
    await stores.project.useProjectStore.getState().saveActiveChapter()

    // The accept made the file, so "this document has no file yet" has to stop
    // being true — it was suppressing the write, and select-all-delete then
    // vanished with a clean "saved" indicator.
    expect(stores.project.useProjectStore.getState().activeMissing).toBe(false)
    stores.proposals.useProposalsStore.setState({ active: null })
    invokes.length = 0
    stores.project.useProjectStore.getState().setContent('')
    await stores.project.useProjectStore.getState().snapshotActiveChapter()
    const write = invokes.find((i) => i.channel === 'chapter:write')
    expect(write?.payload.content).toBe('')
  })

  it('decides nothing when no editor can speak for the proposals', async () => {
    const { proposals, project } = await setUp()
    // The timeline falls back to a plain textarea when its YAML is not a list
    // of records, and registers no source. Saving used to report every
    // proposal as proposing what the file already said — and delete the lot.
    proposals.setSuggestionHandle(null)
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nHand edited.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    const apply = invokes.find((i) => i.channel === 'proposals:apply')!
    expect((apply.payload as { decisions: unknown[] }).decisions).toEqual([])
    expect((apply.payload as { write: string }).write).toContain('Hand edited.')
  })

  it('leaves documents without suggestions on the ordinary write path', async () => {
    const { proposals, project } = await setUp()
    proposals.useProposalsStore.setState({ active: null })
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nJust typing.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(false)
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(true)
  })
})
