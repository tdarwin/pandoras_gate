# Contributing to Pandora's Gate

Thanks for wanting to help. This is a small project with a clear point of view, and
contributions of every size are welcome — a typo fix, a bug report with good repro steps,
or a whole feature.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

**Report a bug.** [Open a bug report](https://github.com/tdarwin/pandoras_gate/issues/new/choose).
The most useful reports include what you expected, what happened, and the app version. If
the app misbehaved with a model, say which model and provider — remote and local models
fail in very different ways.

**Request a feature.** [Open a feature request](https://github.com/tdarwin/pandoras_gate/issues/new/choose)
describing the writing problem you're trying to solve, not just the feature you have in
mind. The problem is usually the more useful half.

**Improve the docs.** If something in the README or [DEVELOPMENT.md](DEVELOPMENT.md) was
wrong or missing when you needed it, that's a real bug.

**Write code.** See below.

## Before you write code

For anything beyond a small fix, **open an issue first** and say what you're planning.
This project has some settled architectural decisions — flat files as the source of truth,
markdown that users never see, local models as first-class — and a heads-up saves you from
building something that has to be turned away. The reasoning behind those decisions is in
[CLAUDE.md](CLAUDE.md), which despite the name is a readable summary of what's settled and
why.

Issues labelled `good first issue` are scoped to be approachable without a tour of the
whole codebase.

## The workflow

1. **Fork** the repository on GitHub and clone your fork.

   ```bash
   git clone https://github.com/YOUR-USERNAME/pandoras_gate.git
   ```

2. **Set up** your environment — see [DEVELOPMENT.md](DEVELOPMENT.md).

   ```bash
   cd pandoras_gate && npm install && npm run dev
   ```

3. **Branch** from `main` with a descriptive name.

   ```bash
   git checkout -b fix/chapter-reorder-drops-status
   ```

4. **Make the change.** Match the style of the code around it. Add tests for logic that
   has rules worth protecting — context assembly, publish profiles, parsing, anything that
   handles model output.

5. **Check your work.** Both of these must pass; CI won't merge a PR that fails either.

   ```bash
   npm run test && npm run typecheck
   ```

   If you changed the UI, run the app and confirm the change actually behaves — a green
   test suite doesn't tell you the panel renders.

6. **Commit** with a message that says what changed and why. Look at
   `git log` for the house style: a short imperative summary, and a body when the reason
   isn't obvious from the diff.

7. **Push and open a pull request** against `main`. Fill in the template: what changed, why,
   and how you verified it.

## What makes a PR easy to merge

- **One concern per PR.** A bug fix plus an unrelated refactor is two PRs.
- **You verified it yourself**, and the PR says how.
- **Tests for logic, manual verification for UI** — and honesty about which you did.
- **Docs updated alongside behavior.** Changes to context assembly belong in
  `docs/context-assembly.md`; new commands or workflows belong in `DEVELOPMENT.md`.
- **No new dependencies without a reason.** Say why in the PR description; this app ships
  to users' machines and every dependency comes along.
- **No compatibility shims.** If a shape changes, change every caller and delete the old
  path. The exception is user data — migrations for existing novels and app state are
  written deliberately.

## What tends to get turned away

Not to discourage you, just so nothing is a surprise:

- Moving the source of truth off flat files, or into a database
- Exposing raw markdown or YAML in the writing surface
- Cloud accounts, required sign-in, or telemetry in packaged builds
- Treating local models as a degraded path
- Large unsolicited refactors

If you think one of these is worth revisiting, that's a conversation worth having — open an
issue and make the case.

## Releases

Maintainers cut releases by tagging; `.github/workflows/release.yml` handles the rest.
Contributors don't need to bump versions or touch the Homebrew cask, which the workflow
regenerates and pushes to [tdarwin/homebrew-tap](https://github.com/tdarwin/homebrew-tap).

If your change is something a user would notice, add a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md) — that file becomes the release notes, so describe what
changed for someone writing a novel, not what changed in the diff. Internal refactors,
test-only changes, and build tweaks don't need an entry.
Note that forks build unsigned automatically — the signing and cask steps skip themselves
when the secrets aren't present, so CI on your fork should be green.

## Questions

Open an issue — questions about how something is meant to work are welcome there, not just
bug reports. If you'd like to support the project beyond code, there's a
[Patreon](https://patreon.com/TDarwin).
