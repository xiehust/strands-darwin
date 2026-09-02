# SER-054: a foreground bash timeout keeps the captured output and states the shell's state

## Goal

When a foreground `execute` exceeds its timeout, the pinned SDK bash session
(`node_modules/@strands-agents/sdk/dist/src/vended-tools/bash/bash.js`, carried by
`patches/@strands-agents__sdk@1.16.0.patch`) currently rejects with the one line
`Command timed out after N seconds`, discarding everything the command printed and killing the
persistent shell without saying so. Make the timeout result truthful and non-destructive to
evidence: the error the model sees names the timeout, carries the bounded tail of captured
stdout/stderr, states that the persistent shell was killed and where it restarts, and points to
`start` + `wait` for long-running work.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-054 (Priority 75).

## Requirements

- R1. The thrown `BashTimeoutError` carries `output` (bounded stdout tail), `error` (bounded
  stderr tail), `cwd` (the cwd the replacement shell starts in) and `timeoutSeconds` (the
  effective timeout). The fields are declared in the patched `types.d.ts` the way
  `BashSessionError`'s were.
- R2. The error message — which the SDK's `createErrorResult` turns verbatim into the
  `Error: …` tool result text — states, in this order: (a) the command did not complete within
  N seconds; (b) the bounded tail of captured stdout, then of captured stderr, each with its
  byte count and, when cut, the `last K of M bytes … hasMore: true` vocabulary the background
  `output`/`wait` projection already uses (64 KiB cap — the same figure as `OUTPUT_LIMIT` in
  `src/tools/background-bash.ts`; no new cap, no new wording); (c) the persistent shell was
  killed and restarts before the next command, with its cwd; (d) one pointer to `start` +
  `wait` instead of a longer timeout.
- R3. Kill/exit semantics, `SHELL_RESTART_NOTICE`, exit-0 success handling, `BashSessionError`,
  background modes and the `timeout` schema field are unchanged. A command that finishes within
  its timeout produces byte-identical output to today.
- R4. No auto-backgrounding: the persistent shell cannot detach a running command. The spec
  states this instead of imitating Claude Code's move-to-background.
- R5. Shaping lives at the existing seam — the patched `bash.js` timeout handler that already
  shapes the exit-0 restart notice — never in a second error channel.
- R6. The SDK patch is regenerated through the repo's `pnpm patch` / `pnpm patch-commit`
  procedure and re-applies from a fresh `pnpm install --frozen-lockfile`.
- R7. Verification is offline and in `pnpm test`.

## Acceptance Criteria

- [x] AC1. `spike/verify-background-bash.ts` drives a real `execute` past a short timeout
  (`echo before; sleep 5`, `timeout: 1`) and proves the error result contains the pre-timeout
  stdout (`before`), the timeout figure, the restart/cwd statement and the `start`/`wait`
  pointer; the error instance exposes the R1 fields.
- [x] AC2. A long stdout tail (> 64 KiB) is cut to the cap with the existing vocabulary.
- [x] AC3. A command finishing in time is byte-identical to a captured pre-change expectation
  string.
- [x] AC4. The patch re-applies cleanly (`pnpm install --frozen-lockfile` leaves `node_modules`
  matching the patch; lockfile patch hash updated).
- [x] AC5. `.trellis/spec/backend/strands-sdk-contracts.md` states the timeout result shape and
  the no-auto-background decision; `docs/architecture/load-bearing-decisions.md` "Process exit"
  gets the one-sentence timeout statement; AGENTS.md row updated only if a phrase became false
  (file under 32 KiB).
- [x] AC6. `pnpm typecheck` clean; full `pnpm test` exit 0 with zero FAIL lines.
- [x] AC7. Commits follow the repository convention; task archived; `git status --porcelain`
  clean.

## Requirement-to-test checklist

| Requirement | Proof |
|---|---|
| R1 fields on the error | `foregroundTimeoutContracts()` in `spike/verify-background-bash.ts`: `caught instanceof BashTimeoutError`, `output === 'before'`, `error === 'before-err'`, `cwd === root`, `timeoutSeconds === 1` |
| R2 (a) timeout figure | message includes `did not complete within 1 seconds` |
| R2 (b) tails + vocabulary (AC1, AC2) | message includes the captured stdout/stderr text; a `head -c 70000 /dev/zero \| tr '\0' x` probe asserts `last 65536 of 70000 bytes` and `hasMore: true`, and the retained tail is exactly 65536 bytes; the small probe carries no `hasMore` |
| R2 (c) restart statement | message includes `it will restart before the next command` and `cwd: <root>`; the next `pwd` call succeeds and reports `root` |
| R2 (d) pointer | message includes `mode "start"` and `"wait"` |
| R2 order | the message's indexOf sequence for (a) < (b stdout) < (b stderr) < (c) < (d) is asserted |
| R3 in-time byte-identical (AC3) | `JSON.stringify(result) === '{"output":"in-time-out","error":"in-time-err","cwd":"<root>","exitCode":3}'` captured before the change |
| R3 exit-0 / `BashSessionError` / background unchanged | existing `foregroundShellExitContracts()`, `managerContracts()`, `waitContracts()` stay green unchanged |
| R4 no auto-background | spec statement in `strands-sdk-contracts.md` (`rg -n "cannot detach" .trellis/spec/backend/strands-sdk-contracts.md`) |
| R5 single seam | `git diff` touches only the timeout handler in `bash.js` and `types.d.ts` inside the patch; `src/tools/background-bash.ts` untouched |
| R6 patch re-applies (AC4) | `pnpm patch-commit` output, `git diff --stat pnpm-lock.yaml`, `pnpm install --frozen-lockfile` then `cmp` of the installed `bash.js` against the edited copy |
| R7 offline (AC6) | `verify-background-bash.ts` is already listed in `spike/run-tests.ts`; `pnpm test` |
| AC7 | `git log --oneline`, `python3 .trellis/scripts/task.py archive`, `git status --porcelain` |

## Evidence (2026-09-02)

- Pre-change baseline captured with a throwaway probe: in-time result
  `{"output":"in-time-out","error":"in-time-err","cwd":"<root>","exitCode":3}`; old timeout
  message `Command timed out after 1 seconds` with no fields.
- `pnpm patch @strands-agents/sdk@1.16.0 --edit-dir /tmp/ser054-sdk-patch` → edits →
  `node --check` → `pnpm patch-commit` (lockfile patch hash `908d3847…` → `254ab0c0…`);
  `pnpm install --frozen-lockfile` re-applied and `cmp` matched both edited files.
- `pnpm tsx spike/verify-background-bash.ts`: 157 passed, 0 failed (15 new in the SER-054 block).
- `pnpm typecheck` clean; `pnpm test` exit 0, zero FAIL lines; `pnpm build` exit 0.
- Also carried: `BashSession.stop()` resets the tracked cwd to the initial cwd so the wrong-root
  preflight of the first post-timeout command is judged against the replacement shell (asserted).
- AGENTS.md untouched: no row phrase became false; file is 32,412 B.

## Constraints

- Mutations limited to `patches/@strands-agents__sdk@1.16.0.patch` (via `pnpm patch` edit dir),
  `pnpm-lock.yaml` (patch hash), `spike/verify-background-bash.ts`, `.trellis/spec/**`,
  `.trellis/tasks/**`, `.trellis/workspace/**`, `docs/architecture/load-bearing-decisions.md`,
  AGENTS.md (one row, only if needed).
- No new dependencies; no `docs/research/**` / `docs/iteration-log.md`.
- `docs/user-guide/*.md` do not describe bash timeouts (checked with `rg`), so they are untouched.
