# SRF-008 leading argv separator

## Goal

Accept one conventional argv-leading standalone `--` transport separator so direct and package-script Darwin invocations reach the same CLI grammar.

## Requirements

- Remove exactly one standalone `--` only when it is the first Darwin argument, before subcommand routing and ordinary option parsing.
- Preserve strict errors for a second leading separator, separators elsewhere, unknown flags, and option values equal to `--`.
- Preserve subcommand routing, bare `--resume`, headless/TUI selection, cwd/path/session behavior, and all existing error text after normalization.
- Add no-model regression coverage for direct and separated ordinary arguments and subcommands, plus the strict negative cases.
- Preserve accepted SRF-006 and SRF-007 behavior; do not edit backlog state or `docs/iteration-log.md`.

## Acceptance Criteria

- [x] Direct and one-leading-separator TUI/headless argument shapes normalize to identical parsed options without model calls.
- [x] Direct and one-leading-separator `sessions` invocations have identical process results.
- [x] A second leading separator, a later separator, a separator used as a value, and an unknown flag retain exact strict usage errors.
- [x] Focused CLI regression coverage, `pnpm typecheck`, and one final `pnpm test` pass.
- [x] Trellis artifacts validate, the completed task is archived, and all authorized changes are committed.

## Evidence and constraints

- Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md` F3 / SRF-008.
- The Host owns backlog closure and `docs/iteration-log.md`.
