## Bug Analysis: `/compact` looped forever on a no-shrink pass and reported a swallowed failure as success

### 1. Root Cause Category
- **Category**: E — Implicit Assumption (with a D — Test Coverage Gap that let it hide)
- **Specific Cause**: `compactConversation` assumed `reduce() === true` ⇒ the message count dropped. The SDK contract is only "the history was reduced" (`_summarizeOldest` splices `count` messages and one summary back, `count = min(max(1, floor(len × ratio)), len − preserve)`), and with ratio ≤ 0.8 a 2-message list yields `count = 1` — same length. Second assumption: `reduce() === false` ⇒ "nothing to do". Without an `error` argument the SDK's proactive path swallows a summarization error and returns the same `false`.

### 2. Why the bug stayed hidden
1. From `780ec93` to `f4e3271` the second pass over a 2-message / preserve-0 history sent a user-role summary carrying reasoning blocks; the provider rejected it, the SDK swallowed the rejection, `reduce` returned `false`, and the loop ended — reporting `compacted: true` (the first pass "succeeded"). The live `compacting` scenario waited for `compacted|already compact` and went green on a lie.
2. `f4e3271` fixed the reasoning scrub — a correct fix — and removed the accidental terminator. The scenario went red (240 s timeout) and was first attributed to environment (SER-051 verification note: "timed out identically on the pre-change tree"), which was true but not the cause.
3. `spike/verify-compact.ts` had no preserve-0 case and no failing-summarizer case: `failSummaries` existed on the fake model but nothing used it.

### 3. Prevention Mechanisms
| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Runtime | Observational termination guard: pass snapshot, undo a no-shrink pass, stop | DONE (`src/agent/compact.ts`) |
| P0 | Runtime | Swallowed `false` inside the loop is thrown as `SWALLOWED_SUMMARIZATION_FAILURE`, full rollback | DONE |
| P0 | Test coverage | Deterministic cases: 2/0 one call no-op; 16/0 three calls, pass 3 undone; second- and first-pass failure reject; focused shares | DONE (`verify-compact.ts` 70/70) |
| P1 | Test coverage | Live scenario waits for the exact `4 → 2` compaction it seeded, not `compacted|already compact` | DONE (`verify-tui.ts compacting`) |
| P1 | Documentation | Contract rows in `strands-sdk-contracts.md` § `/compact`; degradation rows in `error-handling.md`; load-bearing doc + AGENTS.md row | DONE |

### 4. Systematic Expansion
- **Similar Issues**: any darwin loop driven by an SDK boolean "did something" (`reduce`, retries) must terminate on *observed* progress, not on the boolean. Checked: the Agent's own overflow-recovery `SummarizingConversationManager` is called once per overflow by the SDK loop itself (not darwin), so it is not affected; no other darwin loop calls `reduce()`.
- **Design Improvement**: none needed beyond the guard; deliberately did not replicate SDK split arithmetic (a pre-check) — an observational guard survives SDK changes.
- **Process Improvement**: when a live scenario turns red after an unrelated correct fix, ask "what did the old bug terminate for us?" before attributing it to the environment. A scenario that accepts two mutually exclusive outcomes (`compacted|already compact`) cannot detect a lie; `tui-testing.md` already asks for state-exclusive assertion strings.

### 5. Knowledge Capture
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` § explicit `/compact` scenario (termination + failure rules, matrix rows, tests)
- [x] `.trellis/spec/backend/error-handling.md` (two degradation rows)
- [x] `docs/architecture/load-bearing-decisions.md`, AGENTS.md `/compact` row
