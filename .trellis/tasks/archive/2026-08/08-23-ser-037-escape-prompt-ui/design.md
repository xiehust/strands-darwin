# Design

## Boundary and state

`Escape` remains in `App.tsx`'s existing input precedence: global interrupt/exit, permission ownership, display controls, then compaction ownership. Only the editable prompt branch gains dismissal.

A pure completion-query identity describes the currently offered menu from draft plus cursor. `App` keeps the dismissed identity in an immediate ref/state mirror. Rendering filters only when the current identity equals that dismissed identity; any draft/cursor change that produces a different identity re-arms completion automatically. The same mirror is consulted by Tab/Enter/arrow handling and acceptance so batched stdin events cannot act on a menu already dismissed before React commits.

Recall needs no new durable state: `Escape` clears the existing mirrored `PromptRecall` and leaves `editorRef` untouched. With no active walk, later arrows fall through to the established eligibility and cursor rules.

## Side-effect boundary

Dismissal changes only transient React UI state. It does not call `submit`, dispatch a notice or transcript action, touch the queue/runtime/trajectory, start path scanning, or add a frame surface. Permission `Escape` returns before this branch; compaction returns before it too.

## Non-goals

No keybinding configuration, no automatic restoration of the same dismissed query, no change to completion candidate ordering/matching, no change to recall history I/O, and no backlog closure.
