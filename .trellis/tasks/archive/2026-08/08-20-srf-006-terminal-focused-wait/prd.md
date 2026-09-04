# SRF-006 terminal-focused background wait

## Goal

Reduce model wakeups during long background supervision by adding an explicit terminal-focused form of the existing bounded `bash wait`, without changing its output-sensitive default.

## Requirements

- Add one provider-visible `wait` option whose omitted/default behavior remains the current output-sensitive operation byte-for-byte.
- When explicitly terminal-focused, consume and retain bounded incremental output through the existing serialized shared cursor, but return only for terminal state, caller cancellation, manager shutdown, or finite `waitMs` timeout.
- Return retained output exactly once with truthful offsets/`hasMore`; concurrent `output` or `wait` consumers must keep disjoint ordered cursor ranges and must not cause an early terminal-focused return.
- Preserve integer `waitMs` bounds of 1 through 30,000, task-id authority, UTF-8 handling, read-safe permission classification, and command non-interpretation.
- Preserve process-group ownership and bounded TERM-to-KILL cleanup.
- Update the authoritative backend contract, process-exit architecture wording, and focused real-process tests. Do not implement SRF-007 or SRF-008, mark the backlog row done, or edit `docs/iteration-log.md`.

## Acceptance Criteria

- [x] Existing wait calls still return promptly on output and retain their schema/result behavior when the new option is omitted.
- [x] Explicit terminal-focused waits aggregate intermediate output and wake only for terminal, cancellation, shutdown, or timeout.
- [x] Aggregation remains bounded and UTF-8 safe; output is returned incrementally once with explicit shared-cursor behavior under competing consumers.
- [x] Provider validation accepts the option only for wait, forwards it without executing redundant command text, and keeps wait read-safe.
- [x] `pnpm tsx spike/verify-background-bash.ts`, `pnpm typecheck`, and one final `pnpm test` pass.
- [x] Trellis artifacts validate, the task is archived, and all authorized changes are committed.

## Evidence and constraints

- Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md` F1 / SRF-006; 261 output-sensitive waits across the two supervised children.
- This extends SRF-003; its compatibility and cursor contracts remain authoritative.
- The Host owns independent acceptance, backlog closure, and iteration-log updates.
