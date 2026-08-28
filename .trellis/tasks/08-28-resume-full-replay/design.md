# Design: full transcript replay on interactive resume

## Approach

Keep the module boundary and observer contract of `src/trajectory/resume-recap.ts`; change what it projects.

1. `loadResumeRecap` still opens exactly `options.file` via `readTrajectory` and reports damage via `describeDamage`.
2. `projectResumeRecap` stops slicing the last closed turn. Instead it feeds the whole record list through `replayRecords(records, ...)` (`src/trajectory/replay.ts`) and returns `result.history` — the reducer-built `HistoryItem[]` — prefixed by the existing recap header notice and followed by limitation notices (damage, dropped records) when present.
3. Delete or repurpose `boundRecapText` / `RESUME_RECAP_TEXT_*` and the `earlier session transcript omitted` notice. If a bounded safety cap is demonstrably needed for pathological records, cap by trailing records with one explicit leading omission notice (`resume replay omitted first N records`); default expectation is no cap.
4. Ensure replayed history item ids cannot collide with live ids generated later in the session (`nextId` counters); namespace seeded ids (existing recap items already use a `resume-recap-` prefix — extend the same discipline, or offset the reducer's counters by seeding through the same `initialHistory` path App already handles).
5. `src/cli.ts` call site keeps its shape (`loadResumeRecap({ file, restoredMessages, trajectoryEnabled })`); no new options unless the cap is added.

## Why this stays safe

- One projection: `replayRecords` + `turnReducer` remain the single reconstruction path (same as `/export` and `trajectory replay`). No second formatter appears.
- Observer rules already proven for replay: `src/trajectory/**` imports no Agent/Model/runtime; structural grep in the suite continues to enforce it.
- `<Static>` startup history is written once; the frame budget only governs live rows, so seeding more history does not touch `frame-budget.ts`.
- Partial trailing lines / mid-write reads are already tolerated by `readTrajectory`; the recap inherits that behavior unchanged.

## Affected checks and docs

- `spike/verify-resume-recap.ts`: rewrite projection assertions (multi-turn fixture; full history equality against `replayRecords`; header + limitation notices; byte-zero mutation hashes; structural import grep).
- `spike/verify-tui.ts resume`: extend the fixture session to two+ turns and assert an early-turn marker string renders after resume.
- Spec/doc updates: `.trellis/spec/backend/session-trajectory.md` (SER-028 section), `.trellis/spec/frontend/live-frame.md` (resume recap mention), `AGENTS.md` row, `docs/architecture/load-bearing-decisions.md` § Resumed-session human recap.

## Risks

- Very large sessions print a long scrollback at startup; accepted by user decision. Terminal cost is one-time `<Static>` writes, not per-render.
- Duplicate-id collisions between seeded and live history would break React keys — covered by a focused check.
