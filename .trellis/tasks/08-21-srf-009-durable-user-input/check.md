# Quality check

## Acceptance

- Real `AgentRuntime` + scripted offline model reads current `userInput` during invocation: passed in `spike/verify-trajectory.ts`.
- Prior prefix byte identity, contiguous seq, ordinary closing records: passed.
- Barrier write failure and timeout degrade through `trajectoryStatus`, invocation proceeds, timeout does not hold shutdown: passed.
- Existing stream event equality and provider error identity matrix: passed in trajectory suite.
- Stream resumption: `spike/verify-stream-resumption.ts` — 16 passed.
- Clear/retire/shutdown: `spike/verify-clear-session.ts` — 37 passed.
- Focused trajectory suite: 267 passed.
- `pnpm typecheck`: passed.
- Complete `pnpm test` gate (run exactly once after source settled): exit 0.
- `git diff --check`: passed.

## Review

- SDK loop remains owned by `Agent`; only runtime pre-invocation recorder setup changed.
- Per-event recording remains synchronous and non-awaitable.
- Existing append chain, seq recovery, caps, replay, and damage-tolerant reader format are unchanged.
- Timeout detaches the stuck chain and prevents later batches; recorder failures cannot reject into the turn.
- Session/spec architecture docs and AGENTS.md invariant are synchronized.
- Host-owned `docs/research/backlog_index.md` remains unmodified by this task and must stay unstaged.
