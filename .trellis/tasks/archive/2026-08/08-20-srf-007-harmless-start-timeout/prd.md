# SRF-007 harmless start timeout

## Goal

Accept a valid timeout field in background bash start mode while dispatching exactly manager.start(command); add real-launch schema regression coverage and minimal contract docs.

## Requirements

- Accept the existing positive numeric `timeout` shape on `mode: 'start'` as redundant input.
- Dispatch `start` with or without `timeout` identically as `manager.start(command)`; never turn it into a background execution or lifetime timeout.
- Preserve execute/restart compatibility and every non-start lifecycle mode's current field validation.
- Preserve start permission classification, command text, raw permission/hook input, and manager/process behavior.
- Add focused schema, dispatch, permission/hook, and real-process regression coverage.
- Update only the authoritative background-bash contract and its process-exit architecture summary; do not implement SRF-008 or edit backlog/iteration-log state.

## Acceptance Criteria

- [x] Provider validation accepts positive numeric `timeout` for `start` and still rejects arbitrary or misplaced lifecycle fields.
- [x] A dispatch regression proves omitted and supplied `timeout` both call only `manager.start(command)` with identical command text.
- [x] Permission and Pre/Post hook regressions preserve the supplied raw start input including `timeout` without changing execute classification.
- [x] A real background launch with a shorter redundant timeout outlives that value and completes normally.
- [x] `pnpm tsx spike/verify-background-bash.ts`, `pnpm typecheck`, and one final `pnpm test` pass.
- [x] Trellis artifacts validate, the task is archived, and all authorized changes are committed.

## Evidence and constraints

- Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md` F2 / SRF-007.
- Preserve accepted SRF-006 terminal-focused wait behavior from `6350c8f` and closure `afc33e1`.
- The Host owns backlog closure and `docs/iteration-log.md`.
