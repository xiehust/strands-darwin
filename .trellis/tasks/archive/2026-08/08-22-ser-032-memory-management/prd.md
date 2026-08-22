# SER-032 local memory management

## Goal

Add a bounded, offline, user-only `/memory` command for inspecting and narrowing the SER-031 project memory store and explicitly adding screened user-authored project context.

## Requirements

- Grammar is exactly `/memory`, `/memory list`, `/memory show <id|number>`, `/memory forget <id|number|all>`, and `/memory remember <note>`; identifiers are safe local IDs and numbers refer to the current bounded listing.
- List/show report project scope, stable ID, origin/provenance, known freshness (`unvalidated`, never claimed current), and sensitivity-screen state. Generated and user-authored entries are visibly distinct.
- Extend the bounded store with one strictly validated, versioned authoritative manifest. Generated entries retain SER-031 provenance and record heuristic sensitivity filtering plus unvalidated freshness. User notes retain authored provenance/time. Malformed, oversized, symlinked, or forged state is refused.
- Forget writes bounded durable suppression for generated IDs so deterministic SER-031 rebuilds cannot restore forgotten entries. Forget all suppresses all currently known generated entries and removes all current user notes. Unknown targets do not write.
- Remember is a bounded explicit local write only. It rejects prompt boundaries, likely secrets/dumps, malformed text, count overflow, and oversize input atomically; generated rebuilds preserve it.
- Successful mutations atomically commit authoritative state and synchronously replace the current runtime's Darwin-owned learned-memory prompt block before the command returns. Prompt order remains base → project instructions → official skills → learned memory → working context → one final cache point. Fresh/resumed/`/clear` runtimes read the narrowed state.
- The command performs no model/network/MCP/reconnect/trajectory/snapshot/resume/config work, adds no model tool or live row, and emits one bounded transcript notice.
- Preserve Host-owned dirty research/log files unchanged and add no dependencies.

## Acceptance Criteria

- [ ] Canonical completion and `/help` include `/memory`; every built-in remains visible within the raised completion cap.
- [ ] Off, absent, empty, and corrupt stores report honestly; list/show output and all fields are finite and Unicode-safe.
- [ ] Show/forget resolve one safe ID or bounded list number without traversal or escaping symlinks.
- [ ] Forget one/all narrows authoritative disk state and the live prompt before completion; rebuild, resume, and `/clear` cannot restore suppressed generated entries.
- [ ] Remembered notes are screened, bounded, durable across rebuild, distinguishable, prompt-loaded as fallible context, and unavailable through any model-facing persistence path.
- [ ] Focused offline checks hash unrelated state around every command and verify no model call; relevant prompt/cache/clear/resume/completion/help/frame suites, typecheck, full `pnpm test`, Trellis validation, build, and AGENTS size all pass.

## Source and constraints

- Direction: `docs/research/research_2026-08-22.md`, run `2026-08-22T03:02:03Z`, S8–S11 and current-Darwin evidence.
- SER-033 code-anchor validation, aging, expiry, edit/import/export, search, vectors, and network features are out of scope.
- Host-owned `docs/research/backlog_index.md`, `docs/research/research_2026-08-22.md`, and `docs/iteration-log.md` are read-only.
