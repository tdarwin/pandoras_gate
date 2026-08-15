<!--
Thanks for contributing! Nothing here is bureaucracy for its own sake — each line is
something a reviewer would otherwise have to ask you.
-->

## What changed

<!-- A sentence or two. What does the app do now that it didn't before, or stop doing? -->

## Why

<!-- The problem this solves. Link the issue if there is one: Fixes #123 -->

## How I verified it

<!--
Be specific and honest. "Ran the app, created a novel, saved a chapter, confirmed the
proposal appeared in the queue" is useful. "Should work" is not — and it's fine to say
which parts you couldn't test.
-->

- [ ] `npm run test` passes
- [ ] `npm run typecheck` passes
- [ ] Ran the app and exercised the change by hand (required for anything user-facing)

## Notes for the reviewer

<!-- Optional: tradeoffs you weighed, things you're unsure about, follow-ups you left out. -->

---

- [ ] This PR covers one concern (a fix plus an unrelated refactor should be two PRs)
- [ ] Docs updated if behavior changed — `docs/context-assembly.md` for context rules,
      `DEVELOPMENT.md` for commands or workflow, `README.md` for user-facing features
- [ ] No new runtime dependencies, or the description explains why one was needed
- [ ] No compatibility shims left behind for internal shapes (user-data migrations excepted)
