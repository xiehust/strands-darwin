# Implementation plan

1. Read the runtime, TUI timer, trajectory/diagnostics, SDK OpenAI Responses adapter, `openai` streaming internals, and telemetry/local trace implementation.
2. Build small offline probes for each plausible periodic retention path and capture forced-GC heap/RSS evidence.
3. Turn the confirmed production path into a deterministic regression harness that fails on the unpatched implementation.
4. Apply the smallest owner-layer fix, including all completion/error/cancel cleanup paths.
5. Run the memory regression, affected subsystem checks, `pnpm typecheck`, and `pnpm test`.
6. Update the Strands SDK contract spec and task notes with the proven invariant, command, and evidence.

## Review gates

- Do not edit implementation until one path has a repeatable retained-memory slope and controls exclude the alternatives.
- Before finalizing, inspect the diff for accidental SDK-loop, stream, trajectory, context-offload, or frame-budget changes.
- No commit in this session.

## Rollback points

- The reproduction/probe is independent and can remain while implementation hypotheses change.
- The final fix is scoped to one owner-layer lifecycle and can be reverted without data migration.
