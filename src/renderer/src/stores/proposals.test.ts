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
    savableBody: () => savableBody,
    proposedBody: (id: string) => proposedBody[id] ?? savableBody,
    suggestionCount: () => Object.keys(proposedBody).length,
    acceptAllSuggestions: vi.fn(),
    rejectAllSuggestions: vi.fn(),
    goToNextSuggestion: () => false,
    attachSuggestions: vi.fn(),
    detachSuggestions: vi.fn(),
    suggestionsAttached: () => true
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

  it('a re-fold leaves the overlay off, so it re-attaches from the new fold', async () => {
    const { proposals } = await setUp()
    expect(proposals.useProposalsStore.getState().active?.shown).toBe(true)

    // The workspace keys the overlay on the CHAIN, because attaching replaces
    // the document with the last link's content — re-attaching on a moved
    // baseline would put stale AI text back over the author's own. A baseline
    // that moves because the FILE moved is covered by this instead: the
    // re-fold turns the overlay off, and the auto-show effect brings it back
    // against the chain that was just folded.
    await proposals.useProposalsStore.getState().loadFor(PATH)
    expect(proposals.useProposalsStore.getState().active?.shown).toBe(false)
  })

  it('sets a proposal that changes the shape aside, with everything after it', async () => {
    const stores = await loadStores()
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: PATH })
    responses['proposals:pending'] = {
      docs: [{ path: PATH, action: 'update', count: 3, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: CURRENT,
      chain: [
        { proposalId: 'p1', sourceTitle: 'A', rationale: 'r', content: '---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n' },
        { proposalId: 'p2', sourceTitle: 'B', rationale: 'r', content: '---\nname: Kael\n---\nAlpha edited.\n\n> Beta.\n' },
        { proposalId: 'p3', sourceTitle: 'C', rationale: 'r', content: '---\nname: Kael\n---\nAlpha edited.\n\n> Beta edited.\n' }
      ],
      blocked: []
    }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()

    const active = stores.proposals.useProposalsStore.getState().active!
    // Only the reword can be spliced back safely. The wrap changes the shape,
    // and the link after it was folded on top of the wrap.
    expect(active.chain.map((l) => l.proposalId)).toEqual(['p1'])
    expect(active.blocked.map((b) => b.proposalId)).toEqual(['p2', 'p3'])
    expect(active.blocked.every((b) => b.structural)).toBe(true)
    expect(active.blocked[0]!.content).toContain('> Beta.')
  })

  /** A document whose only proposal wraps a paragraph — structural. */
  async function setUpStructural(): Promise<Awaited<ReturnType<typeof loadStores>>> {
    const stores = await loadStores()
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: PATH })
    responses['proposals:pending'] = {
      docs: [{ path: PATH, action: 'update', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: CURRENT,
      chain: [
        {
          proposalId: 'p1',
          sourceTitle: 'Codex update',
          rationale: 'r',
          content: '---\nname: Kael Voss\n---\n> Alpha.\n\nBeta.\n'
        }
      ],
      blocked: []
    }
    responses['proposals:apply'] = { content: null, remaining: 0 }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()
    stores.project.useProjectStore.getState().setSavedContent(CURRENT)
    await stores.proposals.useProposalsStore.getState().reviewStructural('p1')
    return stores
  }

  it('folds a structural proposal ON ITS OWN before showing it', async () => {
    const { proposals } = await setUpStructural()
    // The entry in `blocked` carries the cumulative fold, so accepting that
    // would put the undecided inline links before it on disk under this
    // proposal's name — and leave them pending against a file that already
    // contains them.
    const only = invokes.filter((i) => i.channel === 'proposals:forPath' && i.payload.only)
    expect(only).toHaveLength(1)
    expect(only[0]!.payload.only).toBe('p1')
    expect(proposals.useProposalsStore.getState().active?.review?.proposalId).toBe('p1')
  })

  it('accepts a structural proposal with the author’s own frontmatter', async () => {
    const { proposals } = await setUpStructural()
    invokes.length = 0
    await proposals.useProposalsStore.getState().decideStructural('p1', 'accept')

    const apply = invokes.find((i) => i.channel === 'proposals:apply')!
    // The body is the proposal's; the details are the author's until they say
    // otherwise. Writing item.content whole replaced fields no diff had shown.
    expect(apply.payload.write).toContain('> Alpha.')
    expect(apply.payload.write).toContain('name: Kael\n')
    expect(apply.payload.write).not.toContain('Kael Voss')
    // And it re-anchors, or the strip keeps offering a proposal that is gone
    // and the next ordinary save is refused as stale.
    expect(invokes.some((i) => i.channel === 'proposals:forPath' && !i.payload.only)).toBe(true)
  })

  it('does not snapshot a clean buffer on the way into a decision', async () => {
    const { proposals } = await setUpStructural()
    invokes.length = 0
    await proposals.useProposalsStore.getState().decideStructural('p1', 'reject')

    // The snapshot fell through the writer's "nothing to record" branch into a
    // plain, unchecked whole-buffer write — putting a stale buffer over an
    // edit made outside the app before the staleness check could see it.
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)
    expect(invokes.find((i) => i.channel === 'proposals:apply')!.payload.write).toBeNull()
  })

  it('reports a save with nothing to record as handled, not declined', async () => {
    const { proposals, project } = await setUp()
    // Declining sends the caller to a plain chapter:write of the whole buffer,
    // which main does not staleness-check.
    proposals.setSuggestionHandle(null)
    proposals.useProposalsStore.setState((st) => ({
      active: { ...st.active!, chain: [], shown: true }
    }))
    project.useProjectStore.getState().setSavedContent(CURRENT)
    invokes.length = 0
    await project.useProjectStore.getState().saveActiveChapter()

    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(false)
  })

  /** main as it behaves: once a proposal is decided, the fold no longer offers it. */
  function stubMainThatResolves(): void {
    type Link = { proposalId: string }
    const fold = responses['proposals:forPath'] as { chain: Link[]; current: string }
    const decided = new Set<string>()
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'proposals:apply') {
          for (const d of payload.decisions as Link[]) decided.add(d.proposalId)
        }
        if (channel === 'proposals:resolveAll') {
          for (const l of fold.chain) decided.add(l.proposalId)
          return { ok: true, data: { applied: 1, skipped: 0, conflicts: [] } }
        }
        if (channel === 'proposals:forPath') {
          const chain = fold.chain.filter((l) => !decided.has(l.proposalId))
          if (payload.only && !decided.has(payload.only as string)) {
            return { ok: true, data: { current: fold.current, chain: fold.chain.filter((l) => l.proposalId === payload.only), blocked: [] } }
          }
          return { ok: true, data: { current: fold.current, chain, blocked: [] } }
        }
        if (channel === 'proposals:pending' && decided.size === fold.chain.length) {
          return { ok: true, data: { docs: [] } }
        }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
  }

  it('“accept all” decides a structural-only document instead of doing nothing', async () => {
    const { proposals } = await setUpStructural()
    proposals.useProposalsStore.getState().setShown(true)
    stubMainThatResolves()
    invokes.length = 0
    const ok = await proposals.useProposalsStore.getState().resolveDoc(PATH, 'accept')

    // It used to take the editor branch, decide an overlay that was never
    // attached, return true, and leave a fresh empty commit behind.
    expect(ok).toBe(true)
    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(true)
  })

  it('“accept all” with the overlay deferred still decides the inline chain', async () => {
    const stores = await loadStores()
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: PATH })
    responses['proposals:pending'] = {
      docs: [{ path: PATH, action: 'update', count: 2, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: CURRENT,
      chain: [
        { proposalId: 'p1', sourceTitle: 'A', rationale: 'r', content: '---\nname: Kael\n---\nAlpha edited.\n\nBeta.\n' },
        { proposalId: 'p2', sourceTitle: 'B', rationale: 'r', content: '---\nname: Kael\n---\nAlpha edited.\n\n> Beta.\n' }
      ],
      blocked: []
    }
    responses['proposals:apply'] = { content: null, remaining: 0 }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()
    stores.project.useProjectStore.getState().setSavedContent(CURRENT)
    // The author is mid-sentence, so the strip is offering "Show": the editor
    // cannot speak for p1. Deciding p2 alone and reporting success left p1
    // pending behind a green button that said it was done.
    expect(stores.proposals.useProposalsStore.getState().active?.shown).toBe(false)
    stubMainThatResolves()
    invokes.length = 0

    const ok = await stores.proposals.useProposalsStore.getState().resolveDoc(PATH, 'accept')
    expect(ok).toBe(true)
    // p2 through the panel path, then main sweeps what the editor could not.
    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(true)
    expect(invokes.some((i) => i.channel === 'proposals:resolveAll')).toBe(true)
  })

  it('“reject all” with the overlay off saves the author’s typing before main sweeps', async () => {
    const { proposals, project } = await setUp()
    proposals.useProposalsStore.getState().setShown(false)
    // A DIRTY buffer this time: the author is mid-sentence, the strip offers
    // "Show", and they click the button beside it instead. Main folds against
    // disk, and the reload after the sweep replaced the buffer with what main
    // wrote — the sentence was gone, and the click reported success.
    const typed = '---\nname: Kael\n---\nAlpha.\n\nBeta. My own sentence.\n'
    project.useProjectStore.getState().setContent(typed)
    let disk = CURRENT
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'chapter:write') disk = payload.content as string
        if (channel === 'proposals:resolveAll') {
          return { ok: true, data: { applied: 1, skipped: 0, conflicts: [] } }
        }
        if (channel === 'chapter:read') return { ok: true, data: { content: disk } }
        if (channel === 'proposals:forPath') return { ok: true, data: { current: disk, chain: [], blocked: [] } }
        if (channel === 'proposals:pending') return { ok: true, data: { docs: [] } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    invokes.length = 0
    await proposals.useProposalsStore.getState().resolveDoc(PATH, 'reject')

    const write = invokes.findIndex((i) => i.channel === 'chapter:write')
    const sweep = invokes.findIndex((i) => i.channel === 'proposals:resolveAll')
    expect(write).toBeGreaterThanOrEqual(0)
    expect(write).toBeLessThan(sweep)
    expect(project.useProjectStore.getState().content).toContain('My own sentence.')
  })

  it('a snapshot with nothing to record tells main what it expects on disk', async () => {
    const { proposals, project } = await setUp()
    proposals.setSuggestionHandle(null)
    proposals.useProposalsStore.setState((st) => ({ active: { ...st.active!, chain: [], shown: true } }))
    project.useProjectStore.getState().setSavedContent(CURRENT)
    invokes.length = 0
    await project.useProjectStore.getState().snapshotActiveChapter()

    // Handled rather than declined, so the caller makes no fallback write —
    // and the history entry it does make carries `expectedCurrent`, so main
    // checks disk instead of trusting this store's belief about it.
    const writes = invokes.filter((i) => i.channel === 'chapter:write')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.payload.expectedCurrent).toBe(CURRENT)
  })

  it('re-reads the file when that snapshot is refused as stale', async () => {
    const { proposals, project } = await setUp()
    const external = '---\nname: Kael\n---\nSomeone else wrote this.\n'
    proposals.setSuggestionHandle(null)
    proposals.useProposalsStore.setState((st) => ({ active: { ...st.active!, chain: [], shown: true } }))
    ;(window as unknown as { pandora: { invoke: unknown } }).pandora.invoke = vi.fn(
      async (channel: string, payload: Record<string, unknown>) => {
        invokes.push({ channel, payload })
        if (channel === 'chapter:write') {
          return { ok: false, error: { message: 'This file changed while you were reviewing' } }
        }
        if (channel === 'chapter:read') return { ok: true, data: { content: external } }
        return { ok: true, data: responses[channel] ?? {} }
      }
    )
    project.useProjectStore.getState().setSavedContent(CURRENT)
    await project.useProjectStore.getState().snapshotActiveChapter()

    expect(project.useProjectStore.getState().content).toBe(external)
    expect(project.useProjectStore.getState().lastError).toMatch(/changed while/)
  })

  it('a clean-buffer snapshot on an ordinary document is checked by main too', async () => {
    const { proposals, project } = await setUp()
    proposals.useProposalsStore.setState({ active: null })
    project.useProjectStore.getState().setSavedContent(CURRENT)
    invokes.length = 0
    await project.useProjectStore.getState().snapshotActiveChapter()
    const write = invokes.find((i) => i.channel === 'chapter:write')!
    expect(write.payload.expectedCurrent).toBe(CURRENT)

    // A dirty buffer holds the author's typing and omits it on purpose.
    invokes.length = 0
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nTyped.\n')
    await project.useProjectStore.getState().snapshotActiveChapter()
    expect(invokes.find((i) => i.channel === 'chapter:write')!.payload.expectedCurrent).toBeUndefined()
  })

  it('leaves a YAML document to its own per-entry review', async () => {
    const stores = await loadStores()
    const YAML = 'metadata/timeline.yaml'
    stores.project.useProjectStore.setState({ novel: NOVEL, activeFile: YAML })
    responses['proposals:pending'] = {
      docs: [{ path: YAML, action: 'update', count: 1, sources: ['Codex update'], blocked: 0 }]
    }
    responses['proposals:forPath'] = {
      current: '- when: Day 1\n  what: A gate opens.\n',
      chain: [
        {
          proposalId: 'p1',
          sourceTitle: 'Codex update',
          rationale: 'r',
          content: '- when: Day 1\n  what: A gate opens.\n- when: Day 2\n  what: It closes.\n'
        }
      ],
      blocked: []
    }
    stores.proposals.useProposalsStore.getState().init()
    await stores.proposals.useProposalsStore.getState().refresh()

    // The gate exists because SPLICING is ambiguous. YAML is decided entry by
    // entry and never spliced — and its list syntax parses as a markdown
    // bullet list, so adding an event read as a shape change and the whole
    // per-entry review was bypassed.
    const active = stores.proposals.useProposalsStore.getState().active!
    expect(active.chain.map((l) => l.proposalId)).toEqual(['p1'])
    expect(active.blocked).toHaveLength(0)
  })

  it('records nothing while the overlay is off the document', async () => {
    const { proposals, project } = await setUp()
    // A detach drops the chunk count to zero exactly like deciding everything
    // does. Reading it as a decision resolved suggestions from a plugin that
    // was not showing them — which is what clicking through to a set-aside
    // proposal used to do to the proposal it was about to show.
    proposals.setSuggestionHandle({
      ...fakeHandle(CURRENT, { p1: CURRENT }),
      suggestionsAttached: () => false
    } as unknown as EditorHandle)
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nTyped.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    const apply = invokes.find((i) => i.channel === 'proposals:apply')!
    expect((apply.payload as { decisions: unknown[] }).decisions).toEqual([])
    expect((apply.payload as { write: string }).write).toContain('Typed.')
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

  it('leaves documents without suggestions on the ordinary write path', async () => {
    const { proposals, project } = await setUp()
    proposals.useProposalsStore.setState({ active: null })
    project.useProjectStore.getState().setContent('---\nname: Kael\n---\nJust typing.\n')
    await project.useProjectStore.getState().saveActiveChapter()

    expect(invokes.some((i) => i.channel === 'proposals:apply')).toBe(false)
    expect(invokes.some((i) => i.channel === 'chapter:write')).toBe(true)
  })
})
