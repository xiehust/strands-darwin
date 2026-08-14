# Background bash jobs — design

## Architecture and ownership

Add `src/tools/background-bash.ts` as a session-owned process manager and `bash` tool adapter. `AgentRuntime` remains the composition root:

1. Construct one `BackgroundBashManager` with `projectRoot` and the resolved session id.
2. Construct one wrapped `bash` tool that delegates `execute`/`restart` unchanged to the SDK-vended tool and handles background operations through the manager.
3. Register that same wrapped tool with the main agent and therefore in the initialized child-tool catalogue. Main and subagents consequently share task ids and ownership, while the SDK still keeps a distinct persistent foreground shell per `Agent` because delegation passes the caller's tool context through unchanged.
4. Shut the manager down explicitly from `AgentRuntime.shutdown()`.

This keeps one `bash` name and one permission/hook boundary. A separate management tool would make existing `bash:<pattern>` rules and configured `bash` lifecycle hooks silently miss background starts.

## Tool contract

Extend the current discriminated input with these modes:

- `execute { command, timeout? }`: delegated verbatim to the SDK-vended `bash` tool.
- `restart`: delegated verbatim to the SDK-vended `bash` tool.
- `start { command }`: create a managed background task and return its id, PID, and log path immediately.
- `status { taskId }`: return current task metadata and output byte count.
- `output { taskId }`: read from the manager-owned cursor, bounded by a fixed byte limit, and report the next cursor plus `hasMore`.
- `stop { taskId }`: terminate the process group and return the final state.

Use a Zod discriminated union so background modes cannot smuggle irrelevant `command` fields into safe management calls. Keep the existing SDK schema behavior for delegated `execute`/`restart` inputs rather than tightening unrelated foreground compatibility. Generate opaque runtime-unique ids (for example `bg-<randomUUID>`), and create log files collision-safely so resuming the same session id cannot overwrite prior diagnostics. Lookups are only against the in-memory map and never converted into paths.

The wrapper returns JSON-compatible objects for background operations and preserves the SDK's existing `BashOutput | "Bash session restarted"` values for foreground operations.

## Process and file model

`start` creates `<projectRoot>/.darwin/sessions/<sessionId>/background/` and a per-task `.log` file, then spawns:

```text
/bin/bash -lc <command>
```

with `cwd: projectRoot`, inherited environment, `detached: true`, and stdout/stderr both attached to the opened log file descriptor. `detached` makes the child the leader of a new POSIX process group, so signaling `-pid` reaches the shell and descendants. The parent closes its copy of the log descriptor as soon as spawn succeeds (and on spawn failure); the child retains its inherited descriptors. The child object is retained while running and listeners update state on `close`/`error`. The task records command, PID, timestamps, exit code/signal, state, log path, and read cursor.

The child is not `unref()`ed during normal runtime: ownership is intentional, and darwin must not appear able to exit while work it owns survives. Output is file-backed rather than buffered in memory; the tool only materializes bounded chunks.

When the leader exits naturally, retain its exit metadata but do not expose a terminal state until the same bounded process-group TERM→KILL cleanup used by `stop` confirms the group is gone. This prevents a command that backgrounds descendants and exits from escaping ownership. The process group's existence, rather than only the leader's state, is the cleanup boundary. A `stopRequested` marker has precedence over close/error callbacks, so explicit stop settles as `stopped`; otherwise exit code `0` settles as `succeeded` and nonzero/spawn failure as `failed`.

`start` is itself tracked before its first await. It reserves the id/log path, performs setup, rechecks the manager's closed flag immediately before spawn, and only resolves success on the child's `spawn` event. Manager shutdown first latches closed, then awaits all tracked launch attempts before collecting/stopping tasks. A launch can therefore either fail before spawn or become visible to shutdown, never appear after the cleanup snapshot.

Each task owns a small promise chain that serializes status/output/stop state transitions. Concurrent output calls consume disjoint cursor ranges, and concurrent stops share one termination operation.

## Incremental output

