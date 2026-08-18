# Live busy readout on the existing busy rows (SER-022)

## Goal

While a turn is active, the existing `working…` hint row and the dim `thinking…` row carry a
live suffix — elapsed turn time (ticking with the existing spinner frame) and the session's
token spend as the runtime's usage meter reports it — with no new frame row, no new tick
source, and no new information channel.

## Requirements

1. The `working…` hint gains ` · <elapsed> · ↑<in> ↓<out> tokens` immediately after the word
   `working…`, before the static command hints, so on a narrow terminal the *live* part
   survives `truncate-end` and the static tail truncates first (the pre-existing behaviour
   for that row). Elapsed uses the `formatTaskDuration` precedent; token counts are compact
   (`1.2k`, `3.4M`).
2. **Decision — the `thinking…` row carries the reduced suffix, elapsed only** (` · 12s`):
   both rows can be on screen at once (the hint shows whenever streaming; `thinking…` on top
   of it while reasoning streams), and stating the same spend twice in one frame is noise.
3. Honesty matches the `usageBuckets` rule: the spend shown is
   `usageBuckets(runtime.usage, config)` — the session totals the provider has *reported*
   (the SDK accumulates a model call when it finishes, exactly what mid-turn `/usage` says
   with "not counted yet"). An unknown metric (`input === undefined` on OpenAI Responses
   without cache detail) is absent from the suffix, never rendered as 0; a meter read that
   throws degrades to the elapsed-only suffix (the `startTurnSpend` cannot-throw precedent).
   A genuinely zero accumulator renders `↑0 ↓0` — that is a measured nothing, the same
   reading `/usage` prints before the first turn.
4. No new frame row and no geometry change: the hint row already claims 2 rows
   (`promptBoxWanted`, `hasHint`) and renders as one `<Text wrap="truncate-end">`, so it
   cannot wrap at any width; the `thinking…` row gains `wrap="truncate-end"` so its counted
   `thinkingRows = 1` stays true at every width with the suffix on it.
5. One tick source: the existing spinner interval (`SPINNER_INTERVAL_MS`, only while
   `effectiveStatus === 'streaming'`). The suffix is computed in render from `Date.now()`
   and a per-turn start ref; the meter read is `runtime.usage` — a synchronous in-memory
   getter over `agent.metrics.accumulatedUsage`. No I/O, no promise, no tick while idle,
   no `<Static>` rewrite (static items are unchanged between ticks).
6. Idle and `compacting` show none of it; a cancelled or failed turn clears the start ref in
   the same `finally` that returns status to idle, so the tick and the suffix stop together.
   `/usage` is untouched.
7. Presentation-only: no persisted state, no trajectory/record change, no runtime API change.

## Acceptance Criteria

- [x] New focused suite `spike/verify-busy-suffix.ts` (formatting, compact counts, unknown-
      metric absence vs zero, elapsed-only degradation) wired into `pnpm test`.
- [x] `pnpm typecheck` exit 0; `pnpm test` exit 0, every suite 0 failed.
- [x] Live `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts usage` and `approve` pass;
      free `completion` passes.
- [x] `git diff --check` clean; Trellis validate; tree clean after commit.

## Notes

- Origin: docs/research/research_2026-08-18.md run 12:30:29Z, direction SER-022;
  backlog docs/research/backlog_index.md (supervisor's records — not touched here).
- `spike/verify-visual-language.tsx` needs no update: the busy rows' structure (one
  truncated `<Text>` each) is unchanged.
- No new dependencies; no model/provider config changes.

## Implementation notes (post-verification)

- Pre-existing failure fixed in passing: the `usage` scenario's first assertion still
  expected the pre-SER-016 header line `/usage for token counts`, which `ab71a8c`
  (visual-language unification) folded into `type / for commands`. The assertion now
  checks the compact summary; the scenario also gained two live-readout assertions
  (readout present mid-turn; a second elapsed reading appears while the turn runs).
- Specs updated: `.trellis/spec/frontend/live-frame.md` gained the "busy rows are alive"
  contract; `AGENTS.md` gained the matching paragraph.
