# What the AI sees: context assembly

Every AI operation (chat, drafting, Codex updates, outlining, chapter edits) builds its
context fresh from your files each time. Nothing is "remembered" between messages except
the visible chat history — which is why the Clear button resets the conversation but not
the token count: the story materials below are re-sent with every message.

## The budget: a target, not the whole window

The budget is `min(model window − reply reservation, target)`. The target keeps prompts
lean on huge-window models — without it, a 200k-context model would receive the entire
codex with every message. By default the target is automatic (~12k tokens, drifting up
to ~24k on very large windows); Preferences → "Story context size" pins it to ~8k/16k/32k.

Sections are added in priority order; when the budget runs out, low-priority sections
degrade (get trimmed) and then drop, always bottom-up. The chat panel's context
inspector shows exactly what was included, trimmed, or dropped for the last message —
including the fixed cost of the agent's tool instructions and schemas when the model
supports tools, and which mode assembly ran in.

## Lean (retrieval-first) mode

When the model supports tools AND the budget is tight (≤ 16k — small local models, or
a pinned Compact/Roomy context size), assembly goes retrieval-first. The prompt core is
just: system prompt, chat history, synopsis, outlines, **codex index**, recent chapter
summaries, timeline tail, and the open chapter. World docs, character profiles, and the
glossary stay on disk — the index lists each doc's path with a one-line description,
and the model is instructed to fetch full docs on demand with `read_codex_doc` (and
`find_in_chapter` for chapter text) before answering anything that depends on them.

Index descriptions come from a `logline:` frontmatter field, which the Codex pipeline
now maintains on character and world docs; docs without one fall back to role/status
(characters) or their first sentence. In full mode with tools, the index is still
appended so the model knows what else it can fetch beyond what was included.

## Chat and drafting (the assembler)

| Priority | Section | Always/Optional | Degrades to |
|---|---|---|---|
| 1 | System prompt + your per-novel AI instructions + tool overhead | **Always** (never cut) | — |
| 2 | Recent chat history | Always (chat only) | Oldest turns dropped, never below the last 4 |
| 3 | The open chapter, full text | Always when a chapter is open | Head + tail with the middle elided (capped at ~50% of budget) |
| 3.5 | Chapter outline, then novel outline | Optional — **top priority when drafting**, after synopsis in chat | Truncated, then dropped |
| 4 | Novel synopsis (`metadata/synopsis.md`) | Optional | Truncated, then dropped |
| 5 | World/system docs (`metadata/world/*`) | Optional — docs named in the chapter first; each doc capped (~1.5k tokens), all docs together capped at ~25% of the budget | Truncated, then dropped |
| 6 | Character profiles | **Conditional**: only characters whose name or alias appears (as a whole word) in the open chapter, recent chat, or your message | Frontmatter facts only (prose body dropped) |
| 7 | Chapter summaries | Optional: previous 2 chapters in full, the rest as one-line loglines | Farthest chapters shed first — the recent full summaries are the last to go |
| 8 | Glossary terms | Conditional: only terms appearing (as whole words) in recent text | Dropped first |
| 8 | Timeline | Optional: last 10 events | Dropped first |

Notes:
- **Matching is whole-word.** A character named "Al" no longer matches "always"; mention
  a character by name to pull in their profile.
- **Drafting** uses the same ladder but with a prose-only system prompt and outlines
  promoted to the top, plus a larger reply reservation.
- **Presentation markup rides along.** Chapters may contain the Pandora dialect —
  `::: {…}` styled blocks, `[text]{font="…"}` spans, `![alt](assets/…)` images (see the
  README's "Richer styling" section). It stays in the text the model sees; the system
  prompts say it is presentation, not canon, and the section-edit tool is instructed to
  preserve it verbatim.

## Prompt caching and message layout

The system message is laid out for prompt caching: stable story materials first
(synopsis, outlines, world docs, the chapter's cast, summaries, glossary, timeline),
then anything matched only from the conversation, then the open chapter last. The stable
prefix is byte-identical across turns while your files are unchanged, so:

- **Anthropic models via OpenRouter** get explicit `cache_control` breakpoints (one at
  the stable-prefix boundary, one at the end of the prior transcript) — unchanged story
  context is re-read from cache at a fraction of the input price.
- **OpenAI/Gemini models** cache long identical prefixes automatically.
- **Local models** benefit the same way through llama.cpp prompt-prefix reuse.

## Codex updates (the pipeline)

When the Codex pipeline runs (button, auto-run, or the agent's `update_codex` tool),
the model receives, within a budget of the model's window minus a 4k reserve for its
JSON reply — sections claim room in priority order and oversized docs are truncated:

- The full text of the chapter being analyzed (middle elided beyond ~55% of budget)
- The chapter's previous summary (if any)
- The current synopsis, glossary, and timeline (if they exist)
- Character docs for characters mentioned in the chapter, plus a list of ALL existing
  character files (so it reuses slugs)
- All world/system docs (capped per doc)
- A "not shown for space" list of any docs that didn't fit, so the model never
  recreates a doc it simply couldn't see

## Chapter edits (`edit_chapter`)

The revision generation gets only: the chapter's current text + your instructions. It
deliberately excludes the wider Codex to keep the model focused on the text in front of
it — mention specifics in your instructions if they matter. Presentation markup in the
chapter (styled blocks, font spans, image links) must survive edits unchanged; the tool
descriptions carry that instruction.

## Token counting

Counts are estimates (~4 characters per token with a 10% safety margin) for both remote
and local models. The reply reservation (a quarter of the window, capped at 4k tokens)
is also passed to the provider as a real output cap. Real usage reported after each
reply (the "in/out" numbers under the chat input) comes from the provider and is exact.
