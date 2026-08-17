# Make developer budgets opt in

## Goal

Remove automatic model-call budgets from the single-worker developer workflow while retaining the
generic headless `--max-model-calls` option for explicit user/Host cost limits.

## Requirements

- Default direct-worker and correction commands use yolo plus process-only context offload, with no
  automatic `--max-model-calls`.
- Remove developer budget presets, soft/hard targets, and 80% checkpoints.
- Keep optional `--max-model-calls <n>` CLI/runtime behavior, tests, docs, and failure semantics.
- Keep tool batching, test pyramid, managed monitoring, exact session capture, independent Host
  acceptance, and correction-only same-session continuation.
- Keep correction `--compact-before` conditional on a large prior worker turn.

## Acceptance Criteria

- [x] Developer skill defaults contain no budget preset or automatic max-model-calls flag.
- [x] Developer skill states explicit user/Host budgets may add the generic CLI flag.
- [x] Live fixture expects one direct worker using yolo/context-offload only.
- [x] README and developer spec distinguish optional generic CLI insurance from default workflow.
- [x] Focused skills tests, typecheck, full offline suite, build/assets, completion, Trellis validation,
      and diff checks pass.
