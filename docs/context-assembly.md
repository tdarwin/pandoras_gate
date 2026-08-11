# What the AI sees: context assembly

Every AI operation (chat, drafting, Codex updates, outlining, chapter edits) builds its
context fresh from your files each time. Nothing is "remembered" between messages except
the visible chat history — which is why the Clear button resets the conversation but not
the token count: the story materials below are re-sent with every message.

The budget is the model's context window minus room reserved for its reply. Sections are
added in priority order; when the budget runs out, low-priority sections degrade (get
trimmed) and then drop, always bottom-up. The chat panel's context inspector shows
exactly what was included, trimmed, or dropped for the last message.

## Chat and drafting (the assembler)

| Priority | Section | Always/Optional | Degrades to |
|---|---|---|---|
| 1 | System prompt + your per-novel AI instructions | **Always** (never cut) | — |
| 2 | Recent chat history | Always (chat only) | Oldest turns dropped, never below the last 4 |
| 3 | The open chapter, full text | Always when a chapter is open | Head + tail with the middle elided (capped at ~50% of budget) |
| 3.5 | Chapter outline, then novel outline | Optional — **top priority when drafting**, after synopsis in chat | Truncated, then dropped |
| 4 | Novel synopsis (`metadata/synopsis.md`) | Optional | Truncated, then dropped |
| 5 | World/system docs (`metadata/world/*`) | Optional — each doc separately | Truncated, then dropped |
| 6 | Character profiles | **Conditional**: only characters whose name or alias appears in the open chapter, recent chat, or your message | Frontmatter facts only (prose body dropped) |
| 7 | Chapter summaries | Optional: previous 2 chapters in full, older ones as one-line loglines | Collapsed, then dropped |
| 8 | Glossary terms | Conditional: only terms appearing in recent text | Dropped first |
| 8 | Timeline | Optional: last 10 events | Dropped first |

Notes:
- **Character matching is by name/alias string match.** A character never mentioned in
  the open chapter or conversation is not loaded — mention them by name to pull in
  their profile.
- **Drafting** uses the same ladder but with a prose-only system prompt and outlines
  promoted to the top, plus a larger reply reservation.

## Codex updates (the pipeline)

When the Codex pipeline runs (button, auto-run, or the agent's `update_codex` tool), the
model receives — without a token-budget ladder, since these documents are small:

- The full text of the chapter being analyzed (always)
- The current synopsis, glossary, and timeline (always, if they exist)
- The chapter's previous summary (if any)
- Character docs for characters mentioned in the chapter, plus a list of ALL existing
  character files (so it reuses slugs)
- All world/system docs

## Chapter edits (`edit_chapter`)

The revision generation gets only: the chapter's current text + your instructions. It
deliberately excludes the wider Codex to keep the model focused on the text in front of
it — mention specifics in your instructions if they matter.

## Token counting

Counts are estimates (~4 characters per token with a 10% safety margin) for both remote
and local models. Real usage reported after each reply (the "in/out" numbers under the
chat input) comes from the provider and is exact.
