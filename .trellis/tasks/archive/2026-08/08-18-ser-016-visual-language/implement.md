# Implementation plan

1. Capture current render APIs, row planners, test seams, and baseline header shape.
2. Add semantic visual roles and apply them across all five target TUI surfaces with minimal structural changes.
3. Add deterministic render assertions, including ANSI-stripped hierarchy and header row count.
4. Run focused rendering/frame checks and typecheck; fix issues before broader validation.
5. Update live-frame/TUI testing specs, README transcript, task notes, and SER-016 bookkeeping.
6. Run the project gate, named free PTY scenarios, live 120x50 approve scenario, Trellis validation, and diff checks.
7. Commit authorized work and verify the tree is clean.
