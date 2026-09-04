# PRD — Per-model-call usage observability

Issue #8 follow-up A (accounting fix shipped in 9e39de5). Goal: a user can
identify which model calls/phases grew cumulative token usage, see session-level
efficiency stats, and get warned when the "repeated long-context single-tool
round" pattern is burning cached reads — all without reconstructing it from
tool timestamps.

## Confirmed facts (from code / SDK)

- The stream `AgentRuntime.send` already forwards (and `TurnRecording.record`
  already observes, counting-not-storing) has everything needed per call:
  - `beforeModelCallEvent.projectedInputTokens` — context size estimate
  - `afterModelCallEvent.stopData.message.metadata.usage` — the provider's
    counters for that one call; `attemptCount` (1-indexed, retries visible)
- Trajectory record types are an allowlist (`RECORDED_EVENT_TYPES`); turnEnded
  already carries per-turn `spend` (delta of the lifetime meter) and
  `recorded`/`dropped` event counts. Caps and observer discipline are spec'd in
  `backend/session-trajectory.md` (bounded fields, no I/O in record(), degrade
  open, bytes never rewritten).
- `cacheEffectivenessRows` already exists (`src/agent/usage.ts`) and feeds the
  TUI usage report.
- The advisory precedent is context pressure (`src/tui/context-format.ts` +
  App latch): post-turn, one bounded recommendation per crossing, re-arm on
  drop, advise-never-act, silent when unknown.
- Diagnostics log (`src/agent/diagnostics.ts`) is opt-in, bounded, drop-counted
  — a complementary but non-durable channel.

## Requirements

1. **Per-model-call trajectory record.** A new bounded record type (working
   name `modelCall`) written by `TurnRecording` when it observes a completed
   model call: usage buckets for that call, `attemptCount`,
   `projectedInputTokens` when reported, and ms since turn start. Same
   observer rules as every record: synchronous projection, capped fields,
   absent-never-0, failures degrade open, replay/`trajectory` CLI can read it.
   No new I/O channel — it rides the existing buffered turn append.
2. **Session efficiency summary.** Runtime-accumulated counters (model-call
   count, tool-bearing responses split single- vs multi-tool, average request
   input per call, cache effectiveness) surfaced as: a section in the `/usage`
   report (primary surface per user, 2026-08-31 — and because `/usage` answers
   mid-turn, the counters update per completed call, giving a live in-session
   view) and a `/status` line(s). Derived from the same stream observation;
   unknown metrics read `not reported`, never 0.
3. **Repeated-long-context advisory.** Following the context-pressure pattern:
   post-turn only, when cumulative cacheRead exceeds a threshold AND recent
   model rounds each executed ≤1 tool call, one bounded transcript notice
   recommending consolidation/batching (and `/compact` where applicable);
   latched per crossing, re-armed only on improvement, fresh on `/clear`,
   silent when metrics are unknown. Never acts automatically.
4. **Headless.** Summary available in the terminal path (bounded); exact shape
   depends on the open question below.
5. Zero-regression: with recording off / no model calls, every surface is
   byte-identical to today; trajectory schema change is additive.

## Out of scope

- Round-trip-reduction prompt guidance, budgets, auto-compaction (follow-up B).
- Any per-call event that requires a new network/model channel.
- Changing turnEnded `spend` or the headless `usage:`/`usage` contracts.

## Acceptance

- `pnpm typecheck` + `pnpm test` pass; extended free suites cover: modelCall
  record shape/caps/absence, replay projection, summary math (incl. unknown
  metrics), advisory latch behavior, headless shape, zero-activity
  byte-identity.
- Spec updates: `backend/session-trajectory.md` (new record type),
  `backend/structured-headless-output.md` if the structured schema grows.

## Resolved questions

1. No new stream-json event type in v1 (user, 2026-08-31): interactive live
   view is `/usage` mid-turn; headless supervisors analyze the durable
   trajectory `modelCall` records after the run plus the bounded terminal
   summary.
