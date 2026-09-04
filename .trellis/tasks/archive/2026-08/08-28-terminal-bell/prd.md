# PRD — Terminal attention bell (SER-043)

Origin: docs/research/backlog/directions-061-080.md, Priority 61 (SER-043); report
docs/research/research_2026-08-28.md, run 13:03:31Z (rolled tui path).

## Problem

Darwin never signals the terminal. A user who tabs away misses the two moments that
need them: a permission prompt waiting for an answer, and a turn finishing.

## Requirement

A config-gated terminal attention bell:

- Exactly one BEL (`\x07`) written when a permission prompt is published to the user,
  and exactly one when a turn completes — interactive TUI driver only.
- Off by default. When off, behavior is byte-identical to before the feature existed
  (no bell write reachable at all on the default path).
- BEL goes to the real stdout, never rendered as an Ink row: no new frame surface, no
  effect on ANSI-stripped pty assertions, `/export` byte-stability, replay, or the
  frame budget.
- Never emitted per frame render, never in headless drivers (`-p`/structured), never
  for child agents, never inside lifecycle hook command execution.

## Design

- **Config**: new session-scoped boolean `terminalBell` in `src/config.ts`, following
  the `contextOffload` field pattern — `SessionFields`, `SESSION_KEYS`, `DEFAULTS`
  (`false`), `booleanField` validation. Non-boolean → `ConfigError`, refuse to start
  (error-handling spec: config is explicit intent). Session key ⇒ survives `/model`
  and is refused inside a `models` entry.
- **Emission seam**: the two existing driver-owned lifecycle publication points:
  - permission: the `PermissionQueue` observer callbacks in `cli.ts` `runInteractive`
    (the same seam that publishes `PermissionRequest` to lifecycle hooks — fires once
    per prompt as it becomes current, with identity dedup on re-ask);
  - turn complete: the `finally` block in App.tsx `runTurn`, next to
    `runtime.observeTurnComplete(outcome, 'interactive')` — all outcomes, one per turn.
- **Module**: `src/tui/terminal-bell.ts` exporting `ringTerminalBell(enabled, write?)`;
  disabled is a pure no-op (no write call).

## Acceptance Criteria

- [x] `spike/verify-config.ts` covers the key: absent → false, true/false accepted,
      non-boolean refused with the field named, survives `models` form + `/model`,
      refused inside a model entry.
- [x] New free pty suite `spike/verify-terminal-bell.ts` (registered in
      `run-tests.ts`): offline tool-calling model through the real `src/cli.ts`; with
      bell enabled raw pty output holds exactly one `\x07` at permission publication
      and one more per completed turn; with bell disabled zero `\x07` anywhere. No
      model call.
- [x] `pnpm typecheck` and full `pnpm test` green.
- [x] Grep-level proof: no `\x07` write reachable from headless drivers or per-render
      code; default-off path performs no write.

## Out of scope

OSC title writes, notification payloads, focus tracking, new frame rows, trajectory
changes, headless drivers, backlog record status (Host closes it),
docs/research/research_2026-08-28.md batch-outcome section.
