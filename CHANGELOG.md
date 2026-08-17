# Changelog

Notable changes to Pandora's Gate, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) — with the caveat
that while the app is pre-1.0, minor versions carry breaking changes to internal formats.
Your novels are the exception: on-disk data is migrated, never broken.

Release notes on GitHub are generated from this file, so an entry here is what users read.
Write for a novelist, not for a reviewer of the diff.

## [Unreleased]

## [0.5.0] — 2026-08-17

### Added

- **Model recommendations by task.** The model manager now asks what you want help with —
  drafting, copy editing, notes and continuity, keeping the Codex, or just talking a scene
  through — and optionally what you write: literary, genre fiction, romance, horror and
  grimdark, or RPG and interactive. It narrows a catalog of 13 local models and 8 hosted
  ones to the few that suit, each with a plain-language strength and an honest trade-off
  instead of a spec sheet.
- **Per-machine context windows.** Every model tells you how much context *your* machine
  can actually give it, worked out from the model's weights and its KV-cache cost against
  your memory. Where that turns out to be too little to write against, the app says so and
  points you at a hosted model rather than letting you download something that won't do
  the job.
- **Unfiltered models**, behind an opt-in toggle in the model manager. These write explicit
  sex and violence on request instead of refusing; the same property makes them less likely
  to refuse anything else, so they need a clearer brief about what you actually want.
- **One-click role assignment.** Installed models show buttons for the jobs they're good
  at — "use for copy editing" — which set the model roles directly. Preferences suggests a
  model for each role from what you have installed.
- **A model catalog that stays current.** Recommendations are published to
  [pandorasgate.app/catalog.json](https://pandorasgate.app/catalog.json) and refreshed
  daily, so the picks can improve without waiting for an app update. The build ships a copy
  for offline use.

### Changed

- **The curated model list is current again** — Qwen 3.5/3.6/3.8, Gemma 4, GPT-OSS and
  community fiction fine-tunes, replacing a slate that had fallen two model generations
  behind. Every entry is verified to exist and be downloadable before it ships.
- **Local models are no longer capped at a 16k context window.** The cap was a fixed number
  applied to every model on every machine, and it was wrong in both directions: a small
  model on a 16GB laptop can hold 64k, while a large one on the same machine has room for
  about 4k. A 16GB machine now typically gets **64k** where it used to get 16k.

### Fixed

- A chat started before the model finished warming up could be given a different context
  window than the one the app had planned its story context around — sometimes far smaller,
  sometimes far larger. Switching models could also leave the previous model's window in
  place.
- The app now records the context window the inference engine actually allocated, instead
  of assuming its own estimate held, so story context is budgeted against the real window.
- Preferences that were saved but silently reverted on the round trip. Any setting the app
  offers is now guaranteed to persist.
- Model cards advertised a model's full trained context (often 128k or 256k) when the app
  would load it far smaller. They now state what you will actually get.

## [0.4.2] — 2026-08-17

### Fixed

- Confirmed the reordered release path produces exactly one GitHub release per tag with the
  DMG attached. No app-code change from 0.4.0.

## [0.4.1] — 2026-08-16

### Fixed

- Releases could split their files across two GitHub releases for the same tag, leaving the
  download link — and the Homebrew cask — pointing at a release with no DMG on it. The
  release is now created once, after the build and notarization checks pass, and files are
  uploaded into it.

### Changed

- The Homebrew cask moved to [tdarwin/homebrew-tap](https://github.com/tdarwin/homebrew-tap)
  so `brew install --cask tdarwin/tap/pandoras-gate` works as a single command. If you
  installed from the old `tdarwin/pandora` tap, re-point Homebrew once — see the
  [README](README.md#install). Your novels and preferences are untouched.

## [0.4.0] — 2026-08-15

### Added

- **Formatting toolbar** in the editor.
- **Native application menus**, with items enabled to match what's open.
- **Model roles**: assign different models to drafting, copy editing, developmental notes,
  and Codex maintenance — a large hosted model for structure, a fast local one for passes.
- **Editing reviews**: proofread, copy edit, developmental edit, and fact-check against the
  Codex. Line edits arrive as tracked changes; the structural ones as reports you keep.
- Project documentation, contributor onboarding, and the
  [pandorasgate.app](https://pandorasgate.app) site.

## [0.3.0] — 2026-08-13

Released 2026-08-13.

## [0.2.0] — 2026-08-13

### Added

- **App icon** for the dock, taskbar, and packaged bundles, plus an About dialog.

### Fixed

- Releases publish directly rather than as drafts.
- The Homebrew cask strips quarantine on install and uses modern `depends_on` syntax.

## [0.1.0] — 2026-08-11

First tagged release.

### Added

- **WYSIWYG editor** over plain markdown files, with a hidden git repo per novel for
  snapshots and restores.
- **The Codex**: synopsis, per-chapter summaries, character profiles, world and system
  rules, glossary, and timeline — generated with AI help, reviewed by you, stored as
  ordinary files.
- **Context-aware chat** with an inspector showing exactly what the model was sent, and
  agent tools for creating, drafting, and editing chapters and Codex documents.
- **Outlining and AI chapter drafting.**
- **Local models** via a bundled llama.cpp engine, plus a Hugging Face browser for
  downloading any GGUF, and OpenRouter for hosted models.
- **One-paste publishing** to RoyalRoad and Patreon.
- Chapter management, tunable interval snapshots, git sync, and preferences.

[Unreleased]: https://github.com/tdarwin/pandoras_gate/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tdarwin/pandoras_gate/releases/tag/v0.1.0
