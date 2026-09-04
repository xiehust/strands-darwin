# Simplify developer to direct worker

## Goal

Make `/developer` launch one complete headless worker instead of a planning-only child followed by a
separate implementation process. The child owns its configured skills and repository workflow;
the Host owns scope, monitoring, independent acceptance, and focused correction.

## Requirements

- The first managed `darwin -p` turn must plan, create/maintain task artifacts, implement, verify,
  update specs, and commit as one direct worker invocation.
- The child may load relevant configured skills and use repository-approved helpers; it must not load
  `developer` or start another Darwin supervision recursion.
- Remove `DARWIN_PLANNING_ONLY`, plan-only output review, Host plan approval, and mandatory
  planning-to-implementation continuation from the developer workflow.
- Select one whole-worker `small`, `normal`, or `complex` soft/hard budget preset before launch.
- Keep context offload, independent tool batching, the test pyramid, managed background monitoring,
  exact session capture, token accounting, and independent Host acceptance.
- If acceptance fails, continue the captured session with a focused correction budget; compact first
  only after a large prior worker turn.

## Acceptance Criteria

- [x] Developer skill describes one direct first child and no planning-only phase.
- [x] First-child commands use `--yolo --context-offload --max-model-calls <worker-hard>` without
      `DARWIN_PLANNING_ONLY` or `--compact-before`.
- [x] Small/normal/complex whole-worker soft/hard presets and correction presets are documented and
      pinned by offline tests.
- [x] The direct child is explicitly free to load configured non-developer skills and own Trellis
      planning/implementation/check/commit lifecycle.
- [x] Live fixture expectations describe one direct worker start rather than mandatory two-phase
      starts; live test remains opt-in and is not run here.
- [x] Focused skills tests, typecheck, full offline suite, build/assets, completion, Trellis validation,
      and diff checks pass.
