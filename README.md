# Pandora's Gate — Writer's Studio

A desktop app for writing novels, doubling as an AI harness for writers: bring your own
OpenRouter key for remote models, or run GGUF models entirely on your machine via a
bundled llama.cpp engine.

Everything you write is plain markdown on your own disk, versioned by an invisible git
repo per novel. No account, no cloud, no lock-in — close the app and your novel is still
a folder of readable files.

**[pandorasgate.app](https://pandorasgate.app)** · [Install](#install) ·
[Development](DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)

## What it's for

Long-form fiction breaks AI tools. A novel outgrows any context window by chapter ten,
and the assistant that was helpful in chapter one starts contradicting your own canon —
inventing a sister the character never had, forgetting that the magic system caps at
tier 7, misremembering who died.

Pandora's Gate is built around that problem. As you write, the app maintains a **Codex**:
a structured, human-readable record of what is true in your story — characters, world and
system rules, per-chapter summaries, a timeline, a glossary. The Codex is generated with
AI help, reviewed by you, stored as ordinary files, and assembled into context for every
AI request. The model doesn't need to remember your novel, because the app hands it the
relevant parts every time.

The design goals that follow from that:

- **Your files, your disk.** A novel is a directory of markdown and YAML. Any editor can
  open it; git can diff it; no database owns it.
- **Local models are first-class.** An 8k-context model running on your laptop should be
  useful, not a degraded afterthought — which is why context assembly is retrieval-first
  when the budget is tight.
- **You approve everything.** AI proposals arrive as reviewable changes, never as silent
  edits to your prose or your canon.
- **Markdown is storage, not the writing surface.** The editor is true WYSIWYG; the
  markdown lives on disk where it belongs.
- **Built for serial fiction.** Chapter-at-a-time workflow, and one-paste publishing to
  the platforms serial authors actually use.

## Features

- **True WYSIWYG prose editor** (TipTap/ProseMirror): bold looks bold, headings look like
  headings — markdown is the storage format, never the writing surface. Chapter details
  (frontmatter) live in a collapsible panel above the text.
- **Project structure**: series → novel → chapters + Codex metadata, all plain files
  (`novel.yaml`, `chapters/*.md`, `metadata/**`).
- **Codex**: the novel's canon reference — synopsis, per-chapter summaries, character
  profiles, world/system rules (LitRPG-friendly structured frontmatter), glossary,
  timeline — browsable and editable in-app.
- **AI metadata pipeline**: on chapter save, the AI proposes full-document updates to the
  Codex; you review as tracked changes right in the editor (✓/✕ on each suggestion, keep
  typing while you decide) or as word-level diffs in the queue. Rejected suggestions stay
  rejected.
- **Context-aware chat**: the chat assembles story context (chapter, synopsis, world
  rules, matched characters, summaries, glossary) within the model's token budget, with a
  visible context inspector. See [docs/context-assembly.md](docs/context-assembly.md) for
  exactly what the model sees and why.
- **Chat that can act**: the assistant has tools for creating and drafting chapters,
  making targeted section edits, and reading or updating Codex documents — each change
  surfaced for review.
- **Outlining and drafting**: outline a chapter, a novel, or a series with the model, then
  have it produce a first draft you rewrite.
- **Model roles**: assign different models to drafting, copy-edit, developmental notes,
  and Codex maintenance — a big remote model for structure, a fast local one for passes.
- **Model recommendations by task**: pick what you want help with — drafting, copy
  editing, continuity notes, Codex upkeep — and optionally what you write (literary,
  genre, romance, horror, RPG), and the catalog narrows to a few models that suit it, each
  with a plain-language strength and an honest trade-off. Models that write explicit
  content without refusing are included behind an opt-in toggle.
- **Honest context windows**: every model says how much context *your* machine can actually
  give it — computed from the weights and KV-cache cost against your memory, not a fixed
  number. Where that turns out to be too little to write against, the app says so and points
  you at a hosted model instead of letting you download something that won't do the job.
- **Local models**: curated catalog with hardware-aware recommendations and resumable
  downloads, or import any GGUF. Inference runs in an isolated utility process (Metal on
  Apple Silicon; CUDA/Vulkan/CPU on Windows). The catalog is published at
  [pandorasgate.app/catalog.json](https://pandorasgate.app/catalog.json) and refreshed
  without an app update; the build ships a copy as an offline fallback.
- **One-paste publishing**: "Copy for RoyalRoad / Patreon" puts the chapter on the
  clipboard as platform-shaped rich HTML (scene breaks, heading depth, and stat tables
  adjusted per site, duplicate title heading dropped) with a plain-text fallback.
- **Snapshots**: every save auto-commits to a hidden git repo; browse history, view diffs,
  restore any version (restores are new commits — always undoable).

## Install

**Requirements:** macOS Ventura (13) or later, Apple Silicon.

```bash
brew install --cask tdarwin/tap/pandoras-gate
```

That taps [tdarwin/homebrew-tap](https://github.com/tdarwin/homebrew-tap) on the way
through — no separate `brew tap` step.

The cask used to live in this repo, under the `tdarwin/pandora` tap. If that tap still
shows up, you're on the old one and upgrades won't follow the move:

```bash
brew tap | grep tdarwin
```

Re-point Homebrew once. Your novels and preferences are untouched — a plain `uninstall`
doesn't run the cask's `zap`:

```bash
brew uninstall --cask pandoras-gate
brew untap tdarwin/pandora
brew install --cask tdarwin/tap/pandoras-gate
```

Releases are signed with an Apple Developer ID and notarized, so the app opens without
Gatekeeper warnings — install from the cask or drag the DMG from
[Releases](https://github.com/tdarwin/pandoras_gate/releases) straight into Applications.
(Releases up to 0.3.0 predate signing; for those, run
`xattr -cr "/Applications/Pandora's Gate.app"` after installing.)

Intel Macs and Windows are not yet built by CI — see [Roadmap](#roadmap). The Windows
target is configured in `electron-builder.yml` and can be built locally.

### First run

1. **New Novel** (or **Open Novel**) — pick a folder; the app scaffolds `novel.yaml`,
   `chapters/`, and `metadata/`, and initializes the hidden git repo.
2. Add a model: the chat panel's **Models** button opens the model manager. Tell it what
   you want help with and download one of the local models it suggests, or paste an
   OpenRouter API key (stored in the OS keychain, never in a file) to use hosted models.
3. Write a chapter and save. The Codex pipeline proposes summary, character, and world
   updates; review them in the proposals queue.

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

Everything is human-editable in any editor; the app validates on load and never crashes on
hand-edited files. A series adds a parent directory holding series-level metadata shared
by the novels beneath it.

## Custom themes

Beyond the built-in Dark/Light/System palettes, Preferences → Appearance can import a
color theme from another editor — VS Code `.json`, Sublime `.sublime-color-scheme`, or
legacy `.tmTheme` — or you can write your own. A theme is a folder in the app's themes
directory (Preferences → "Open themes folder") holding a `theme.yaml`; every field is
optional, and `base` fills in whatever you omit:

```yaml
name: Gruvbox Warm
base: dark            # dark | light — the palette behind anything you omit
colors:               # UI: surface, panel, raised, line, lineStrong,
  surface: '#1d2021'  #     ink, inkStrong, inkMuted, inkFaint
  ink: '#ebdbb2'
editor:
  colors: { caret: '#fe8019', link: '#83a598' }   # also: selection, heading, strike,
                                                  # codeBg, bullet, quote, quoteText, hr
  font: { family: Iowan Old Style, size: 16, lineHeight: 1.8, measure: 42 }
  background: { image: paper.png, opacity: 0.3, blur: 2 }  # image sits in this folder
chat:
  colors: { link: '#83a598' }  # also: head, codeBg, preBg, quote, quoteText
```

Edits apply live — no restart. A background image always gets a legibility tint between
it and your prose (override with `tint:`). "Save current as custom theme" writes an
editable starting point; sharing a theme is just sharing its folder. Editor font, size,
line spacing, and line width can also be set directly in Preferences, on top of any
theme. A malformed theme file never breaks the app: the picker shows what's wrong and
the built-in palette takes over.

## Documentation

| Document | What's in it |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Set up a dev environment, architecture tour, testing, release process |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Fork → branch → PR workflow, what makes a good change |
| [docs/context-assembly.md](docs/context-assembly.md) | Exactly what the model sees on every request, and the budget rules |
| [CLAUDE.md](CLAUDE.md) | Working agreements for AI coding assistants in this repo |

## Roadmap

Shipped through 0.4.0: the WYSIWYG editor swap, tracked-changes review, retrieval-first
context assembly, publishing copy profiles, Developer ID signing and notarization,
formatting toolbar, native menus, and per-task model roles.

Under consideration next, roughly in order:

- Windows and Intel-Mac builds in CI
- EPUB export
- Pull-capable git sync (push-only today)
- A rebuildable SQLite index over the Codex for faster retrieval on large novels
- Playwright end-to-end coverage

Ideas and disagreements are welcome —
[open a feature request](https://github.com/tdarwin/pandoras_gate/issues/new/choose).

## Contributing

Bug reports, feature requests, and pull requests are all welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [DEVELOPMENT.md](DEVELOPMENT.md)
for the environment. Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Support the project

Pandora's Gate is free and MIT-licensed. If it's useful to you and you'd like to support
continued development, you can back the project on
**[Patreon](https://patreon.com/TDarwin)**.

## License

[MIT](LICENSE) © Davin Taddeo
