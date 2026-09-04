# Check

## Extension seam and invariants

- The implementation changes only the pinned SDK's private `buildStrReplaceResult()` miss path and
  keeps Darwin importing the SDK singleton directly.
- Exact replacement remains exact. Advisory seeds select context only and are never passed to the
  write path; misses remain errors before `sandbox.writeText()`.
- The existing sandbox path/read/size ownership and all unrelated validations remain in place.
- Advisory work and output have explicit query/seed/occurrence/line/width caps, Unicode code-point
  slicing, deterministic ranking, and explicit absence/truncation wording.

## Verification

After source settled:

- `pnpm tsx spike/verify-file-editor.ts` — 63 passed, 0 failed. Covers provider schema, stale
  recovery, explicit absence, ambiguity, adversarial query cap/runtime, Unicode line cap, exact
  success, zero-write and bytes/metadata purity, unrelated errors, and all prior view behavior.
- `pnpm typecheck` — exit 0.
- `pnpm test` — final rerun exit 0; all fast suite summaries reported 0 failed, including the
  focused suite. The first full run reached unrelated `verify-background-bash.ts` and timed out its
  existing 3-second process-exit probe; an unchanged rerun passed.
- `pnpm build` — exit 0.
- `git diff --check` — exit 0.
- Installed patched SDK `file-editor.js` passed `node --check`.
- A clean temporary offline `pnpm install --ignore-scripts` from the tracked package, lock, workspace,
  and patches reapplied the patch; installed syntax and advisory marker checks passed.
- `python3 ./.trellis/scripts/task.py validate 08-21-srf-011-file-editor-miss-context` — passed.

No model or network call was made. The Host-owned `docs/research/backlog_index.md` modification was
not edited by this task and is excluded from staging/commit.
