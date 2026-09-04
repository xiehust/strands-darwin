# Design — foreground bash: `/dev/null` stdin per command, process-group kill on timeout

## Where the change lives

Only the pinned SDK patch, file `dist/src/vended-tools/bash/bash.js`, class `BashSession`
(`start()`, `run()`, `stop()`), plus one sentence in the darwin-owned description in
`src/tools/background-bash.ts` (`createBackgroundBashTool`). `runtime.ts` is untouched: the
tool is still the SDK singleton shape constructed by `createForegroundBashTool(projectRoot)`.

## Option analysis (measured with a Node probe against real bash, all cases ≤ 21 ms)

| Option | Result | Verdict |
|---|---|---|
| A. Wrap each command write as `{\n<command>\n} </dev/null` before the sentinel lines | `cat`, `read -t`, prompts read EOF; `cd`/variables persist (a brace group is not a subshell); heredocs, `python3 - <<EOF`, trailing `# comment` all unchanged; a syntax error kills the non-interactive shell exactly as today (rc 2) | **chosen** — one string change, no process topology change |
| B. `bash /dev/fd/3` with the command stream on fd 3 and stdin `/dev/null` | fails: Node's extra `'pipe'` stdio is a socketpair, and reopening a socket through `/dev/fd/N` is `ENXIO` | rejected |
| C. `bash -c 'exec bash /dev/fd/3 3< <(exec cat) </dev/null'` — a `cat` bridge turns the socket into a real pipe | identical behavior to A, but adds a process, a buffering hop and a second holder of the stdout/stderr pipes that `close` must wait for | rejected — more moving parts for the same result |
| D. Heuristic detection of interactive programs | not structural; the sentinel-theft hazard stays for any unlisted reader | rejected |

Known, accepted difference of A: an `alias` defined on one line and used on a later line of the
*same* command no longer expands (the whole group is parsed before execution). Across separate
calls aliases behave as before. Models do not write aliases in tool calls; noted in the spec.

Why the group must close on its own line: a trailing `# comment` on the command's last line
would otherwise comment out `}`. The `\n}` form is what the probe validated.

`$?` after the group is the group's status, i.e. the last command's — identical to today's
`__darwin_exit_code=$?` semantics.

## Process-group kill on timeout (R5)

Today `stop()` is `this._process.kill()` — SIGTERM to bash only; the child bash was waiting on
survives as an orphan (probe: `sleep` reparented to pid 1). Change:

- `start()` spawns with `detached: true` so the shell leads its own process group (same as the
  background manager does). Nothing else about the spawn changes (cwd, env with `PS1`/`PS2`
  emptied, `stdio` default pipes).
- `stop()` sends `SIGTERM` to the group (`process.kill(-pid, 'SIGTERM')`) and arms one unref'd
  bounded `SIGKILL` to the group; `ESRCH` is swallowed. The bound reuses the background
  manager's existing TERM→KILL grace constant by value — the spec must state they stay equal, as
  it already does for `TIMEOUT_TAIL_LIMIT`/`OUTPUT_LIMIT`.
- `close` handling, `activeSessions`, `_cwd` reset and the lazy replacement shell are unchanged.
- Darwin's `retire()`/`shutdown()` path goes through `invoke({ mode: 'restart' })` → `stop()`, so
  it inherits the group kill; it must not wait on the KILL timer (unref'd, fire-and-forget), so
  exit time does not grow.

## Tool description (R4)

Append one sentence to the darwin-owned description in `createBackgroundBashTool`, next to the
existing ssh sentence:
"Foreground execute runs with stdin from /dev/null: anything that prompts or reads stdin gets EOF
at once and fails, so pass the command's non-interactive flags (-y, --yes, --force, --no-input)."
The SDK `DEFAULT_DESCRIPTION` is not shown to the model (the wrapper's description is) and is
left alone.

## Compatibility

- Result shape `{ output, error, cwd }`, `BashSessionError`, `BashTimeoutError` (SER-054 message
  and fields), `SHELL_RESTART_NOTICE`, the wrong-root preflight (runs on the raw command before
  wrapping), Pre/Post hooks and permission (see the raw input, not the wrapper) — all unchanged.
- Trajectory records the tool input as the model sent it; the wrapper never appears anywhere the
  user or the model can read.
- Children/subagents share the same tool factory, so they get the same behavior.

## Cancellation (R7, option B)

`createBash`'s callback passes `context.cancelSignal` into `session.run(command, timeout, signal)`.
In `run()`:
- Before `start()`/write: if `signal.aborted`, reject with the cancelled failure (below) without
  spawning or writing; the per-Agent queue therefore drains a cancelled backlog instantly.
- After the write: `signal.addEventListener('abort', onAbort, { once: true })`, removed in the
  existing `cleanup()`. `onAbort` mirrors the timeout branch exactly: `cleanup()`, `this.stop()`
  (group TERM→KILL), then reject immediately — it does not wait for `close`, so the caller sees the
  result at once while the KILL leg finishes on its unref'd timer.
- The failure is a `BashSessionError` (existing class; no new type) built with the SER-054 helpers:
  first line `Command was cancelled and its process group was killed (SIGTERM, then SIGKILL after
  500 ms).`, then `describeTail(...)` for stdout and stderr (same `TIMEOUT_TAIL_LIMIT`), then the
  same `Persistent bash shell was killed with the command; it will restart before the next command
  with cwd: …` sentence. Fields: `output`, `error`, `cwd` (initial cwd), `cancelled: true`;
  `exitCode`/`signal` stay undefined because the shell's close is not awaited.
- Restart mode ignores the signal (it is synchronous and already the reaper).

The SDK stops the loop with `stopReason: 'cancelled'` after the tool settles; darwin's
`runtime.cancel()` → `agent.cancel()` is the only trigger, so TUI Esc and headless Ctrl+C both reach
it. Darwin's synthetic tool contexts already pass a never-aborting signal (spec § SDK pin), so
nothing else changes.

## Rollback

Revert the patch hunk via `pnpm patch … --edit-dir` and the one description sentence; no data,
config or schema is touched.
