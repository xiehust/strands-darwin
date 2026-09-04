# SRF-010 bounded context-pressure notice

## Goal

Warn once when a session reaches high context pressure and recommend user-controlled `/compact` before another broad implementation or verification turn, without adding any automatic conversation mutation or live-frame surface.

## Requirements

1. Reuse `AgentRuntime.contextEstimate()`, the existing `contextWarnRatio` configuration, the session latch, and the transcript notice action; do not introduce a second pressure threshold or duplicate warning channel.
2. Preserve compatibility: the default ratio remains `0.8`, custom ratios remain effective, and `0` disables the notice.
3. Emit one bounded, single-line notice on the first known-window check at or above the configured ratio. The wording must include `/compact` and frame it as a user choice before the next broad implementation or verification turn.
4. Stay silent below threshold, while still above an already-reported threshold, when disabled, when the model window is unknown or invalid, and when estimation fails.
5. Re-arm only after a known estimate falls below the threshold, including after user-run compaction. `/clear` must replace the latch with fresh session state.
6. Keep `/compact` explicit and user-controlled: no silent compaction, conversation mutation, timer, channel, model call, or live-frame row.
7. Update the governing SDK/TUI specs, architecture rationale/index, and Trellis task artifacts. Do not modify or stage the Host-owned research backlog.

## Acceptance Criteria

- [x] Focused pure tests pin exact-threshold crossing, one-shot behavior, re-arm, disabled, below-threshold, unknown/invalid-window behavior, and bounded one-line wording containing `/compact`.
- [x] An offline reducer integration proves repeated high-pressure checks produce exactly one transcript notice and do not populate live-frame state; baseline checks produce no row.
- [x] Existing `/context`, `/compact`, `/status`, frame-budget, queue, resumed-session, `/clear`, and error-degradation tests remain green.
- [x] `pnpm typecheck`, one complete `pnpm test`, task validation, documentation checks, and `git diff --check` pass after source settles.
- [x] The completed task is committed without staging `docs/research/backlog_index.md`; no push is performed.

## Constraints

- Evidence: `docs/reflections/reflection_2026-08-21_session-20260821-054705633.md` F2 and SRF-010.
- No dependencies, live provider calls, delegation, developer skill, or supervision worker.
