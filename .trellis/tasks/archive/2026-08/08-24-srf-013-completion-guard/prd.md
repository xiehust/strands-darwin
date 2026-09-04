# SRF-013 bounded completion guard

## Goal

Prevent an otherwise successful parent turn from publishing a short internal working note as its final answer. Suppress the note and allow one ordinary driver-owned continuation to perform the pending tool action or provide a concise user-facing answer.

## Requirements

- Conservatively detect bounded, terse internal TODO/tool-intent final text such as `Need continue tools`, `Need answer in Chinese`, and `Update plan`, while leaving ordinary user-facing prose unchanged.
- Decide before the candidate turn is publicly committed. A matched note must not reach TUI/headless text, structured JSON/JSONL, trajectory/replay, notices, or the continuation input.
- Run at most one continuation through ordinary TUI/headless driver orchestration. Its fixed bounded input must rely on retained conversation, prohibit repetition, and request an actual pending tool action or concise direct answer.
- Never retry nonmatching successful answers. Never loop when the continuation matches, fails, or is cancelled.
- Preserve the SDK loop boundary, trajectory honesty, exact stream-interruption recovery, max-token recovery, cancellation, prompt queue, session, and output-protocol contracts.
- Add no dependencies and make no model/network calls in focused acceptance coverage.

## Acceptance Criteria

- [ ] Representative internal TODO/tool-intent finals match; ordinary user-facing prose does not.
- [ ] Every listed public/recorded surface is proven free of suppressed text.
- [ ] Exactly one ordinary continuation is attempted with a fixed bounded anti-repeat input.
- [ ] Continuation can expose ordinary tool events and can complete with a user-facing answer.
- [ ] A second match, continuation failure, and cancellation trigger no third turn and terminate honestly.
- [ ] Existing stream-resumption and max-token recovery checks remain green.
- [ ] Focused offline coverage is included in `pnpm test`; typecheck, full test, build, and Trellis validation pass.
- [ ] Authoritative specs, architecture rationale/index, and task/journal artifacts describe the invariant.
