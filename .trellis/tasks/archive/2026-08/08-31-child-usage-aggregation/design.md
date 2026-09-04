# Design — child-agent usage aggregation

## Decision record

- Additive everywhere (user decision 2026-08-31): no existing surface changes
  meaning or bytes when zero dispatches ran; new lines/fields appear only when
  ≥1 dispatch exists.
- Capture point is the dispatch registry, not a new channel: usage rides the
  existing `SubagentDispatchStatus` observability projection (counters only,
  never transcript), and the runtime total is a sum over the registry — the
  same "observer of existing state" pattern as `/status` and `/mcp`.
- Mixed-provider caveat: children snapshot config at dispatch; sums are raw
  `UsageTotals` projected with the *live* config — the exact precedent the
  parent meter already sets across `/model` switches.

## Changes by module

### src/agent/usage.ts

`sumUsage(totals: readonly UsageTotals[]): UsageTotals`
- `inputTokens`/`outputTokens`: plain sums.
- `cacheReadInputTokens`/`cacheWriteInputTokens`: key present in the result
  only if at least one operand reports it; absent operands count as 0 inside
  the sum. Preserves the "unknown metric is never 0" render rule.

### src/agents/dispatch-registry.ts

- `SubagentDispatchStatus` gains `readonly usage?: UsageTotals`.
- `SubagentDispatchHandle` gains `attachUsage(read: () => UsageTotals): void`
  (ignored once terminal, like `attachCancel`).
- `DispatchRecord` gains `readUsage` + frozen `usage`. `snapshot()` reads live
  usage for running records (try/catch → undefined); `finish()` freezes the
  last reading before publishing the terminal snapshot, so cancelled/failed
  dispatches keep what they spent.
- `totalUsage(): { dispatches: number; usage: UsageTotals } | undefined` —
  `undefined` when no dispatch ever reported usage; otherwise `sumUsage` over
  every record's current snapshot value (running children included live).

### src/agents/child-recipe.ts

In `buildRecipeChild`, beside `attachAgent`/`attachCancel`:
`dispatch?.attachUsage(() => ({ ...child.metrics.accumulatedUsage }))` (clone —
the SDK object is a live accumulator). Both `SubagentTool` and `WorkflowTool`
inherit capture with zero caller changes; neither may build children directly,
so the paths cannot drift.

### src/agent/runtime.ts

- `get childUsage(): { dispatches: number; usage: UsageTotals } | undefined`
  — delegates to `this.subagentDispatches.totalUsage()`.
- `get sessionUsage(): UsageTotals` — `sumUsage([this.usage, childUsage.usage])`
  when children exist, else exactly `this.usage`.
- `usage` / `lastTurnUsage` untouched (parent-only, documented).
- `/clear` needs nothing: the successor runtime owns a fresh registry.

### src/tui/App.tsx (`formatUsageReport`)

New optional trailing parameter `children?: { dispatches: number; usage: UsageTotals }`.
When present, two extra sections reuse the existing row/format helpers:
- `subagents (N dispatches)` — `usageRows(children.usage, config)`
- `session total (incl. subagents)` — `usageRows(sumUsage(...), config)`
  (computed by the caller as `runtime.sessionUsage`).
Absent → byte-identical output. Call site passes `runtime.childUsage`.

### src/tui/status-format.ts

`StatusFacts` gains `childUsage: { dispatches: number; usage: UsageTotals } | undefined`
(read from `runtime.childUsage`, keeping the "every field names its accessor"
contract). The usage section keeps today's line verbatim; when `childUsage` is
set it appends:
- `usage (subagents, N dispatches): ...` (same bucket line renderer)
- `usage (session total): ...`

### src/headless.ts / src/headless-runner.ts

- `formatHeadlessChildUsage(child, config)` → `usage-children: input=… output=… cacheRead=… cacheWrite=… dispatches=N`
- `formatHeadlessTotalUsage(total, config)` → `usage-total: input=… output=… cacheRead=… cacheWrite=…`
  Same `-` for unreported, fixed field order, written to stderr directly after
  the existing `usage:` line only when `runtime.childUsage` is defined.

### src/headless-protocol.ts

`StructuredTerminalInput`/result record gain additive optional fields:
- `childUsage?: StructuredUsage & { dispatches: number }`
- `totalUsage?: StructuredUsage`
Emitted only when ≥1 dispatch reported usage; `usage` unchanged.

### src/tui/subagent-format.ts (`formatDispatchesReport`)

Per-dispatch row appends `— tokens in=X out=Y` when that dispatch's snapshot
carries usage; silent otherwise. Counters only, already bounded.

## Failure honesty

- A child meter that throws on read → that dispatch's usage is `undefined`
  and it is excluded from the sum; if all are excluded, `childUsage` is
  `undefined` and every surface stays in its zero-dispatch form (never a fake 0).
- `attachUsage` after terminal is a no-op; `finish` freezing is first-call-wins
  like the rest of the record.

## Tests (all free, extending existing suites)

- `spike/verify-usage.ts`: `sumUsage` semantics incl. undefined-cache rule.
- `spike/verify-subagent-heartbeats.ts` (registry/tool already run scripted
  children): per-dispatch capture on success/failure/cancel, freeze at finish,
  `totalUsage` sum, live reading while running.
- `spike/verify-workflow-tool.ts`: workflow nodes report usage through the same
  recipe.
- `spike/verify-status-command.ts`: `/status` with and without `childUsage`.
- `spike/verify-headless.ts` / `verify-headless-structured.ts`: new lines/fields
  present only with dispatches; `usage:`/`usage` byte-identical without.
- `spike/verify-subagent-format.ts`: per-dispatch spend suffix.

## Spec/doc updates (finish phase)

- `.trellis/spec/backend/structured-headless-output.md`: additive fields.
- AGENTS.md subagents row + `docs/architecture/load-bearing-decisions.md` if
  wording about dispatch records needs the counters mentioned.
