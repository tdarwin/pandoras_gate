# Development

How to set up a Pandora's Gate development environment, find your way around the code,
and get a change merged. For the *why* behind the project, see the
[README](README.md); for what the AI actually receives on each request, see
[docs/context-assembly.md](docs/context-assembly.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 LTS or newer | CI builds on Node 22 |
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

**llm-worker** (`src/llm-worker/`) runs local GGUF inference in an Electron
`utilityProcess`, so model loading and prompt evaluation can never stall the UI, and a
crash (bad GGUF, OOM) takes down only that process.

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
- Both sides validate against these zod schemas. A malformed request is rejected with
  `INVALID_REQUEST` before any handler runs; a handler that throws comes back as
  `{ ok: false, error }` rather than an unhandled rejection.

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
  story. Each novel gets a hidden git repo; every save auto-commits.
- **App state** — `~/Library/Application Support/pandoras-gate/` on macOS
  (`%APPDATA%/pandoras-gate` on Windows): `app-state.json` (recents, preferences, model
  registry), `secrets.json` (encrypted via `safeStorage`), `models/`, `logs/`.

The app must never crash on a hand-edited novel file. Validation failures degrade — log,
fall back, surface a readable message — because users are explicitly invited to edit these
files in any editor.

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
