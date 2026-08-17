# Design: token-efficient developer supervision

## 1. Boundary

The optimization has two layers:

- **Headless runtime controls** are ordinary opt-in CLI/runtime capabilities: a per-process model-call
  ceiling, a process-only context-offload override, and an explicit compact-before-turn operation.
- **Developer policy** composes those controls with tighter prompts: budget tiers, batched independent
  tools, phase-aware compaction, and a verification pyramid.

The SDK loop remains authoritative. Darwin uses `BeforeModelCallEvent` to refuse a call before it is
sent, the existing `ContextOffloader` plugin for tool-result offload, and the existing reversible
`AgentRuntime.compact()` implementation for phase compaction.

## 2. CLI and runtime contracts

Extend `CliOptions` with headless-only fields:

```text
maxModelCalls: number | undefined
contextOffloadOverride: true | undefined
compactBefore: boolean
```

Flags:

```text
--max-model-calls <positive integer>
--context-offload
--compact-before
```

`RuntimeOptions` receives `maxModelCalls` and `contextOffloadOverride`. The runtime derives one
`effectiveContextOffload = override ?? config.contextOffload === true`; it does not mutate the loaded
`AppConfig`, `/model` session fields, or the config file. A budget hook registered on the parent Agent
increments immediately before each SDK model call and throws before call `limit + 1`. Children still
use their own model/runtime and are outside the parent headless process budget; the developer prompt
forbids nested delegation already.

The headless runner creates/restores the runtime, optionally awaits `runtime.compact()`, then starts
its one requested turn. Compaction is before `turn.started` in structured output because the public
turn has not started yet. If compaction fails, the existing runtime-stage failure path performs strict
shutdown and emits no assistant result.

## 3. Developer defaults

The built-in workflow uses these soft workflow defaults as hard CLI ceilings:

| Phase | Ceiling |
|---|---:|
| Planning | 20 model calls |
| Implementation | 120 model calls |
| Correction/retry | 40 model calls |

Every child invocation enables `--context-offload`. The implementation continuation adds
`--compact-before`, paying one summary operation to remove the planning transcript before expensive
implementation loops. Corrections add `--compact-before` only when the prior child usage/output or
observed context was large; narrow corrections otherwise keep cached continuity without a needless
summary call.

The child prompt requires independent read/search/status calls and independent offline checks to be
issued together. Writes, commits, and commands depending on earlier results remain serial.

## 4. Verification pyramid

- During edits: reproduce the issue, run the smallest focused suite, then typecheck.
- Before the child commits: run the full project gate once after source settles.
- After commit: run commit/diff/status checks only unless source changed.
- Host acceptance: independently run the full project gate once.

A failing focused/full check is corrected and rerun; the rule removes duplicate green runs, not
failure diagnosis.

## 5. Compatibility and failure

No flag means no behavior change. Interactive invocations reject the tuning flags rather than
silently ignoring them. A model budget error is a normal turn failure and preserves the session for a
follow-up process with a fresh budget. Context offload still uses session-scoped durable storage and
its existing retrieval tool. Compact-before preserves the existing rollback/persistence contract.
