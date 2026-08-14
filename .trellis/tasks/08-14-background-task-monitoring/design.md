# Background task monitoring — design

## Architecture and ownership

Keep `BackgroundBashManager` as the single source of task truth. Add two read-only boundaries over the same map:

1. `list()` snapshots all registered tasks for the wrapped `bash` tool and `AgentRuntime`.
2. `subscribe(listener)` publishes terminal task snapshots to mounted UI consumers.

Do not poll log files or infer task state in React. The manager already owns every transition and is the only layer that can guarantee one event per terminal transition. Main and child agents continue sharing this manager, so listing and notices cover either origin without new coordination.

## Manager and tool contract

Add `list` to the tool mode enum. It accepts no `taskId`, `command`, or `timeout` and returns `BackgroundTaskStatus[]`. `BackgroundBashManager.list()` snapshots the insertion-ordered map through the same per-task serialization used by `status`, preserving launch order while ensuring each returned status is internally coherent.

Add a manager listener type receiving an immutable `BackgroundTaskStatus` snapshot. `finish()` remains the only terminal transition point; after assigning state/time it obtains the terminal snapshot and notifies a copied listener set once. Listener failures are isolated so UI code can never break process cleanup. Subscription returns an unsubscribe closure.

Because snapshot currently stats the log asynchronously, terminal publication should happen after serialized cleanup and snapshot collection rather than turning `finish()` itself async in every call path. The implementation will centralize terminal transition plus publication in one awaited helper (or equivalent single state-change path) so stop and natural exit cannot double-notify. Shutdown-triggered stops use the same transition semantics; once Ink unmounts, its listener is already removed.

## Runtime boundary

Expose narrow `AgentRuntime.listBackgroundTasks()` and `subscribeToBackgroundTasks(listener)` methods. The TUI must not reach into a private manager or call the agent-facing tool. Direct runtime reads avoid recording local `/tasks` as a model tool call while reusing exactly the same manager data.

## TUI flow

- Reserve and advertise `/tasks` with other built-ins.
- Handle `/tasks` before the busy-agent guard, alongside `/usage` and `/effort`. It clears the draft, records the user's local command, obtains a manager snapshot, and appends one dim report notice. `/tasks <arg>` is also intercepted and reports that arguments are unsupported.
- Mount one effect that subscribes to terminal snapshots and dispatches a dim notice. Reducer dispatch is independent of `status`, so a completion can append to `<Static>` during streaming without calling `turnEnded`, changing active tools, cancelling the model, or waiting for input.
- Use shared pure formatters for task ids, command summaries, elapsed duration, list rows, and completion notices. Compute elapsed milliseconds from ISO timestamps, clamp negative/invalid values defensively, normalize command whitespace, and truncate summaries with an ellipsis.

The notice is intentionally transcript history rather than a live toast: it is non-modal/dim, cannot steal keyboard focus, remains visible in terminal scrollback, and naturally renders whether idle or busy.

## Compatibility and error behavior

- `list` joins `restart/status/output/stop` as a statically safe bash lifecycle operation.
- Existing hooks observe agent calls to `bash list`; local `/tasks` is not a tool call and therefore does not run project tool hooks, matching `/usage` and other local commands.
- Missing tasks is a successful empty list, not an error.
- A bad listener is dropped only for that callback invocation; task lifecycle and other listeners continue.
- No resume/persistence migration. A resumed conversation begins with an empty current-process registry, exactly as today.

## Verification strategy

Extend the focused background-bash suite for empty/populated ordering, schema rejection of irrelevant fields, safe permission classification, exactly-once success/failure/stop events, unsubscribe, and listener-failure isolation. Add pure formatter coverage; extend the zero-model completion scenario for `/tasks`; and add a focused real-pty/model scenario that starts a short runtime-managed job, proves idle notification, then exercises `/tasks` during an active turn and verifies non-interruption. Preserve bounded process assertions and existing exit regressions.
