# SER-031 retrieval seam research

## Authoritative direction

`docs/research/research_2026-08-21.md` accepts one narrowly scoped capability: a visible, explicit, read-only `search_memory` model tool over the existing project trajectory substring search. It rejects vectors, embeddings, generated memories, a hand-edited memory store, derived indexes, ambient startup injection, automatic post-turn mining, and a bespoke TUI surface.

## Existing seams

- `src/trajectory/search.ts` owns case-insensitive literal matching, `searchableText` traversal, 160-code-point excerpts, session/turn/type provenance, damage reporting, snapshot-only session reporting, and hit limits.
- `src/trajectory/record.ts#searchableText` remains the sole definition of searchable recorded content.
- `src/agent/runtime.ts#AgentRuntime.create` is the sole parent Agent assembly boundary. Tools registered before the `childTools = agent.tools` snapshot are inherited by default child agents and filtered by existing explicit child allowlists.
- `src/agent/permission.ts#classify` deliberately fails unknown tools closed; the new known tool needs an explicit `read` classification so plan mode permits it.
- Existing `ToolCallPanel` / `ToolCallResult` behavior renders any ordinary model tool call and result. No App or live-frame component change is needed.

## Design conclusions

- Add one trajectory-domain adapter that constructs an SDK tool and calls `searchTrajectories`; do not change the CLI search call or matching semantics.
- Exclude the current runtime session by passing it as an exclusion to the shared search function. The default CLI behavior remains unchanged because the option is absent there.
- Bound model-controlled input and output independently: a Unicode-code-point query cap, a small hit cap, a bounded number of sessions scanned/reported, and a final Unicode-code-point result cap.
- Preserve honesty in the textual projection: identify every hit by session/turn/type, report tolerated damage, snapshot-only sessions, omitted sessions, active-session exclusion, no-match state, and hit/result limit cuts.
- Test the real tool callback offline against real trajectory and snapshot files; hash all source bytes and the resume pointer before/after; structurally reject model/network calls, extra persistence, system-prompt/startup injection, and bespoke TUI code.
