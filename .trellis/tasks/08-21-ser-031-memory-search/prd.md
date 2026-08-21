# SER-031 explicit project memory search

## Goal

Give Darwin explicit, project-scoped long-term recall through a bounded read-only `search_memory` model tool over the existing append-only trajectory substring search.

## Requirements

- Reuse `searchTrajectories` and `searchableText`; retrieval is case-insensitive literal text only.
- Add no vector or embedding dependency, generated summary, derived index, memory database, second persistent store, state file, or writer.
- Exclude the active runtime session by default so the current just-durable user query cannot retrieve itself.
- Return bounded source-labelled excerpts with session, turn, and record type provenance.
- State no-match, tolerated trajectory damage, snapshot-only/missing-record sessions, omitted sessions, active-session exclusion, and hit/result limit cuts honestly.
- Validate and bound model-controlled query and result sizes using Unicode code points; bound sessions scanned and hits returned.
- Retrieval occurs only when the model explicitly calls the tool. Do not inject trajectory data at startup, into the system prompt, or through automatic post-turn mining.
- Register the tool at the sole parent Agent assembly boundary before the existing child-tool snapshot. Default children inherit it and explicit child allowlists retain their existing filtering semantics.
- Classify `search_memory` as read-safe, including plan mode; unknown tools remain fail-closed.
- Use the ordinary model tool lifecycle and existing rendering. Add no slash command, TUI panel, frame row, timer, modal, completion slot, or key binding.
- Preserve the existing `darwin trajectory search` API, formatting contract, and tests.
- Update the session-trajectory/SDK/error/TUI contracts and README/AGENTS load-bearing index where the new explicit disclosure exception must be documented.
- Do not modify the authoritative research report, backlog status/evidence, or iteration log.

## Acceptance Criteria

- [x] Real offline tool invocation over seeded project trajectories proves case-insensitive matches and bounded session/turn/type provenance across older sessions while excluding the active session.
- [x] Seeded Unicode/long fields, damaged tails, snapshot-only sessions, no-match searches, enough sessions/hits to cross limits, invalid/oversized queries, and result truncation all produce explicit bounded, code-point-safe results.
- [x] Hashes of every trajectory and the resume pointer are byte-identical before and after; structural checks prove no model/network call, embeddings/vectors, generated summary/index, state file, writer, startup injection, or system-prompt mutation.
- [x] Permission checks prove `search_memory` is read-safe in normal and plan modes while an unknown tool remains `execute`/fail-closed.
- [x] Runtime assembly proves the parent exposes the tool and child agents receive it through ordinary eligible-tool inheritance while explicit child allowlists can omit or include it.
- [x] Structural/rendering checks prove calls/results use ordinary tool UI with no new live-frame surface.
- [x] Existing CLI trajectory search contracts remain green.
- [x] Focused suites pass, then `pnpm typecheck`, exactly one complete `pnpm test` after source settles, `pnpm build`, Trellis validation, and git diff/clean-tree checks pass.
