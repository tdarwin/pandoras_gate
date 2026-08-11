# Pandora's Gate — Writer's Studio

A desktop app for writing novels, doubling as an AI harness for writers: bring your own OpenRouter key for remote models, or run GGUF models entirely on your machine via a bundled llama.cpp engine.

Built with Electron + TypeScript + React. Everything you write is plain markdown on your own disk, versioned by an invisible git repo per novel.

## Features (MVP)

- **Live-preview markdown editor** (CodeMirror 6): headings, emphasis, quotes render in place; syntax reveals itself on the cursor line. Chapter frontmatter folds into a summary chip.
- **Project structure**: series → novel → chapters + story-bible metadata, all plain files (`novel.yaml`, `chapters/*.md`, `metadata/**`).
- **Story bible**: synopsis, per-chapter summaries, character profiles, world/system rules (LitRPG-friendly structured frontmatter), glossary, timeline — browsable and editable in-app.
- **AI metadata pipeline**: on chapter save, the AI proposes full-document updates to the story bible; you review word-level diffs and accept, edit, or reject each. Rejected suggestions stay rejected.
- **Context-aware chat**: the chat assembles story context (chapter, synopsis, world rules, matched characters, summaries, glossary) within the model's token budget, with a visible context inspector.
- **Local models**: curated catalog with hardware-aware recommendations and resumable downloads, or import any GGUF. Inference runs in an isolated utility process (Metal on Apple Silicon; CUDA/Vulkan/CPU on Windows).
- **Snapshots**: every save auto-commits to a hidden git repo; browse history, view diffs, restore any version (restores are new commits — always undoable).

## Install (macOS, Apple Silicon)

This repository doubles as a Homebrew tap:

```bash
brew tap tdarwin/pandora https://github.com/tdarwin/pandoras_gate
brew install --cask tdarwin/pandora/pandoras-gate
```

Releases are not yet signed with an Apple Developer ID, so the cask clears
macOS's quarantine flag after install (otherwise Gatekeeper reports the app
as damaged). If you instead download the DMG from
[Releases](https://github.com/tdarwin/pandoras_gate/releases) manually, run
`xattr -cr "/Applications/Pandora's Gate.app"` after copying it in.

Releases are produced by `.github/workflows/release.yml` on every `v*` tag:
tests → DMG build (signed + notarized when the `MAC_CSC_LINK`/`APPLE_*`
secrets exist) → GitHub release → the cask in `Casks/` is updated with the
new version and checksum.

## Development

```bash
npm install
npm run dev        # launch the app with HMR
npm run test       # vitest unit suite
npm run typecheck  # strict TS across main/preload/renderer
npm run package    # electron-builder DMG/NSIS (signing config required)
```

## Layout

```
src/main/        # Electron main: fs/git/network, IPC handlers, LLM providers, metadata pipeline
src/llm-worker/  # node-llama-cpp inference in an Electron utilityProcess
src/preload/     # contextBridge — the only surface the renderer sees
src/renderer/    # React UI: editor, chat, story bible, proposals, history, models
src/shared/      # zod schemas + typed IPC contract shared by all processes
```

## Novel folder format

```
my-novel/
├── novel.yaml               # chapter order + status (source of truth)
├── chapters/001-slug.md     # markdown + YAML frontmatter
├── metadata/
│   ├── synopsis.md          # whole-novel synopsis
│   ├── summaries/001-slug.md
│   ├── characters/kael.md   # structured facts in frontmatter, prose body
│   ├── world/magic.md       # `system:` frontmatter map for rules/tiers
│   ├── glossary.md          # `entries:` frontmatter list
│   └── timeline.yaml
└── .pandora/                # app-private state (proposals, pipeline hashes)
```

Everything is human-editable in any editor; the app validates on load and never crashes on hand-edited files.
