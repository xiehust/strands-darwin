# Implementation plan: enforced plan permission mode

1. Extend mode vocabulary and selection surfaces.
   - Add `plan` to `ApprovalMode`/`APPROVAL_MODES`.
   - Verify config and CLI paths consume the shared constant.
   - Update CLI usage text.
2. Add the permission guard.
   - Add a narrow `PermissionGate` plan preflight based on `classify`.
   - Invoke it first in the full gate path.
   - Invoke it before configured Pre hooks in `ToolHookGate`, preserving all other ordering.
3. Add effective-mode diagnostics.
   - Extend the existing TUI mode row with explicit plan wording and non-effective rule wording.
   - Emit a stable headless `permission-mode:` line from resolved runtime info.
4. Extend focused acceptance.
   - Config and CLI selection.
   - Gate reads, writes, executes, wording, no bridge/classifier/rule bypass.
   - Hook shell/body short-circuit.
   - Child-agent shared enforcement.
   - Headless diagnostic formatter/process seam.
   - Network-free pty header scenario following anchored wait and bounded exit contracts.
5. Update README, AGENTS, SDK contracts, TUI testing contract, and Batch 5 iteration record.
6. Run focused suites, `pnpm typecheck`, `pnpm test`, free pty scenario, and `git diff --check`.
7. Review only SER-001/task changes, commit with project convention, record commit/task state.

## Risk and rollback points

- `PermissionGate.beforeToolCall`: guard ordering must precede every bypass path.
- `ToolHookGate.beforeToolCall`: only plan-blocked calls may skip Pre hooks; all other ordering must remain byte-for-byte equivalent in behavior.
- TUI header: do not add a row because frame height competes with permission prompts.
- Headless stderr: keep the diagnostic single-line and stable for supervisors.

## Validation commands

```bash
pnpm tsx spike/verify-config.ts
pnpm tsx spike/verify-headless.ts
pnpm tsx spike/verify-permission-modes.ts
pnpm tsx spike/verify-tool-hooks.ts
pnpm tsx spike/verify-subagents.ts
pnpm tsx spike/verify-tui.ts plan
pnpm typecheck
pnpm test
git diff --check
```
