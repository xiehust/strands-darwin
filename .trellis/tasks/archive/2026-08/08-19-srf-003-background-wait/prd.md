# SRF-003 bounded background bash wait

## Goal

Reduce empty model polling while supervising session-owned background commands by adding one bounded wait operation that returns status and newly available output together.

## Requirements

- Extend the provider-facing `bash` tool with `mode: 'wait'` for an existing task.
- Require an integer `waitMs` from 1 through 30,000 and document that exact finite bound.
- Return promptly when consumable output arrives, the task reaches a terminal state, the bound expires, the caller is cancelled, or manager shutdown starts.
- Consume output through the existing per-task serialized byte cursor, preserving UTF-8 boundaries, order, and non-duplication.
- Keep `execute`, `restart`, `start`, `list`, `status`, `output`, and `stop` compatible. A wait must never execute or reinterpret `command`.
- Classify wait as a safe/read lifecycle operation.
- Preserve session-owned process groups and bounded TERM-to-KILL cleanup on stop, shutdown, natural leader exit, and process exit.
- Do not change the SDK loop or add dependencies.

## Acceptance Criteria

- [x] Tool schema and description expose exact wait input and return semantics.
- [x] Focused real-process coverage proves immediate output, quiet timeout, terminal transition, ordered single-consumer output including UTF-8/log growth, concurrency, bounded duration, cancellation, shutdown, and existing reaping behavior.
- [x] Invalid/missing ids and irrelevant fields follow existing mode contracts; wait cannot dispatch a command.
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm tsx spike/verify-background-bash.ts` pass.
- [x] Background-bash contracts and load-bearing documentation describe the new invariant.

## Evidence and constraints

- Authoritative evidence: `docs/reflections/reflection_2026-08-19_session-20260819-094621980.md` F1 / SRF-003 and the in-progress SRF-003 row in `docs/research/backlog_index.md`.
- Preserve the Process exit invariant in `AGENTS.md` and `docs/architecture/load-bearing-decisions.md`.
- The Host owns backlog acceptance closure and iteration-log supervision evidence.
