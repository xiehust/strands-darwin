# Implementation plan

1. Add the bounded plan contract/custom tool and focused real-SDK validation tests.
2. Register the tool parent-only and classify it as advisory/read-only; test parent/child and permission boundaries.
3. Extend the reducer with transient latest-plan state and one final history entry.
4. Add shared bounded formatting, live/final components, and a frame-budget claim; test rows and ANSI markers.
5. Add an offline free pty scenario and trajectory/replay assertions.
6. Update load-bearing specs/index, run focused checks, typecheck, then full test once, build, Trellis validation, and diff review.
7. Commit and archive the accepted task.

Rollback is deletion of the isolated tool/formatter/component plus the narrow reducer/runtime/budget wiring; no migration or durable data cleanup exists.
