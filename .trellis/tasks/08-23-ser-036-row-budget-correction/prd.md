# SER-036 checklist row-budget correction

## Goal

Correct live and final checklist rows so long model-authored items cannot exceed their counted visual-row budgets.

## Requirements

- Render every formatted live plan row with explicit truncate-end wrapping so one claimed row is exactly one visual row at narrow widths.
- Give final Static checklist rows an explicit intentional one-row truncate-end policy; its bounded item count must also be an honest visual-row bound.
- Add adversarial narrow-width long-item rendered-height assertions for live and final projections.
- Preserve plan validation, status markers, hidden-item counts, lifecycle, trajectory semantics, and all unrelated behavior.

## Acceptance Criteria

- [ ] The adversarial live render contains exactly the granted row count at narrow width.
- [ ] The adversarial final Static render contains its exact bounded row count at narrow width.
- [ ] Focused plan, frame-budget, and free pty suites plus typecheck pass.
- [ ] The correction is committed with a clean worktree.
