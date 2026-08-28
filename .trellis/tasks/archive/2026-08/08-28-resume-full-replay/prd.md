# Full transcript replay on interactive resume

## Goal

When an interactive session is resumed (`--resume` / `--resume <id>` / `--session <id>`), show the whole recorded session transcript as startup `<Static>` history — the same display history the live session produced — instead of only a bounded last-completed request/answer.

## Background

- Today `src/trajectory/resume-recap.ts` projects only the last closed turn's request/answer, bounded to 600 code points / 6 lines each, and states `earlier session transcript omitted`. The model conversation is fully restored (e.g. `140 restored model message(s)`); only the human-visible transcript is withheld.
- The user decision (2026-08-28) is option 3: full replay, like the live session's scrollback. This supersedes the "only a bounded last-completed request/answer" clause of the SER-028 load-bearing row.
- `replayRecords` (`src/trajectory/replay.ts`) already reconstructs display history for the whole record through the one authoritative `turnReducer` — the one-projection rule. The recap must reuse it, never grow a second formatter.

## Requirements

- Resumed interactive sessions seed startup `<Static>` history with the full replayed transcript of the resolved session's `trajectory.jsonl`: user rows, tool rows, assistant answers, `!` shell rows, notices — exactly what `replayRecords` reconstructs, in order.
- Keep the existing recap header notice (`resume recap · N restored model message(s) · read-only trajectory projection`) as the first row, and keep distinct explicit notices for: missing/unreadable record, trajectory disabled, damage, dropped replay payloads.
- The reader stays an observer: no model/network call, no write, no pointer move, no `agent.messages` mutation, no `messageCount` change; the record and resume pointer stay byte-identical (hash-asserted in tests).
- Fresh sessions and headless runs remain unchanged; `/clear` still discards the seeded history with the rest of the transcript.
- Remove the per-turn 600-code-point/6-line truncation and the `earlier session transcript omitted` notice for the replayed body. A very large record must not hang startup: state one bounded safety cap (records or bytes) only if measurement shows startup replay of a large real session (e.g. >=1 MiB trajectory) is pathological; otherwise replay everything and document that scrollback length equals session length.
- Live-frame invariants hold: seeded items are ordinary `<Static>` history (written once), never live-frame participants; the frame budget is untouched.

## Acceptance Criteria

- [x] Resuming a multi-turn session shows every turn's request, tool rows and answers in startup scrollback, consistent with `replayRecords` over the same file.
- [x] The recap header row and limitation notices (missing/disabled/damage/dropped) still appear and are distinct.
- [x] Trajectory file, snapshots and resume pointer are byte-identical before/after startup (hashes).
- [x] No SDK/model import enters `src/trajectory/resume-recap.ts` (structural grep stays in the suite).
- [x] `spike/verify-resume-recap.ts` updated to the full-replay contract; free pty `spike/verify-tui.ts resume` proves a real multi-turn resume renders earlier turns.
- [x] Specs/docs updated: `backend/session-trajectory.md` SER-028 section, `frontend/live-frame.md` reference, AGENTS.md load-bearing row, `docs/architecture/load-bearing-decisions.md` section.
- [x] `pnpm test`, `pnpm typecheck`, `git diff --check` pass.

## Out of Scope

- Changing replay/export formatting, the reducer, or trajectory record formats.
- Headless recap, model-side history, prompt recall, rewind catalogues.
- Pagination/interactive scrollback UI.