`output` stats the known task log and reads up to 64 KiB from the task's current cursor, extending by at most three bytes only to complete the final UTF-8 code point. It advances only through bytes represented in returned text and returns start/end offsets plus whether file size is still greater than the new offset. An incomplete suffix in a still-growing file remains unread until a later call; at terminal EOF, malformed bytes decode with the normal replacement character so polling cannot stall forever. Tests include a split multibyte character, malformed terminal bytes, and output larger than one chunk.

If a retained log was removed or became unreadable, status still reports task metadata and `output` returns a clear task-log error; it never substitutes another path.

The log path is returned from start/status so a user can inspect or delete retained logs outside the model-facing bounded API. Old logs are not automatically pruned in this MVP.

## Stop and shutdown

`stop(taskId)` is idempotent. For a running task:

1. send `SIGTERM` to `-pid`;
2. poll for group disappearance for at most 500 ms;
3. send `SIGKILL` to `-pid` if anything remains;
4. poll for at most another 500 ms, then return the observed state while retaining an unconfirmed group in the global fallback registry.

`shutdown()` marks the manager closed so no new task can start, then stops all running groups concurrently with `Promise.allSettled`. `AgentRuntime.shutdown()` runs manager shutdown alongside subagent shutdown, parent persistent-shell restart, and MCP disconnect. The manager does not get cancelled on per-turn cancellation: background work is explicitly detached from a turn and remains controllable in later turns.

The module also keeps a process-global set of active process-group ids and installs one idempotent last-resort synchronous `exit` handler that sends `SIGKILL` to every still-registered group. Do not depend on a later SIGINT/SIGTERM listener: the SDK-vended bash module registers signal handlers that call `process.exit()`, whose `exit` event is the reliable composition point. Explicit runtime cleanup removes a group only after confirming disappearance; an unconfirmed group remains until process exit. Separate-process probes load the SDK bash module and cover direct `process.exit`, SIGINT, SIGTERM, normal manager shutdown, and a CLI-style delayed forced exit.

## Permissions and hooks

Update bash classification by mode:

- `execute` and `start`: `execute` permission kind with the command detail and normal static/auto/default/yolo behavior.
- `restart`, `status`, `output`, `stop`: `read` permission kind and statically safe risk.

`start` keeps the input field named `command`, so existing specific suggestions and `bash:<pattern>` matching work without changing the rule format, including chained-command and redirection restrictions. Permission assessment only derives suggestions for dangerous requests; safe management calls neither reach the bridge/classifier nor internally manufacture an `all bash` offer.

The wrapper is registered as the Agent's `bash` tool and the existing intervention handler remains attached to the Agent, so configured Pre/Post hooks observe every immediate outer call. This is proven through an actual Agent invocation in the focused suite. No eventual process-exit event is injected into the SDK loop.

## Subagents and foreground cleanup

Subagents receive the same wrapped tool instance from the main initialized catalogue. Direct invocation by a child still supplies the child `Agent` in `ToolContext`, so delegated SDK `execute`/`restart` keeps per-agent persistent shell state. Background modes ignore agent identity and use the shared manager.

`SubagentTool`'s existing `stopBashSession(child)` invokes wrapped `restart`; that only restarts the child's SDK foreground shell and does not touch manager-owned background jobs. A child can therefore start a long job, finish its report, and hand the task id back to the parent.

## Compatibility, risks, and rollback

- No stored config or SDK session schema changes. Retained logs are additive session artifacts.
- The wrapper depends only on the SDK's public `bash.invoke()` contract and Node process APIs; it does not fork the SDK loop or copy its foreground-shell implementation.
- POSIX negative-PID process-group signaling is an explicit platform assumption matching the existing host `bash` tool.
- The highest-risk area is process teardown. Focused tests must assert actual leader/descendant disappearance within deadlines and spawn a separate CLI probe to cover process-exit cleanup.
- Rollback removes the wrapper/manager, restores `[bash, fileEditor, ...]`, and removes the narrow permission/docs/spec/test changes. Logs require no migration.
