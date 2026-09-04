# Implementation plan

Read first: `.trellis/spec/backend/strands-sdk-contracts.md` § "the vended bash tool keys and
serializes its persistent shell per `Agent` instance" (SER-054 matrix) and § "SDK pin — 1.16.0 and
the regenerated patch" (patch workflow). Do not edit `node_modules` in place.

## Steps

1. Open the patch edit dir: `pnpm patch @strands-agents/sdk@1.16.0 --edit-dir /tmp/sdk-patch`
   (applies the existing patch onto the pristine package).
2. `dist/src/vended-tools/bash/bash.js`, class `BashSession`:
   - `start()`: add `detached: true` to the `spawn('bash', [], {...})` options.
   - `run()`: change the single `stdin.write(...)` so the command is written as
     `{\n${command}\n} </dev/null\n` followed by the existing `__darwin_exit_code=$?` / exit-code
     sentinel / cwd sentinel / stdout sentinel / stderr sentinel lines, byte-identical otherwise.
   - `stop()`: replace `this._process.kill()` with a group kill: `process.kill(-pid, 'SIGTERM')`,
     then one unref'd timer sending `SIGKILL` to the group after the same grace the background
     manager uses (read its constant's value from `src/tools/background-bash.ts` and name the
     coupling in a comment); wrap both in try/catch swallowing `ESRCH`/`EPERM`. Keep the
     `_process = null`, `_started = false`, `_cwd` reset and `activeSessions.delete` lines.
3. `node --check dist/src/vended-tools/bash/bash.js`, then `pnpm patch-commit /tmp/sdk-patch`;
   confirm `patches/@strands-agents__sdk@1.16.0.patch` changed only in bash.js hunks.
4. `src/tools/background-bash.ts`: add the one stdin sentence to the description (design.md
   wording), adjacent to the ssh sentence.
5. `spike/verify-background-bash.ts`: add a section `foregroundStdinContracts()` with real
   `createForegroundBashTool(root)` calls asserting:
   - `cat; echo rc=$?` → `output === 'rc=0'`, then a following `echo next` → `'next'` (no wedge);
   - `read -t 5 x; echo rc=$?` → `'rc=1'` and elapsed < 1000 ms;
   - `bash -c 'read -p "Proceed? " a; echo a=$a rc=$?'` → returns at once with `rc=1`;
   - `cd <tmp>` then `pwd` → tmp; `X=5` then `echo $X` → `5`; heredoc, `python3 - <<EOF`,
     `echo trailing # comment` → payloads unchanged;
   - timeout: `execute` of `sleep 60` with `timeout: 1` rejects with the SER-054 message, and
     within the TERM→KILL grace + margin no process with that exact `sleep 60` command line spawned
     by the test remains (`ps -o pid=,cmd= --ppid` or `pgrep -f` scoped by a unique marker such as
     `sleep 60.0731`).
   Register nothing new in `spike/run-tests.ts` unless the file is not already part of
   `pnpm test` (it is: `†` in AGENTS.md).
6. Verify: `pnpm typecheck`, `pnpm tsx spike/verify-background-bash.ts`, `pnpm test`,
   `pnpm tsx spike/verify-clear-session.ts` (retire path uses `stop()`), then
   `pnpm tsx spike/probe-cancel-exit.ts` to confirm exit time did not grow.
7. Spec update (Phase 3.3): new `### Contract:` block with the next free SER id (SER-066) in
   `strands-sdk-contracts.md` right after the SER-054 paragraph: stdin `/dev/null` via the brace
   group, sentinel channel unreachable, alias caveat, group kill on `stop()` with the shared grace
   constant, and two new matrix rows (stdin reader finishes at once; timeout leaves no child).
   `AGENTS.md` row "Process exit and persistent foreground cwd": append "foreground children read
   `/dev/null` (prompts fail at once, sentinels unreachable), `stop()` kills the shell's process
   group" — check `wc -c AGENTS.md` stays < 32768. Update the same heading in
   `docs/architecture/load-bearing-decisions.md` if it describes the shell's stdin or `stop()`.
8. Commit (commit-message skill), then `pnpm build`.

## Review gates

- After step 3: `git diff --stat patches/` shows only the SDK patch; `pnpm install --offline` is
  not needed (patch-commit re-links).
- After step 5: the new suite fails against the *old* patch for the `cat` and `read` cases
  (proves it tests the change) — run it once before step 1 if cheap, or reason from the probe in
  prd.md.
- Before commit: `pnpm typecheck` clean, `pnpm test` green, AGENTS.md size checked.

## Rollback points

- Before step 3: discard `/tmp/sdk-patch`.
- After step 3: `git checkout patches/ && pnpm install`.
