# Changelog

Notable changes to Pandora's Gate, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) — with the caveat
that while the app is pre-1.0, minor versions carry breaking changes to internal formats.
Your novels are the exception: on-disk data is migrated, never broken.

Release notes on GitHub are generated from this file, so an entry here is what users read.
Write for a novelist, not for a reviewer of the diff.

## [Unreleased]

### Added

- **Custom themes.** Preferences → Appearance can now import a color theme from VS Code,
  Sublime Text (`.sublime-color-scheme`), or legacy `.tmTheme` files — or you can write
  your own: a theme is a small YAML file in the new themes folder, and a two-line file
  that sets `base` and one color is already valid. Themes can set fonts and put a
  background image behind the editor or the chat panel (with a built-in tint so your
  prose stays readable). Edits to theme files apply live, "Save current as custom theme"
  gives you an editable starting point, and a broken theme file never takes the app down
  — the picker tells you what's wrong and the built-in look takes over.
- **Editor typography settings.** Font (any installed font, by name), size, line
  spacing, and line width are now settable in Preferences and persist — on top of
  whichever theme is active.

### Fixed

- **The chat panel now follows the light theme.** It was hard-coded to dark colors no
  matter what the theme said.
- **A failed preference save no longer lies.** If a setting couldn't be written to disk,
  the toggle used to keep its new position and quietly revert on the next launch; now it
  snaps back and tells you what went wrong.
- **The crash screen points at a real menu.** Its "open the log folder" hint referenced
  a Preferences section that doesn't exist; it now points at Help → Open Logs Folder.
- **Safer handling of links and file paths.** The window can no longer be navigated to
  arbitrary local files by a link in an AI chat reply, and every chapter or suggestion
  path from a hand-edited or shared novel folder is now confined to that novel's folder
  — including through symlinks.

## [0.5.1] — 2026-08-20

### Fixed

- **Your typing survives closing the app.** Quitting, closing the window (⌘W), or
  clicking the sidebar's ✕ within a few seconds of typing used to silently drop your last
  words. The app now saves the open chapter — and takes a history snapshot — before any
  of those complete.
- **Accepting AI suggestions no longer overwrites what you wrote meanwhile.** A suggestion
  is now re-applied to the chapter *as it is when you accept*, so prose you typed during a
  slow run survives, and accepting several section edits from one chat reply keeps all of
  them instead of only the last. When a suggestion no longer lines up with your text, it's
  marked "Needs review — file changed" instead of quietly clobbering it, and "Accept all"
  skips those and tells you how many. The app also snapshots the chapter right before an
  accept, so the pre-accept version is always in History.
- **History → "Restore this version" actually restores.** It used to re-save the current
  text over the restored version; same for "Mark as revised," which reverted the chapter's
  status on disk. Both now also save what you had first — anything a restore replaces gets
  its own history entry, so a restore can itself be undone.
- **AI drafts stay in their chapter.** You can now browse other chapters, the Codex, or
  stop by another novel while a draft streams — the prose lands in the chapter the draft
  was started for, marked in the sidebar, with a Show/Stop bar wherever you are. It used
  to pour into whichever chapter you switched to.
- **Renaming a chapter to a title another chapter already has** (an "Interlude", say) no
  longer points the editor at the *other* chapter and overwrites it on the next save.
- **Assigning different local models to different tasks works now.** Any AI task that
  needed to switch local models used to fail with "Another generation is still running."
  Requests now queue and run one at a time, with a "Waiting for the current generation…"
  note while they do.
- **Codex updates, chapter revisions, and outlines from chat run after the reply.** They
  used to run *inside* it, fighting the chat for the same model's memory — on smaller
  machines that meant truncated results or a crashed model. The chat now says "Queued",
  and the toolbar shows progress the moment the reply ends.
- **Long chats no longer freeze while the AI responds.** Streaming re-rendered the whole
  conversation on every word; now only the growing reply updates.
- **Pending suggestions survive updating the app.** Suggestions queued by 0.5.0 are
  carried across the upgrade instead of silently vanishing from the badge; ones whose
  document changed in the meantime arrive marked "Needs review."
- **The History panel opens fast on long-lived novels.** It used to re-walk the novel's
  entire snapshot history — thousands of commits after months of writing — on every open
  and every chapter switch.

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
  about 4k. A 16GB machine now typically gets **64k** where it used to get 16k. Models you
  already downloaded are re-measured in the background the first time you open this
  version, so they get the larger window too.
- **Removing a model now deletes the file** whenever the app was the one that downloaded
  it, including from the Hugging Face browser. Previously it only deleted models the
  current catalog still listed, so anything that had since been rotated out was quietly
  left on disk. Models you imported from your own disk are still only unregistered — the
  file stays where you put it.

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

[Unreleased]: https://github.com/tdarwin/pandoras_gate/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/tdarwin/pandoras_gate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/tdarwin/pandoras_gate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tdarwin/pandoras_gate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tdarwin/pandoras_gate/releases/tag/v0.1.0
