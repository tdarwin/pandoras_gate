# Working on Pandora's Gate

Guidance for Claude Code (and any other AI assistant) working in this repository. Read
[README.md](README.md) for what the project is, [DEVELOPMENT.md](DEVELOPMENT.md) for the
architecture and commands, and [docs/context-assembly.md](docs/context-assembly.md) for
how the app builds context for its own model calls.

## The product in one paragraph

A desktop novel-writing studio that is also an AI harness. Long-form fiction outgrows any
context window, so the app maintains a **Codex** — a structured, human-readable record of
the story's canon — and assembles the relevant slice of it into context for every AI
request. The user's novel is a folder of markdown and YAML on their own disk, versioned by
a hidden git repo. Local models are first-class, not a fallback. The user approves every
AI-proposed change.

## Settled decisions — don't relitigate these

These were argued through and decided. Reopen one only if the user asks.

- **Electron stays.** Iteration speed wins, and llama.cpp does the inference regardless of
  the shell.
- **Flat files + git are the source of truth.** A database would kill the history/restore
  story, and "your novel is just a folder" is a product differentiator, not an
  implementation detail. A derived index (SQLite) is acceptable someday *only* as a
  rebuildable cache.
- **Markdown is the on-disk format; the user never sees it.** The editor is true WYSIWYG
  (TipTap/ProseMirror). Markdown is git-diffable and LLM-native — that's why it's on disk.
  If a change would expose raw markdown or YAML in the writing surface, it's wrong. YAML
  frontmatter lives behind the chapter-details panel.
- **Context budget is a target, not the window.** Filling a 200k window with the whole
  Codex on every message was the old bug. The budget is
  `min(model window − reply reservation, target)`, ~12k by default and user-tunable.
- **Retrieval-first for tight budgets.** When the model has tools and the budget is ≤16k,
  ship the codex *index* and let the model fetch documents on demand.
- **Publishing is clipboard-based.** RoyalRoad and Patreon have no usable write APIs;
  per-platform rich-HTML copy profiles are the answer, not scraping or automation.
- **Telemetry is dev-only.** Packaged builds never send anything. Never commit `.envrc`.

## Conventions

- **No backwards compatibility for internal shapes** unless the user says otherwise. If a
  type, schema, or IPC channel changes, change every caller and delete the old path — no
  compat shims, no dead branches. **User data is the exception**: migrations for existing
  novels and app state are written deliberately and carefully.
- **Strict TypeScript**, including `noUnusedLocals`/`noUnusedParameters`. Never use `any`
  to escape a type error.
- **Zod at every boundary** — IPC, files on disk, model output. `src/shared/ipc.ts` is the
  single source of truth for main↔renderer; add channels there first.
- **The preload surface stays minimal.** `invoke` and `on`, nothing more. Wanting to widen
  it means the logic belongs in main.
- **Never crash on hand-edited files.** Users are invited to edit their novel in any
  editor. Validation failures degrade with a readable message.
- **Comments explain why, not what** — non-obvious constraints, decisions that look wrong
  until explained. Match the density of the surrounding file.
- **Errors reach the user readably.** A novelist should be able to act on the message.

## Before saying a change is done

- `npm run test` and `npm run typecheck` both pass. Report failures with the output rather
  than working around them.
- For UI changes, actually verify them in the running app — don't infer from the diff.
- Say plainly what was verified and what wasn't.

## Verifying UI changes on the user's Mac

`npm i --no-save playwright-core`, `npm run build`, then a scripted `_electron.launch`
against `out/` (import `playwright-core` by absolute path; keep scripts in a scratch
directory outside the project). Stub the native folder picker via
`app.evaluate(({dialog}) => dialog.showOpenDialog = async () => ...)` to create or open
novels without native dialogs, and trigger menu items through `Menu.getApplicationMenu()`
lookup + `.click()`.

**Critical:** the app shares real userData at
`~/Library/Application Support/pandoras-gate/` — real novels in recents, downloaded
models, preferences.

- Back up `app-state.json` before the run and restore it byte-for-byte afterward.
- Check for an already-running `electron-vite dev` instance first and stop it; restart
  `npm run dev` for the user when you're finished.
- Uninstall `playwright-core` with `--no-save` when done.
- In dev, the macOS app menu shows "Electron" no matter what the template says. That's not
  a bug to fix.

## How we've been working

- **Assess, then build.** Large changes (the editor swap, context assembly rework) started
  with a written assessment and an agreed plan before code. Small ones don't need that
  ceremony.
- **Ship complete slices.** Commits here tend to be coherent feature batches with tests and
  docs included, not partial work to be finished later. If part of a task turns out to be
  blocked, finish everything else and say explicitly what was left out.
- **Docs are part of the change.** Behavior changes to context assembly belong in
  `docs/context-assembly.md`; new commands or workflows belong in `DEVELOPMENT.md`.
- **Push back when something's wrong.** The architecture decisions above came from
  disagreement, not agreement. State the concern once, clearly, then build what was asked.
