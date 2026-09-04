# Check report

## Scope review

- Runtime/trajectory seam remains unchanged: `AgentRuntime.send` still delegates one `agent.stream` through `recordStream`, which rethrows identical errors.
- Shared policy lives in `src/agent/stream-resumption.ts`; TUI and headless drivers each compose it around ordinary one-turn consumers.
- Exact classification excludes generic/auth/validation `ModelError`, max tokens, context overflow, cancellation, and non-model failures.
- TUI keeps one busy/queue owner across continuation; final cancellation/failure alone returns queued entries.
- Headless text, JSON, and stream JSON explicitly disclose continuation without exposing the internal/original prompt.
- SRF-001 backlog status remains `in-progress` for Host acceptance.

## Verification

- Focused: `spike/verify-stream-resumption.ts` — 16 passed, 0 failed.
- Focused: `spike/verify-headless-structured.ts` — 10 passed, 0 failed.
- Regression: `spike/verify-prompt-queue.ts` — 28 passed, 0 failed.
- Type gate: `pnpm typecheck` — exit 0 after source settled.
- Complete gate: `pnpm test` — exit 0; 51 suite summaries, all `0 failed`.
- Trellis: `task.py validate 08-19-srf-001-stream-resumption` — passed (only existing large-spec truncation warnings).
- Hygiene: `git diff --check` — passed; `AGENTS.md` 19,063 bytes, below 32 KiB.

## Result

Accepted-ready. No network or provider calls were made.
