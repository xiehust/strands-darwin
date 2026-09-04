# Bash tool: interactive commands must fail fast, not hang to timeout

## Goal

Foreground bash tool commands that read stdin (interactive prompts) currently block until the tool timeout with no output; make them fail fast with a clear, bounded result and state the rule in the tool description.

## Background (confirmed from evidence)

Origin: `session-20260904-054434460`. The model ran
`trellis update 2>&1 | tail -60` (timeout 300) in foreground `execute`; the trajectory ends at
`beforeToolCallEvent` with no result. `trellis update --dry-run` reproduces the cause: it finds
`AGENTS.md` "Modified by you (need your decision)" and asks `Proceed? (Y/n)`.

Why it hangs (SDK `vended-tools/bash/bash.js`, pinned patch): the persistent shell is
`spawn('bash', [])` whose **stdin is the socket the tool writes commands into**. Every foreground
child inherits that socket as its stdin, so:

1. An interactive prompt waits on a stream nobody answers → the call sits silently until the
   tool timeout (here 300 s; `| tail` additionally hides all partial output).
2. Worse and not limited to prompts: **any command that reads stdin steals the sentinel lines**
   the tool appends after the command (`__darwin_exit_code=$?`, exit-code/cwd sentinels,
   `echo <sentinel>`). Measured with a probe: after a bare `cat`, every following command in that
   shell is swallowed and echoed back as text — the shell is wedged until the timeout kills it.
3. The timeout `stop()` only `kill()`s bash. Bash dies, but the foreground child it was waiting
   on is reparented to pid 1 and keeps running (probe: `sleep 123.456` survived the shell's
   SIGTERM). A hung `trellis update` therefore outlives its own timeout until darwin exits.

Background mode (`src/tools/background-bash.ts`, `stdio: ['ignore', …]`) and `!` shell commands
(`src/tui/shell-command.ts`, `stdio: ['ignore', …]`) already give children `/dev/null`; only the
foreground persistent shell has this problem.

Confirmed fail-fast behavior of the origin case: `trellis update < /dev/null` exits 130 at the
prompt immediately, mutating nothing.

## Requirements

- R1 — Foreground `execute` children get `/dev/null` as stdin. An interactive prompt or a bare
  stdin reader (`cat`, `read`, `python3` with no script) reads EOF and finishes immediately
  instead of waiting for the timeout; the command's own exit code, stdout and stderr are reported
  through the ordinary result exactly as for any other finished command (no new error type, no
  special-casing of "interactive").
- R2 — The sentinel channel cannot be consumed by the command: the exit-code, cwd and end
  sentinels always reach bash, so a stdin-reading command can no longer wedge the shell.
- R3 — Everything else about a command that finishes in time stays byte-identical: `cd` and
  variable persistence across calls, heredocs (`<<EOF`, `python3 - <<EOF`), trailing `#`
  comments, `exit 0` restart notice, nonzero/signal `BashSessionError`, cwd probe, wrong-root
  preflight, per-Agent serialization, hooks/permission seeing the raw input.
- R4 — The `bash` tool description states the rule in one sentence: foreground stdin is
  `/dev/null`; prompts fail immediately; pass non-interactive flags (`-y`, `--force`, `--yes`,
  `--no-input`, etc.). The existing ssh sentence stays (ssh wants a tty, not just stdin).
- R5 — Timeout no longer orphans the running child: the shell's foreground process group is
  terminated with the same bounded TERM→KILL shape the background manager uses, so after a
  `BashTimeoutError` nothing from that command is still running. Message/fields of
  `BashTimeoutError` (SER-054) are unchanged.
- R6 — Spec: one new SER contract in `.trellis/spec/backend/strands-sdk-contracts.md` under the
  existing bash section, plus the validation matrix rows; `AGENTS.md` "Process exit and persistent
  foreground cwd" row gains the stdin/orphan invariant without growing the file past 32 KiB.
- R7 (added after check, user chose option B) — Cancellation reaches the running foreground
  command. `detached: true` (R5) removes the shell from darwin's terminal process group, so a
  headless `darwin -p` Ctrl+C no longer kills the child by SIGINT and the call would wait for the
  tool timeout. The foreground `execute` therefore honours `ToolContext.cancelSignal` — the SDK's
  documented extension point ("a tool already executing runs to completion unless it checks
  `context.cancelSignal`"): on abort the shell's process group is stopped through the same
  TERM→KILL `stop()` and the call rejects at once with a bounded cancelled result (captured
  stdout/stderr tails, restart-with-cwd notice — the SER-054 shape with a "cancelled" first line);
  an already-aborted signal rejects before anything is written or spawned. Consequence accepted by
  the user: Esc in the TUI now kills the running foreground command too (Claude Code behaviour),
  instead of letting it run on while its result is discarded.

## Constraints

- The change lives in the pinned SDK patch (`patches/@strands-agents__sdk@1.16.0.patch`) via
  `pnpm patch … --edit-dir` → edit → `node --check` → `pnpm patch-commit` (spec § "SDK pin").
  No fork of the agent loop, no `toolExecutor`, no new dependency.
- No detection heuristics for "interactive" commands — the fix is structural (stdin), not a list
  of program names.
- Darwin's own runtime shutdown / `retire()` path (`invoke({ mode: 'restart' })`) must keep
  working and must not get slower.

## Out of scope

- Auto-backgrounding a timed-out command (spec explicitly rejects imitating Claude Code here).
- Changing `| tail`/timeout choices the model makes; changing background or `!` shell paths.
- Handling programs that loop forever on stdin EOF (they now fail at the timeout with their
  output visible, which is already better than today).

## Acceptance Criteria

- [ ] `execute` of `cat; echo rc=$?` returns `rc=0` with empty output; the *next* call in the same
      shell returns its own output (no wedge). Today: sentinel eaten, timeout, shell killed.
- [ ] `execute` of `read -t 5 x; echo rc=$?` returns `rc=1` in well under a second.
- [ ] `execute` of `trellis update`-shaped prompt (a script that does `read -p 'Proceed? ' a`)
      returns immediately with nonzero/EOF semantics — no timeout.
- [ ] `cd /tmp` then `pwd` in two calls still reports `/tmp`; `X=5` then `echo $X` still prints 5;
      heredoc and `python3 - <<EOF` cases print their payload; `echo trailing # comment` prints
      `trailing`.
- [ ] After a foreground timeout (`sleep 60` with `timeout: 1`), the `sleep` process is gone within
      the bounded TERM→KILL window; `BashTimeoutError` message/fields are the SER-054 ones.
- [ ] Tool description contains the stdin sentence; `spike/verify-tui.ts completion` unaffected (no
      slash-command change) — not required to re-run.
- [ ] `pnpm typecheck`, `pnpm test`, and the patch-focused suite `spike/verify-background-bash.ts`
      pass with new assertions for the above.
- [ ] `pnpm build` run after the commit (installed `darwin` runs `dist/`).
- [ ] (R7) `execute` of `sleep 30.<marker>` with a context whose `cancelSignal` aborts after ~200 ms
      rejects within the TERM→KILL grace with a message whose first line names cancellation and whose
      `output`/`error`/`cwd` fields are present; the `sleep` is gone within grace + margin; the next
      call succeeds in a replacement shell at the initial cwd. An already-aborted signal rejects
      before any shell is spawned (no `bash` child appears).
