# Background bash jobs

## Goal

Let the agent launch long-running shell commands without blocking the current turn, then inspect and control those commands through the existing `bash` tool while darwin remains responsible for every process it starts.

## Background

- The SDK-vended `bash` tool currently supports only blocking `execute` and `restart` modes. It owns a persistent shell per SDK `Agent`, and darwin explicitly restarts those shells during shutdown because their stdio handles otherwise prevent process exit.
- `AgentRuntime` is the production composition root. Both the Ink CLI and debug REPL call `runtime.shutdown()` in `finally`; the Ink CLI only arms its forced-exit fallback after shutdown completes.
- Main and child agents share the initialized environment-tool catalogue and intervention handler. Permission policy and lifecycle hooks classify calls by `(toolName, input)`, so background execution must remain one `bash` call rather than bypassing that boundary.
- Darwin already stores session-private state below `<projectRoot>/.darwin/sessions/<sessionId>/`.

## Requirements

### R1 — Background launch

- Extend `bash` with a background-start operation accepting a shell command.
- A successful start returns promptly after the OS confirms spawn, with a runtime-unique session-local task id, process id, and absolute output-file path; it does not wait for command completion.
- The command starts in the project root with the inherited environment. Foreground `execute` and `restart` retain their current persistent-shell behavior and return shape.
- Stdout and stderr are combined into the task's output file so output is available even when it is not being polled.

### R2 — Task status and incremental output

- The agent can query one task by id and receive a stable state: `running`, `succeeded`, `failed`, or `stopped`, plus command/process/timing/exit metadata and output size.
- The agent can read output incrementally by id. Per-task operations are serialized; each read starts at that task's remembered byte cursor, returns at most 64 KiB of complete UTF-8 text, reports whether more bytes are already available, and advances the cursor without duplicating or skipping bytes. The returned output path remains available when a full replay is needed.
- Completed tasks stay queryable until runtime shutdown. Their log files remain under the session directory after exit for inspection and resume diagnostics, but task control itself is not restored by `--resume`.
- Unknown or malformed ids fail clearly without reading arbitrary paths or affecting other tasks.

### R3 — Active stop

- The agent can stop a running task by id. Stopping is idempotent for an already-terminal task.
- Stop targets the command's process group, not only its shell leader, so typical dev-server/test-runner descendants are reaped.
- Stop first requests graceful termination, waits up to 500 ms, then escalates to `SIGKILL` and waits at most another 500 ms. The call itself cannot hang indefinitely, and concurrent/repeated stops resolve to one stable terminal state.

### R4 — Permissions and lifecycle hooks

- Starting a background command is classified exactly like foreground command execution: default mode asks, auto mode classifies, yolo runs, and existing `bash:<pattern>` allow-rules continue to match the command.
- Status, incremental output, stop, and restart are safe lifecycle/read operations because they can only observe or reduce session-owned work; they do not execute a new user-supplied command.
- Existing `PreToolUse` and `PostToolUse` hooks continue to see the operation as a `bash` tool call. Post hooks describe completion of the immediate start/status/output/stop operation, not eventual background-process completion.
- Main and subagents use the same session-owned background-task registry. A subagent may start a task and report its id; child persistent-shell cleanup must not terminate that background task.

### R5 — Exit and orphan prevention

- `AgentRuntime.shutdown()` explicitly stops all running background tasks and waits for bounded TERM→KILL cleanup alongside subagents, the parent persistent bash shell, and MCP clients.
- Normal process exit, including the CLI's forced `process.exit` fallback and the SDK's signal handlers, has a synchronous last-resort cleanup that kills any still-registered process groups.
- Natural leader exit runs the same bounded TERM→KILL group cleanup before the task becomes terminal; task status never claims completion while a known descendant still owns the group.
- Shutdown synchronizes with in-flight starts: once closing begins, no launch can escape the shutdown snapshot or spawn afterward.
- Cleanup failures are isolated so one task cannot skip cleanup of other tasks or resources, and an unconfirmed group remains registered for the synchronous process-exit fallback.

### R6 — Compatibility and documentation

- No dependency or config migration is introduced.
- Existing foreground bash behavior, permission rules, tool hooks, subagents, session persistence, cancellation, and TUI rendering remain compatible.
- README documents the new modes, output location/retention, incremental-read behavior, session-local scope, and shutdown guarantee.
- Backend specs record the process-group ownership and exit contracts.

## Acceptance Criteria

- [x] AC1: A background command returns a task id before the command finishes, writes delayed stdout and stderr to its reported file, and reaches `succeeded` or `failed` with accurate exit metadata.
- [x] AC2: Repeated and concurrent output reads return only newly available bounded complete UTF-8 content in order, expose `hasMore` when applicable, and do not allow a task id to become an arbitrary file read.
- [x] AC3: Status and concurrent/repeated stop work by id; stop is idempotent and terminates both the shell leader and a spawned descendant within the fixed TERM→KILL deadline.
- [x] AC4: Background start follows existing bash permission/rule semantics, while status/output/stop do not prompt; configured tool hooks still wrap each immediate bash operation.
- [x] AC5: Foreground execute/restart still preserve SDK persistent-shell behavior, and a child agent's normal cleanup does not kill a background task it started.
- [x] AC6: Runtime shutdown synchronizes with an in-flight start and reaps multiple running task process groups without waiting for their commands to finish; separate-process probes cover direct exit and SIGINT/SIGTERM with the SDK bash handlers loaded and demonstrate no surviving registered descendant.
- [x] AC7: `pnpm typecheck`, the focused background-bash suite, `pnpm test`, relevant subagent/permission suites, and the existing `bashExit` TUI scenario pass.
- [x] AC8: README and `.trellis/spec/backend/` document the final API, storage, permission, and process-lifecycle contracts.

## Out of Scope

- Background tasks that survive darwin exit, task restoration/control after `--resume`, cross-session task ids, scheduling, stdin/PTY interaction, terminal emulation, task listing, log rotation, and automatic restart.
- Windows support beyond the repository's existing host `bash` assumption; process-group management targets the same POSIX environment.
- Guaranteeing cleanup after uncatchable termination such as `SIGKILL` or machine failure.
