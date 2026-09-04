# Optimize developer workflow token efficiency

## Goal

Reduce the model-call count, repeated context reads, and redundant verification in the built-in
`developer` supervision workflow without weakening its planning gate, same-session continuity,
independent Host acceptance, permission boundary, or headless output contracts.

## Requirements

1. Child invocations must have explicit per-process model-call ceilings, with separate defaults for
   planning, implementation, and correction turns. Reaching a ceiling must stop before another
   provider request and fail visibly; it must never synthesize success.
2. The built-in developer workflow must tell children to batch independent reads/searches/status
   checks and independent offline checks in one assistant message, while keeping writes and dependent
   actions serial.
3. Planning-to-implementation continuation must compact the restored conversation before the
   implementation turn and enable session-scoped context offload without persisting either choice to
   the target project's global configuration.
4. A later correction should compact only after a large prior turn, not mechanically before every
   narrow fix; context offload remains enabled for every child turn.
5. The workflow must enforce a test pyramid: minimal reproduction and focused suites while editing,
   one child full gate after the source settles, and one independent Host full gate. A commit alone
   is not a reason to rerun the full suite.
6. CLI tuning flags must be headless-only, validated before runtime construction, passed explicitly
   into `AgentRuntime`, and preserve existing text/JSON/JSONL lifecycle and exit semantics.
7. Existing callers that do not opt into the tuning flags must behave byte-for-byte as before.

## Acceptance Criteria

- [x] `--max-model-calls <positive integer>` blocks the next SDK model call after the configured
      number, with an actionable deterministic error.
- [x] `--context-offload` enables the existing SDK ContextOffloader for that process/session without
      rewriting `~/.darwin/config.json`.
- [x] `--compact-before` runs `AgentRuntime.compact()` after restore and before the requested turn;
      compaction failure prevents the turn.
- [x] All three flags are rejected without `-p/--print`; missing, repeated, zero, negative, decimal,
      or nonnumeric budgets are usage errors before runtime/model construction.
- [x] The developer skill names the default budgets, tool-batching rule, phase compaction/offload
      policy, and test pyramid, and its offline contract suite pins those instructions.
- [x] Focused CLI/runtime tests, model-budget tests, context-offload tests, `pnpm typecheck`,
      `pnpm test`, `pnpm build`, asset checks, completion PTY, Trellis validation, and
      `git diff --check` pass without live model calls.

## Constraints

- Do not add dependencies or fork the SDK agent loop.
- Do not count compaction's direct summarizer calls as child-loop budget calls; compaction is an
  explicit phase operation with its own visible failure.
- Do not change interactive `/compact`, normal configuration defaults, or non-developer headless
  invocations unless they opt into the new flags.
