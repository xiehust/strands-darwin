# Design — SER-038 lifecycle observation hooks

## Contract shape

Extend the hook config type with `TurnComplete` and `PermissionRequest`, using the same strict group shape (`matcher`, `hooks`) and command shape (`type: command`, `command`). Lifecycle matchers apply to the event source label so the existing bounded glob language remains useful without inventing schema.

Lifecycle payloads are closed discriminated objects. The runner serializes once, rejects an over-cap serialization rather than truncating invalid JSON, appends one newline, and sends that same object independently to every matching command.

## Observer ownership

Add a session-scoped `LifecycleHookRunner` beside tool hooks. It owns detached process groups and exposes synchronous `publish`, `cancel`, and `close` operations. `publish` starts matching commands and returns immediately. Child stdout/stderr are drained and discarded; errors and exit status are internal only. `cancel`/`close` signal all owned groups TERM and schedule KILL after 500 ms; child close clears ownership/timers.

`PermissionQueue` receives an optional observation callback. It emits when a request first becomes `current`, including promotion after answer/withdrawal. A per-entry published flag guarantees exactly once. The callback cannot settle the permission promise.

Interactive and headless drivers publish `TurnComplete` from existing outer turn boundaries. They classify abort as `cancelled`, ordinary completion as `success`, and thrown non-abort errors as `failure`. The source is `interactive` or `headless`.

## Session lifecycle

The CLI builds one lifecycle runner from the already-loaded project policy and passes it to the permission queue and driver. Runtime retirement/clear and turn cancellation request lifecycle cancellation; final shutdown closes the runner. No lifecycle runner is constructed when config has neither lifecycle key, ensuring absent config cannot spawn.

## Safety invariants

- No lifecycle code imports SDK Agent/intervention types.
- No lifecycle result is awaited by turn, permission, tool, TUI, headless output, or trajectory paths.
- No command output or failure leaves the runner.
- No payload includes user prompt, model answer, tool input/output, permission reason, paths, or trajectory ids.
- The exact allowed event set is a TypeScript discriminated union and strict config key set.
