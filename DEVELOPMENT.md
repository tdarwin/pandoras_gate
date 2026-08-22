# Development

How to set up a Pandora's Gate development environment, find your way around the code,
and get a change merged. For the *why* behind the project, see the
[README](README.md); for what the AI actually receives on each request, see
[docs/context-assembly.md](docs/context-assembly.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.18+ or 23.6+ | CI builds on Node 22; `verify:catalog` needs unflagged TS stripping |
| npm | ships with Node | the repo uses `package-lock.json`; `npm ci` in CI |
| git | any recent | also used *by* the app, via `isomorphic-git` |
| Xcode Command Line Tools | current | macOS only; needed for native modules |

Development works on macOS, Windows, and Linux. Packaged release builds are currently
produced for macOS/Apple Silicon only (see [Packaging and releases](#packaging-and-releases)).

Local model inference uses `node-llama-cpp`, which ships prebuilt binaries — Metal on
Apple Silicon, CUDA/Vulkan/CPU on Windows. You don't need to build llama.cpp yourself, and
you don't need any model at all to work on the app: an OpenRouter key, or neither, is fine
for most areas.

## Setup

```bash
git clone https://github.com/tdarwin/pandoras_gate.git
```

```bash
cd pandoras_gate && npm install
```

```bash
npm run dev
```

`npm run dev` launches Electron with hot module reloading in the renderer. Editing main-
process files restarts the app automatically; editing renderer files hot-swaps in place.

> **Note:** the dev app shares the same user data directory as an installed copy
> (`~/Library/Application Support/pandoras-gate/` on macOS). Your real novels, models, and
> preferences are visible to it — see [Working safely with real user data](#working-safely-with-real-user-data).

## Everyday commands

```bash
npm run dev        # launch the app with HMR
npm run test       # vitest unit suite (single run)
npm run test:watch # vitest in watch mode
npm run typecheck  # strict TS across main/preload/renderer
npm run build      # electron-vite production build into out/
npm run package    # electron-builder DMG/NSIS (signing config required)
npm run package:dir # unpacked build — fast, good for smoke tests
npm run verify:catalog # check the model catalog against Hugging Face + OpenRouter (network)
```

`npm run test` and `npm run typecheck` are the gate. CI runs both before it will build a
release, and a PR that fails either won't be merged. `verify:catalog` hits the network, so
it is deliberately outside the gate — run it when you touch the catalog.

## Updating the model catalog

Recommendations go stale fast. The catalog is fetched at runtime from
`https://pandorasgate.app/catalog.json`, with the copy compiled into the app as the
fallback for offline use, a failed fetch, or a catalog published against a newer schema
than the installed build understands.

The two copies — `src/main/llm/catalog.json` (bundled) and `site/catalog.json` (published)
— must stay byte-identical; a unit test enforces it. To change the picks:

1. Edit `src/main/llm/catalog.json`, then `npm run verify:catalog -- --write`. The `--write`
   pass reads each model's GGUF header over HTTP (header only — a few MB, not the model) and
   rewrites the `memory` block from node-llama-cpp's own estimator, then writes both copies.
2. `npm run verify:catalog` — confirms every Hugging Face repo and file exists at the exact
   byte size, that none are gated (gated repos can't be downloaded in-app), and that every
   hosted slug is still offered by OpenRouter.
3. `npm run test` — offline invariants: schema, unique ids and filenames, coverage of every
   use case and memory tier, and that a 16GB machine still gets an option for every task.
4. Merge. The Pages workflow redeploys `site/` on any change under `site/**`, so the new
   catalog reaches installed apps within their 24-hour cache window — no release needed.

Curation sources, in order of trust: the Hugging Face API (`?filter=gguf&sort=downloads`)
for what people actually run, the EQ-Bench creative-writing leaderboards for prose quality,
and r/LocalLLaMA for the fine-tune categories that never appear on leaderboards. **Do not
curate from web search** — results for "best LLM for creative writing" are saturated with
AI-generated listicles citing models that do not exist. Always read the model card: two of
the highest-download "creative"-sounding repos found while building this catalog turned out
to be a coding model and an agentic vision model.

The `useCases` vocabulary is the model-role vocabulary (`MODEL_ROLES` plus `chat`), defined
once in `src/shared/llm/catalog.ts`. Adding a role there is a compile error everywhere it
needs to be handled, which is the point.

Never hand-author the `memory` block. It is what decides whether a model is offered at all
and what context window the user is promised, and the numbers are not guessable — KV cache
cost varies by an order of magnitude between architectures (Gemma 4 31B needs ~55GB at a
256k window; Qwen 3.6 35B needs ~15GB).

## How much context a local model actually gets

There is no fixed local context window. Weights and KV cache share one pool:

```
available = min(total − 3.5GB, total × 0.85)     # usableMemoryBytes()
context   = largest sampled window whose KV cache fits in available − weights
```

`src/shared/llm/memory.ts` owns this and is the only place the thresholds live —
`MINIMUM_CONTEXT` (4k, below which a model is not offered), `CRAMPED_CONTEXT` (8k, below
which the picker warns and points at hosted models), `COMFORTABLE_CONTEXT` (16k, the
assembler's retrieval-first threshold) and `DEFAULT_CONTEXT_CEILING` (64k, the policy cap).

Both limits are applied as a *minimum* rather than subtracting one from the other: a fixed
OS reserve dominates on small machines, the fraction dominates on large ones. Taking a
fraction *and* a fixed floor reserved half of an 8GB machine and wrongly concluded that no
local model could run there.

Three layers, deliberately:

- **Catalog (pre-download)** — estimated from the baked `memory` profile against total
  memory. Advisory: it decides what to recommend and what to promise.
- **Import** — a first estimate stored on the registry entry.
- **Load (authoritative)** — the worker calls node-llama-cpp's
  `resolveContextContextSize` against live VRAM/RAM state and reports what it actually
  resolved; `recordResolvedContext` writes it back so the context assembler budgets against
  the real window rather than an estimate.

Sizing is against *total* memory rather than free, on purpose: free memory swings by
gigabytes minute to minute, and advice that changes every time you open the dialog is worse
than advice that is slightly pessimistic.

## Architecture

Four processes, with a hard boundary between each:

```
┌─ main ─────────────────────────────────────────────┐
│  filesystem · git · network · secrets · menus      │
│  LLM providers · Codex pipeline · context assembly │
└───────────────┬─────────────────────┬──────────────┘
                │ typed IPC           │ utilityProcess
                │ (zod-validated)     │ message port
┌─ preload ─────┴──────────┐   ┌──────┴──────────────┐
│  contextBridge:          │   │  llm-worker         │
│  invoke() + on() only    │   │  node-llama-cpp     │
└───────────────┬──────────┘   │  GGUF inference     │
                │              └─────────────────────┘
┌─ renderer ────┴────────────────────────────────────┐
│  React 19 · TipTap editor · Tailwind 4 · stores    │
└────────────────────────────────────────────────────┘
```

**main** (`src/main/`) owns everything privileged. It's the only process that touches
disk, spawns network requests, or reads the OS keychain.

**preload** (`src/preload/`) exposes exactly two functions on `window.pandora` —
`invoke(channel, payload)` and `on(channel, listener)`. The renderer never sees
`ipcRenderer`. If you find yourself wanting to widen this surface, that's a signal the
logic belongs in main.

**renderer** (`src/renderer/src/`) is a React app with no privileges. It asks main for
everything.

The one way file bytes reach the renderer is the **`pandora-asset://` scheme**
(`src/main/assets/scheme.ts`): a privileged protocol that serves images from exactly two
roots — `pandora-asset://themes/<id>/<file>` (the userData themes folder) and
`pandora-asset://novel/<rel>` (the open novel's directory, registered by the
open/create-novel handlers). Every request passes the shared containment helper
(`resolveInside` in `src/main/paths.ts`, symlink-aware), and the scheme is named in the
renderer's CSP `img-src` rather than bypassing CSP.

**llm-worker** (`src/llm-worker/`) runs local GGUF inference in an Electron
`utilityProcess`, so model loading and prompt evaluation can never stall the UI, and a
crash (bad GGUF, OOM) takes down only that process. The worker executes generations and
model loads **strictly one at a time** (`src/llm-worker/queue.ts`): one resident model
and one memory pool mean a second concurrent context would be sized against whatever the
first one left. Anything that would generate mid-chat — the agent's `update_codex`,
`edit_chapter`, `generate_outline` tools — is instead *deferred*: the tool queues the run
and `startChat` executes it after the reply finishes, reporting progress to the proposals
UI via `pipeline:run` / `pipeline:status` events.

### Where things live

```
src/main/
├── index.ts        # app lifecycle, window creation, legacy-data migration
├── ipc/index.ts    # every channel handler, registered through one typed helper
├── project/        # novel + chapter CRUD, novel.yaml, archive
├── metadata/       # Codex pipeline: propose full-document updates after a save
├── context/        # context assembler — the budget ladder in docs/context-assembly.md
├── llm/            # providers (local, openrouter), agent tools, HF search, GenAI OTel
├── review/         # proposal storage and accept/reject bookkeeping
├── draft/          # AI first-draft and outline generation
├── publish/        # per-platform clipboard profiles (RoyalRoad, Patreon)
├── git/            # isomorphic-git autocommit, history, diff, restore, sync
│                   #   repo mutations serialize through a per-dir lock; per-file
│                   #   history is served from a derived index cache in
│                   #   .git/pandora/history-index.json (rebuilt if missing)
├── store.ts        # app state (recents, prefs, model paths)
├── secrets.ts      # API keys via Electron safeStorage — never written in plaintext
├── menu.ts         # native application menu
└── telemetry.ts    # OpenTelemetry, dev-only

src/shared/         # zod schemas + the IPC contract, imported by every process
src/renderer/src/
├── app/            # App shell, Welcome, Workspace
├── editor/         # TipTap setup, markdown (de)serialization, tracked changes
├── components/     # chat, Codex browser, proposals, history, models, modals
├── stores/         # client state
└── styles/

resources/          # runtime assets main loads via `?asset` (window/dock icon)
build/              # electron-builder inputs: icons, macOS entitlements
docs/               # prose documentation
site/               # the pandorasgate.app landing page
```

### The IPC contract

`src/shared/ipc.ts` is the single source of truth for every main↔renderer channel, and
it's where a new feature usually starts.

- `ipcContract` holds request/response channels (renderer → main, via `invoke`).
- `ipcEvents` holds fire-and-forget events (main → renderer, via `webContents.send`).
- Both directions validate against these zod schemas. A malformed request is rejected
  with `INVALID_REQUEST` before any handler runs; a handler that throws comes back as
  `{ ok: false, error }` rather than an unhandled rejection. Event payloads are
  validated on receipt: subscribe with `onIpcEvent` from
  `src/renderer/src/lib/events.ts` (never `window.pandora.on` directly), which parses
  the payload against `ipcEvents` and drops mismatches with a console warning.
- Preference value sets (snapshot intervals, context targets, theme) live once in
  `src/shared/prefs.ts`; the store, the IPC schemas, and the Preferences UI all derive
  from those arrays, so adding a value is a one-file change.

Adding a channel:

1. Define the request/response schemas in `ipcContract` (or the payload in `ipcEvents`).
2. Register the handler in `src/main/ipc/index.ts` with the `handle()` helper — it wires
   up validation, error serialization, and a tracing span for free.
3. Call it from the renderer: `await window.pandora.invoke('your:channel', payload)`,
   then check `result.ok` before using `result.data`.

Types flow from the schemas, so a mismatch between the three sides is a compile error,
not a runtime surprise. Never reach for `ipcRenderer` directly.

### Data on disk

Two separate places, and the distinction matters:

- **The novel** — a user-chosen directory of markdown and YAML, laid out as described in
  the [README](README.md#novel-folder-format). Source of truth for everything about the
  story. Each novel gets a hidden git repo; every save auto-commits. On window close and
  quit, main runs a bounded save handshake (`app:flushRequest` → renderer snapshot →
  `app:flushed`, `src/main/flush.ts`) so the last few seconds of typing always reach disk
  and history.

  AI edits queue as **proposals** (`.pandora/proposals/`), each storing the full document
  it was generated against (`baseContent`) alongside the content as first proposed
  (`asProposed`, the fingerprint the rejected-suggestion memory uses). Nothing is ever
  applied by overwriting: `foldProposalsForPath` chains `rebaseProposal` over every
  pending proposal for one document, so three section edits generated against one base
  compose instead of the last silently reverting the first two. A proposal that will not
  re-anchor is set aside with its reason rather than poisoning the fold.

  Suggestions are reviewed **inline**, in the ordinary editor — there is no queue and no
  review mode. Two rules keep the save path honest: only proposals the author can actually
  SEE are decided (the overlay must be attached, and the fold's set-aside proposals are not
  on screen), and frontmatter defaults to the author's own, never the proposal's. The document the editor holds is the file plus every pending suggestion;
  what gets saved is `savableDoc` (see below), so an undecided suggestion never reaches
  disk. Every save path in `stores/project.ts` routes through the injected
  `suggestionWriter` when the open document has suggestions, so autosave, blur, the
  interval snapshot, ⌘S, switching chapters and closing the novel all record decisions
  rather than writing the buffer over them.

  A decision is recorded by `applyProposalDecisions`: what the file should say now, and
  what is still proposed — for the proposals the author actually saw. Anything not named
  in `decisions` is left untouched, `baseContent` included, because the fold re-anchors it
  next time; the fold sets aside proposals it cannot combine, and an earlier version
  deleted those the moment their siblings were accepted. Both sides come recomputed from the editor rather
  than patched hunk by hunk, so the stored item is a pure function of what the author is
  looking at and a crash mid-review leaves nothing to reconcile. `baseContent` advances
  as hunks are accepted; the item resolves when nothing is left to suggest.

  A refused apply means the file moved under the author, and what happens next depends on
  whether there was anything to write. When there was, the writer declines and the caller
  makes an ordinary write, which re-anchors the overlay: the buffer holds typing, and
  losing that is worse than overwriting the change main objected to. When there was not —
  `write` is null exactly when the savable document already equals the anchor — the writer
  handles it and reports so, because a fallback write there has nothing to offer but
  damage: it puts the pre-change text back over the external edit. That path re-folds and
  re-reads the buffer instead, which was a copy of the anchor main just called stale. Both
  are conditional on the buffer still being what was sent: keystrokes typed during the
  round trip win, ride the next save, and keep the buffer dirty so autosave still has a
  reason to fire.

  Concurrency: every read-modify-write of `.pandora/state.json`, of the proposal JSON,
  and of a git index runs through `withLock` (`src/main/locks.ts`) — nothing in Electron
  serializes IPC handlers, and a pipeline run holds state across a minutes-long model
  call while the author is clicking. State mutations re-read inside the lock and touch
  only the fields the caller owns. JSON goes to disk through `writeJsonAtomic`
  (`src/main/paths.ts`), because the readers skip what they cannot parse — a torn write
  would be silent data loss.
- **App state** — `~/Library/Application Support/pandoras-gate/` on macOS
  (`%APPDATA%/pandoras-gate` on Windows): `app-state.json` (recents, preferences, model
  registry), `secrets.json` (encrypted via `safeStorage`), `models/`, `logs/`, and
  `themes/` — one folder per custom theme (`themes/<id>/theme.yaml` plus any image
  assets; see the [README](README.md#custom-themes) for the file format). The folder is
  watched (`watchThemes` in `src/main/themes/service.ts`), so hand edits apply live; a
  malformed theme file stays listed in the picker with its problem and the app falls
  back to the built-in palette.

### Suggestions in the editor

`src/renderer/src/editor/track-changes.ts` shows pending suggestions inline. The document
being edited is the on-disk file **plus** every pending suggestion; the extension holds the
original and renders the difference. Two documents come back out, and the distinction is
the whole design:

- `savableDoc` — undecided suggestions reverted. This is what `onChange` emits and what
  autosave writes, so AI text the author has not agreed to never reaches disk.
- `proposedDoc(id)` — everything decided, plus only that proposal's undecided suggestions.
  This is what gets stored back as the proposal's `newContent`.

Every span carries its source: a proposal id, or `AUTHOR` for the writer's own typing.
`Change.merge` fuses touching ranges, so a keystroke at the edge of a suggestion lands
inside the AI's change. `narrow()` decides who owns the result: leading and trailing
author *insertions* are trimmed back off (adjacent typing is not a decision), while an
insertion in the interior, an author *deletion* anywhere, or an insertion that leaves no
proposal text behind all mean the chunk has been taken over and is now the author's.

Every one of those rules errs the same way, and deliberately: when ownership is ambiguous
the chunk becomes the author's, because the alternative is a save that eats what they
wrote. The two sides do not trim symmetrically — a character the author deleted can sit
between two spans a proposal deleted, and even a *trailing* author deletion cannot be
trimmed off the A range alone, because the B range has already swallowed the unchanged
text beyond it (measured: `A quiet night.` came back as `A quiet.`). So a deletion adopts
rather than trims.

**This is the one place the app decides for the author.** Backspacing next to a pending
suggestion accepts it — the model's word reaches disk without a ✓, and the ✓/✕ disappear.
It is a deliberate trade against the only alternative on offer, which is losing prose the
author typed, and it is narrow: it needs a deletion that fuses into the suggestion's own
change, and it adopts only that chunk. Everywhere else "you approve everything" holds
exactly.

Reverting goes through a `Transform`, not `Node.replace`, and over the *displayed* chunks
rather than raw token spans: a wrap suggestion (paragraph → blockquote, paragraphs → list)
has endpoints at different depths, which `Node.replace` rejects outright — and the throw
escaped through `onUpdate`, stopping autosave for the rest of the session.

A restructuring — a wrap, an unwrap, a styled-block attribute — arrives as token changes
carrying no text at all, and one of those on its own is not a decision anybody can make:
rejecting an opening token alone splices half a wrap, which is not a document. So the
whole restructured block merges into a single change that displays, accepts, and reverts
as a unit, and a block that was reworded *and* restructured merges into that same one.

The merge works from a single alignment of the two documents' top-level blocks
(`alignTopLevel`), not from one side's block boundaries plus arithmetic on the other's.
Deriving one range from the other is what made this the most-revised code in the app: a
wrap gathers several original blocks into one and an unwrap does the reverse, so every fix
in that shape cured one direction and broke the other. Segments are ordered and disjoint
on both sides, which makes overlapping replacements — two restructured blocks side by side
claiming each other's text — impossible rather than guarded against. A token is assigned
to the last segment starting at or before it on **both** sides, which is what tells an
unwrap's closing token (on the seam, but deleted from the block before it) apart from the
next block's opening token (on that same seam, but inserted into the block after it).

A group that cannot be merged **drops** its members rather than leaving them. An
unmergeable restructuring is not revertible at all, and both ways of leaving one behind
were worse than letting it stand: raw token spans splice individually and corrupt the save
(a duplicated paragraph, an empty list item), and they render as ✓/✕ over no text —
buttons that do nothing when read and damage when clicked.

That is also how author typing inside a restructured block is handled: the container's own
tokens fuse with the first keystroke into one change, so the block becomes the author's,
chunks and all. It is the adjacent-typing trade above at block scale, and it errs the same
way. Only a change carrying *text* counts as evidence of typing — changeset re-attributes
spans as it merges, and an author tag turns up on the closing token of a wrap three blocks
from anything the author touched.

Accepting is metadata-only, so it is not undoable; rejecting mutates the document and is.

The overlay attaches and detaches through plugin metadata, never by recreating the editor:
`useEditor` recreates on `docId` alone, and a recreate steals focus and resets the caret —
unacceptable when suggestions can arrive fifteen seconds after a save, mid-sentence.

The diff is built one StepMap per changed block (`blockStepMaps`), not one for the whole
document, because `prosemirror-changeset` gives up past 5000 characters of edit distance
and returns a single all-or-nothing chunk. Two constraints shape it: paired blocks are
mapped by their *inner* range, since `Change.merge` fuses touching ranges back together;
and the maps are applied in descending order as separate single-range maps, because
changeset's `addSteps` carries only the previous range's delta between ranges of one map,
so a three-range map comes out mis-positioned.

Navigation answers "where do I need to look?": every chapter row and Codex row with
something pending carries a count, collapsed sections and the sidebar tabs carry the
rolled-up total, and the status bar carries the novel's. A document that exists only as a
proposal still gets a row (`allowMissing` on `openChapter`), marked NEW. `codexPaths.ts`
owns Codex ordering so the sidebar and the Suggestions menu's "next" walk cannot disagree.

The app must never crash on a hand-edited novel file. Validation failures degrade — log,
fall back, surface a readable message — because users are explicitly invited to edit these
files in any editor.

Frontmatter has three states, not two (`src/shared/frontmatter.ts`): a readable block, no
block, and a block that is not readable YAML — an unquoted colon in a title, a list, a
stray tab. The third is kept in `FrontmatterDoc.rawFrontmatter` rather than folded into the
body, so it never renders as prose in the writing surface and never gets rewritten as prose
on save. It is the one place the app deliberately shows YAML: the details strip displays it
with a notice and lets the author fix it in place. Anything that needs to SET a field
(`renameChapter`, `setChapterStatus`) checks the flag and refuses readably instead of
writing a second block above the first. A leading UTF-8 BOM is stripped on parse and does
not come back.

## Testing

Tests are colocated with the code as `*.test.ts` and run with Vitest:

```bash
npm run test
```

```bash
npx vitest run src/main/context/assembler.test.ts
```

The default environment is `node`; renderer/editor tests that need a DOM opt in per file
with a `// @vitest-environment jsdom` pragma.

What's worth testing here, in rough priority order:

- **Pure logic with tricky rules** — the context assembler's budget ladder, publish
  profiles, markdown ↔ TipTap round-tripping, frontmatter parsing, tracked changes.
  These have the most tests today and are where regressions hurt most.
- **Anything parsing model output** — the Codex pipeline and agent tools must survive
  malformed or surprising responses.
- **Filesystem and git operations** — exercise them against a temp directory.

There's no end-to-end suite yet (it's on the roadmap). For UI changes, verify by hand —
see below.

### Working safely with real user data

The dev build reads and writes the same user data directory as an installed copy. Before
any scripted or automated run against the built app:

1. Check for an already-running `electron-vite dev` instance and stop it — a renderer
   hot-reloading against a stale main process produces confusing IPC failures.
2. Back up `app-state.json` and restore it afterward. Test novels otherwise land in your
   real recents list, and preference changes persist.
3. Prefer a scratch directory outside the project for any test novels.

To drive the built app for verification, `npm run build` then launch `out/` with
`playwright-core`'s `_electron.launch`. The native folder picker can be stubbed
(`dialog.showOpenDialog`) so novels can be created without a native dialog, and menu items
triggered through `Menu.getApplicationMenu()`. Note that in dev the macOS app menu title
shows "Electron" regardless of the template label; only packaged builds show
"Pandora's Gate".

## Code conventions

- **TypeScript is strict**, including `noUnusedLocals` and `noUnusedParameters`. Don't
  reach for `any` to get past a type error — model the type.
- **Zod schemas describe every boundary**: IPC, on-disk files, model output. Parse at the
  edge, then work with typed data inside.
- **Comments explain *why*, not *what*.** The existing comments are a good guide: they
  document non-obvious constraints (why the LLM worker is a separate process, why the
  release publishes directly instead of drafting). Skip comments that restate the code.
- **Match the surrounding file.** Naming, structure, and comment density should be
  indistinguishable from the code around your change.
- **Delete rather than deprecate.** This project doesn't carry backwards-compatibility
  shims for its own internals — if a shape changes, change it everywhere and remove the
  old path. (User data is the exception: migrations for existing novels and app state are
  written deliberately, as in `migrateLegacyUserData`.)
- **Errors reach the user readably.** An IPC failure should produce a message a novelist
  can act on, not a stack trace.
- **No secrets in files.** API keys go through `safeStorage` into the OS keychain.

## Optional dev telemetry

The app can export OpenTelemetry traces — including GenAI spans for every model call —
while running in dev. This is off unless you configure it, and packaged builds never send
telemetry at all (`src/main/telemetry.ts`).

```bash
cp .envrc.TEMPLATE .envrc
```

Fill in your OTLP endpoint and key, then `direnv allow`. Any OTLP/HTTP backend works; the
template's values target Honeycomb. `.envrc` is gitignored — never commit real keys.

## Packaging and releases

```bash
npm run package:dir   # unpacked app, fastest way to test a real build
npm run package       # full DMG/NSIS
```

Releases are cut by `.github/workflows/release.yml` on any `v*` tag:

1. `npm run test` and `npm run typecheck`
2. Signing is configured **if** the `MAC_CSC_*` / `APPLE_*` secrets exist — forks build
   unsigned automatically, no changes needed
3. `electron-builder --mac --publish never` builds and signs the DMG, publishing nothing
4. When signing was configured, a tripwire step verifies `codesign`, `stapler validate`,
   and a "Notarized Developer ID" verdict from `spctl` — a release that quietly built
   unsigned fails the workflow instead of shipping
5. Only then is the GitHub release created and the DMG uploaded, with its notes taken from
   the matching [CHANGELOG.md](CHANGELOG.md) section
6. `Casks/pandoras-gate.rb` is regenerated with the new version and checksum and pushed to
   [tdarwin/homebrew-tap](https://github.com/tdarwin/homebrew-tap), so the Homebrew tap
   updates itself

The build/verify/publish split matters twice over. It keeps a build that failed signing or
notarization from ever becoming a visible release — `--publish always` used to upload
before the tripwire ran, so a bad build reached users and only then failed the workflow.
And it sidesteps an electron-builder bug: its GitHub publisher runs once per artifact, and
with no release for the tag each copy creates its own, splitting assets across two releases
where the tag's download URL resolves to only one. That is what broke the v0.4.1 DMG.

The publish step is re-runnable — an existing release is uploaded into rather than
recreated — so a failed run can be retried from the Actions tab without cleanup.

The cask lives in a separate repo because Homebrew only resolves the
`brew install --cask tdarwin/tap/pandoras-gate` shorthand — the single command users
actually run — against repos named `homebrew-*`. Pushing there needs a fine-grained PAT
with **Contents: read and write** on `tdarwin/homebrew-tap`, stored on this repo as the
`HOMEBREW_TAP_TOKEN` secret; the ambient `GITHUB_TOKEN` can't reach another repository.
Without that secret the release still completes and only the cask update is skipped, so
forks cutting tags don't break.

### Cutting a release

1. Move the `## [Unreleased]` items in [CHANGELOG.md](CHANGELOG.md) under a new
   `## [X.Y.Z] — YYYY-MM-DD` heading, and add the compare link at the foot of the file.
   Entries are what users read in the GitHub release, so write them for a novelist: what
   changed for them, not what changed in the diff.
2. `npm version X.Y.Z --no-git-tag-version` — updates `package.json` and the lockfile.
3. Commit both, merge to `main`.
4. Tag and push:

```bash
git tag v0.5.0 && git push origin v0.5.0
```

Check the notes before tagging — this prints exactly what the release will say:

```bash
node scripts/changelog-section.mjs 0.5.0
```

If a version has no changelog entry the workflow falls back to GitHub's generated notes
rather than failing, so a forgotten entry costs you good release notes, not the release.

macOS packaging config lives in `electron-builder.yml`. The Windows NSIS target is
configured there and buildable locally, but CI doesn't produce it yet.

### App icon

`build/icon-master.png` is the 1024×1024 full-bleed artwork everything else derives from.
The generated files are checked in, so you only need to rebuild them when the artwork
changes:

| File | Used by |
| --- | --- |
| `build/icon.icns` | macOS bundle (824 px artwork on the 1024 px Apple grid, rounded) |
| `build/icon.ico` | Windows executable and installer (full-bleed) |
| `build/icon.png` | Linux packages |
| `resources/icon.png` | Linux window icon, macOS dock icon during `npm run dev` |
| `src/renderer/src/assets/icon.png` | the in-app About dialog |

## The website

[pandorasgate.app](https://pandorasgate.app) is a static page in `site/`, deployed to
GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches it. It's
hand-written HTML and CSS with no build step and no external requests — edit `site/index.html`
and `site/style.css` directly, and open the file in a browser to preview.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the fork → branch → PR workflow. In short: work
on a branch in your fork, keep `npm run test` and `npm run typecheck` green, and open a PR
describing what changed and how you verified it.

## Troubleshooting

**`npm run dev` opens a blank window.** Check the terminal for a main-process error and
the DevTools console for a renderer one. A renderer crash usually shows up in the
ErrorBoundary instead; a truly blank window generally means main failed before creating
the window.

**Native module errors after switching Node versions.** `rm -rf node_modules && npm install`.
`npmRebuild` is off in `electron-builder.yml`, so `node-llama-cpp` relies on its prebuilt
binaries matching your platform.

**Local models won't load.** Check `~/Library/Application Support/pandoras-gate/logs/`.
Because inference is isolated in the worker process, a bad GGUF surfaces as a worker crash
with the app still running.

**Typecheck passes but the build fails.** `npm run typecheck` covers `tsconfig.node.json`
and `tsconfig.web.json`; make sure new files are inside one of their `include` globs.
