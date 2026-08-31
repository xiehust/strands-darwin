# PRD — Aggregate child-agent usage into session usage

Fixes the accounting half of [issue #8](https://github.com/xiehust/strands-darwin/issues/8):
subagent and workflow-node children each create an independent `Agent` whose
`metrics.accumulatedUsage` is never read after the dispatch settles, so every
usage surface (TUI usage report, `/status`, headless `usage:` line, structured
`result.usage`) understates real session spend whenever delegation ran.

## Confirmed facts (from code)

- `AgentRuntime.usage` (src/agent/runtime.ts:1229) reads only
  `this.agent.metrics.accumulatedUsage` — the parent meter.
- `SubagentTool.run` (src/agents/subagent-tool.ts:130–195) and
  `WorkflowTool` node execution (src/agents/workflow-tool.ts:~180–320) both
  build children via `buildRecipeChild` (src/agents/child-recipe.ts) and settle
  them through `SubagentDispatchHandle.finish(...)`; the child `Agent` is in
  scope at every settlement site, but its usage is discarded.
- `SubagentDispatchStatus` (src/agents/dispatch-registry.ts) carries name, task,
  state, phase, timestamps — no usage.
- Usage surfaces: `formatUsageReport` (src/tui/App.tsx, Ctrl usage report),
  `/status` usage line (src/tui/status-format.ts, via `usageBuckets`), headless
  `usage:` stderr line (src/headless.ts `formatHeadlessUsage`), structured
  `result.usage` (src/headless-protocol.ts `structuredUsage`), dev-repl.
- Precedent for mixed-provider sums: the parent meter already accumulates
  across `/model` switches and is projected with the *live* config; child sums
  get the same treatment.
- "Unknown metric is never 0" rule (SER-007/SER-022 / `usageBuckets`): cache
  counters stay `undefined` until some meter reports them.
- `/clear` builds a successor runtime via `create()`, which owns a fresh
  dispatch registry — child accumulation is naturally session-scoped.

## Requirements

1. **Per-dispatch usage.** Each dispatch record captures its child's
   `metrics.accumulatedUsage`: live (readable while running) and frozen at
   terminal transition. Cancelled/failed children still report what they spent
   before settling. Captured via a reader attached in `buildRecipeChild`
   (`attachUsage`-style handle method), so `SubagentTool` and `WorkflowTool`
   cannot drift. Usage never carries child transcript — counters only.
2. **Runtime accessors.** `AgentRuntime` exposes child usage (sum over the
   dispatch registry, including still-running children's live readings) and a
   session total (parent + children). `runtime.usage` keeps its current
   parent-only meaning; no existing caller changes meaning silently.
   Sum rule: numeric fields add; an optional cache counter is `undefined`
   until at least one meter reports it, then treated as 0-for-absent within
   the sum (never rendering an all-unknown metric as 0).
3. **TUI usage report.** When at least one dispatch exists, the report shows a
   subagent section (dispatch count + summed buckets) and a session total,
   clearly labelled; with zero dispatches the report is byte-identical to
   today.
4. **`/status`.** Usage line(s) distinguish parent-only from total-including-
   children when children ran; unchanged otherwise. Still a pure projection
   over runtime accessors — no new information channel.
5. **Headless.** Parent-only `usage:` line stays byte-compatible. When ≥1
   dispatch ran, additional fixed-format line(s) report child/total usage.
   Structured output: `result.usage` unchanged; additive optional field(s)
   for child/total usage. (Exact shape — see open question.)
6. **`/agents` report.** Per-dispatch rows may state that dispatch's spend
   (bounded, counters only).

## Out of scope (deferred to follow-up per user decision 2026-08-31)

- Per-model-call usage events / summary diagnostics (issue "observability"
  extras beyond the above).
- Round-trip-reduction guidance, model-round budgets, phase auto-compaction
  (issue "behavioral" asks).
- Turn-spend trajectory records stay parent-only (their spec'd meaning).
- Resumed-session earlier-run spend (already documented as unknowable).

## Acceptance

- `pnpm typecheck` and `pnpm test` pass.
- New/extended free suites prove: per-dispatch capture (success, failure,
  cancel), runtime sum semantics (undefined-cache rule), TUI report and
  `/status` projections with and without dispatches, headless line format and
  structured additive fields.
- With zero dispatches, every existing surface is byte-identical to today.

## Resolved questions

1. Headless shape (user, 2026-08-31): additive — `usage:` and structured
   `usage` stay byte-compatible; extra `usage-children:`/`usage-total:` lines
   and additive structured fields appear only when ≥1 dispatch ran.
