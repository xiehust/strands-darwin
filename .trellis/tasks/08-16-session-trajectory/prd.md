# Append-only session trajectory with search, fork and replay

Backlog direction `SER-003` (origin report `docs/research/research_2026-08-15.md`, source S3:
DeepSeek Harness records model-visible activity in one append-only event stream, and that single
stream is what powers trajectory inspection, resume, fork, search and replay).

## Goal

Give darwin a durable, append-only record of what actually happened in a session, and the three
primitives that a record makes possible: search over past trajectories, fork of an existing
session into a new one, and replay of a recorded session with no model calls.

Darwin already persists SDK snapshots, so `--resume` works — but a snapshot is the *end state* of a
conversation, not a record of it. Nothing today can answer "what did the agent run in that session
two days ago", branch a conversation without destroying the original, or re-read a session offline.

## Background

- `AgentRuntime.send` (`src/agent/runtime.ts`) is the single place every `AgentStreamEvent` flows
  through, for all three drivers: `src/tui/App.tsx`, `src/headless.ts`, `src/dev-repl.ts`.
- `AgentRuntime.create` is the single assembly point, and `.trellis/spec/backend/strands-sdk-contracts.md`
  forbids forking or intercepting the SDK agent loop.
- Every SDK stream event class has a `toJSON()` that returns `type` plus its own payload and
  deliberately excludes `agent` / `invocationState`
  (`node_modules/@strands-agents/sdk/dist/src/hooks/events.d.ts`), which is the safe serialization seam.
- Per-session state already lives beside the snapshots: `BackgroundBashManager` writes
  `<sessionsDir>/<sessionId>/background/`, the context offloader writes
  `<sessionsDir>/<sessionId>/offload/`.
- `src/tui/turn-state.ts` already owns the projection from SDK events onto rendered history, so
  replay must reuse it rather than grow a second renderer.
- Subagent children are separate `Agent`s invoked privately by `SubagentTool`; their events never
  pass through `AgentRuntime.send`.

## Requirements

1. **Observer/adapter, never a fork of the loop.** Recording sits between `agent.stream()` and the
   `yield` in `AgentRuntime.send`. It cannot change what the caller receives, cannot reorder or
   swallow events, and cannot make a turn fail.
2. **Append-only.** Bytes already written are never rewritten, truncated or reordered. A second turn
   appends after the first; an interrupted turn leaves a valid prefix. Readers tolerate a trailing
   partial line and interior malformed lines, and report both.
3. **Bounded.** Per-string, per-record and per-file caps, with every truncation recorded.
4. **Degrades, never blocks.** A write failure surfaces a notice and the session keeps working
   (`.trellis/spec/backend/error-handling.md`).
5. **Storage beside existing per-project session state**, derived from an explicit `projectRoot`.
6. **Child isolation preserved.** No subagent event is recorded anywhere; only the parent's own
   `subagent` tool call and its returned result, which already reach parent context.
7. **`fork` never mutates its source session**; **`replay` makes zero model calls** and needs no network.
8. **No new frame row in the TUI.** No header change; the permission box keeps its height.
9. **No new runtime dependency.**

## Decisions (fixed before implementation)

- Recording is **on by default** (`trajectory: false` disables it): unlike `contextOffload` it changes
  nothing the model sees, and snapshots plus background logs are already written unconditionally.
- `--session <id>` becomes valid in interactive mode, so a fork can be opened in the TUI.
- Fork copies the snapshot and `offload/`, and fails if the offload copy fails; it does not copy
  `background/` and never touches `last-session.json`.
- `search` exits 0 on zero matches (printing `no matches`), 1 for a missing/unreadable record, 2 for usage.
- One read-only TUI command, `/trajectory`; `MAX_COMPLETIONS` grows 8 → 9.
- Reasoning is recorded as presence only, never as text.
- The recorded event set is a semantic allowlist, with per-type dropped counts written into the
  record so its lossiness is self-describing.

## Acceptance Criteria

- [ ] Two recorded turns append: the first turn's bytes are byte-identical afterwards, and `seq` continues.
- [ ] A truncated/partial trailing line is tolerated by the reader and reported, and the next append
      cannot glue itself onto the broken line.
- [ ] Caps are enforced and each truncation is recorded with path, original and kept sizes.
- [ ] A write failure degrades: the turn is unaffected, a problem is surfaced once, nothing throws.
- [ ] Search finds a known event and reports a missing session honestly rather than guessing.
- [ ] Fork creates a usable new session and leaves the source snapshot and trajectory byte-identical.
- [ ] Replay reconstructs the stated history with zero model calls, and is deterministic.
- [ ] Recording does not alter the event sequence a caller of `AgentRuntime.send` observes.
- [ ] No subagent-internal content appears in the record; parent messages are unchanged by recording.
- [ ] `pnpm typecheck`, `pnpm test` (including the new `spike/verify-trajectory.ts`),
      `pnpm tsx spike/verify-tui.ts completion`, `git diff --check`, and Trellis validation pass.
- [ ] Replay correctness — what it guarantees and what it explicitly does not — is written down in
      `.trellis/spec/backend/session-trajectory.md`.

## Out of Scope

- Session garbage collection or pruning of old trajectories (there is none for snapshots, offload or
  background logs either; the per-file byte budget is the bound).
- Rebuilding a resumable agent from a trajectory: snapshots remain the sole authority for resume.
- Recording subagent transcripts, in any location.
- Regex or structured query language for search; a bounded substring match is the surface.
- Editing, redacting or rewriting a recorded trajectory.
