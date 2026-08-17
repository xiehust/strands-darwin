# Tune developer workflow budget tiers

## Goal

Keep the new developer workflow cost guardrails while preventing uniform low hard limits from
mechanically interrupting complex planning, implementation, or correction work.

## Requirements

- Reclassify 20/120/40 as normal-workflow soft targets, not provider-call hard stops.
- Introduce documented `small`, `normal`, and `complex` phase presets selected by repository evidence
  before the first child launch.
- Use higher hard ceilings that remain explicit CLI `--max-model-calls` values: normal work should
  have room beyond its soft target, while complex work is not forced through a normal preset.
- Preserve process-only context offload, phase compaction, tool batching, test pyramid, same-session
  continuity, and independent Host acceptance.
- Keep the generic CLI flag as a hard ceiling; only developer policy chooses preset values.

## Acceptance Criteria

- [x] Developer skill distinguishes soft targets from hard ceilings and states behavior at 80% of a
      hard ceiling.
- [x] Presets cover small, normal, and complex work with phase-specific values.
- [x] Host chooses and reports one preset before launching planning; later phases use that preset.
- [x] Existing runtime hard-ceiling tests remain green and workflow/docs/tests no longer describe
      20/120/40 as universal hard limits.
- [x] Focused skills tests, typecheck, full offline suite, build/assets, completion, Trellis validation,
      and diff checks pass.
