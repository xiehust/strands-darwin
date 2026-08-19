# Check

## Root cause reproduced

The installed SDK permitted parallel foreground calls for one Agent to attach listeners to the same persistent shell and shared sentinel. A direct pre-fix `Promise.all` reproduction returned alpha's stdout/stderr to every call; when one command ended in `exit 0`, every listener instead rejected with `Bash process exited unexpectedly with code 0`. The SDK error discarded each listener's captured buffers and close signal.

## Implementation review

- The existing pinned SDK patch is the minimal viable seam: Darwin's wrapper has neither process close metadata nor captured buffers after rejection.
- Foreground operations serialize per Agent; different Agent keys remain independent.
- A second stderr sentinel prevents delayed stderr from crossing the serialized command boundary.
- Exit 0/no signal returns output plus a notice. Nonzero/signal throws `BashSessionError` with `exitCode`, `signal`, `output`, and `error`.
- The following queued call lazily starts a healthy replacement shell.
- Darwin's runtime shutdown/restart call path and background manager were not replaced; SRF-003 wait and process-group cleanup coverage stayed green.

## Verification

Final combined gate exited 0 (`/tmp/srf004-final-gate.log`, 179734 bytes, zero `FAIL` markers):

- `pnpm typecheck`
- `pnpm test`
- `pnpm tsx spike/verify-background-bash.ts` — 108 passed, including the real parallel exit race and background lifecycle cases
- `pnpm tsx spike/probe-cancel-exit.ts`
- `pnpm tsx spike/verify-clear-session.ts` — 37 passed
- `pnpm tsx spike/verify-tui.ts bashExit` — 3 passed
- `pnpm tsx spike/verify-tui.ts cancelThenContinue` — 5 passed

Additional checks: `git diff --check`, `node --check` on the installed patched SDK file, Trellis validation, and AGENTS.md size (19210 bytes) passed. `pnpm install --offline --frozen-lockfile --ignore-scripts` confirmed the lockfile was already up to date, then its optional supply-chain metadata check could not resolve cached metadata for `uuid`; no install mutation occurred and this was not an implementation/test failure.
