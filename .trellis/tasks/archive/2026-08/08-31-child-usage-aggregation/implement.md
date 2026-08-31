# Implementation plan

Order chosen so each step typechecks and is testable before the next.

1. **usage core** — add `sumUsage` to `src/agent/usage.ts`; extend
   `spike/verify-usage.ts`.
2. **registry + recipe** — `attachUsage`/frozen usage/`totalUsage` in
   `src/agents/dispatch-registry.ts`; attach reader in
   `src/agents/child-recipe.ts`; extend `spike/verify-subagent-heartbeats.ts`
   (success/failure/cancel/live) and `spike/verify-workflow-tool.ts`.
3. **runtime accessors** — `childUsage`/`sessionUsage` on `AgentRuntime`.
4. **TUI surfaces** — `formatUsageReport` optional children sections +
   call site; `/status` facts + lines; `/agents` per-dispatch suffix. Extend
   `spike/verify-status-command.ts`, `spike/verify-subagent-format.ts`.
5. **headless surfaces** — `usage-children:`/`usage-total:` lines and
   structured `childUsage`/`totalUsage` fields. Extend
   `spike/verify-headless.ts`, `spike/verify-headless-structured.ts`.
6. **gate** — `pnpm typecheck`, `pnpm test`; free TUI scenarios unaffected but
   re-run `spike/verify-tui.ts completion` only if any slash command changed
   (none should).
7. **specs/docs** — structured-headless-output spec, AGENTS.md/load-bearing
   doc wording if needed; then `pnpm build` after commit (installed darwin
   runs dist/).

Byte-identity guard: steps 4–5 must include a zero-dispatch assertion that the
existing output is unchanged.
