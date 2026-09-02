# SER-052 `/compact` terminates and reports honestly

## Goal

`compactConversation` (`src/agent/compact.ts`) loops `while (messages.length > preserveRecentMessages + 1)`
on `manager.reduce({ agent, model })` and assumes every `true` shrinks the list. The SDK's
`_summarizeOldest` summarizes `min(max(1, floor(len × 0.8)), len − preserve)` messages and splices
one summary back, so a 2-message conversation with `preserveRecentMessages: 0` (and, after enough
passes, every `preserveRecentMessages: 0` conversation) reaches a state where a pass returns `true`
and the count stays 2 — the loop never ends (Host probe: 26 paid summarizer calls). Two defects
compound it: darwin calls `reduce()` without `error`, so the SDK's proactive path swallows a
summarization failure and returns `false`, which the loop treats as a normal stop — reporting
`compacted: true` when an earlier pass shrank — and `/compact` cannot be cancelled. The live
`spike/verify-tui.ts compacting` scenario (2-message seed, `preserveRecentMessages: 0`) has been red
since `f4e3271` removed the provider rejection that used to end the loop by accident.

Origin: `docs/research/backlog/directions-061-080.md` § SER-052 (Notes subsection is the contract);
report `docs/research/research_2026-09-02.md` § Host-found direction during the batch.

## Decisions (recorded here and in the spec)

1. **No-shrink guard, SDK-agnostic.** Before each pass the loop keeps a shallow snapshot of the
   message list (the SDK only splices; it never mutates member messages). A pass that returns
   `true` without lowering `agent.messages.length` is *undone* (the snapshot is spliced back, so
   message identity survives) and the loop stops. `compacted` is true only if the count really
   dropped; `messagesAfter` is the real count. No theoretical-maximum pass bound is needed: every
   iteration either lowers the count by ≥ 1 or exits. The SDK arithmetic is deliberately **not**
   replicated in darwin (no pre-check for "can this pass shrink"): the guard costs at most one
   summarizer call in the degenerate case and stays correct if the SDK changes its split rules.
2. **2 messages / preserve 0 is "already compact" (no-op), not "one summary replaces the pair".**
   The SDK clamps `summaryRatio` to `[0.1, 0.8]`, so a 2-message history can never be summarized in
   one pass (`floor(2 × 0.8) = 1`), and summarizing the single oldest message into a summary of itself
   lowers nothing while losing fidelity. The undone pass leaves the conversation byte-identical, the
   result is `compacted: false`, and the TUI prints the existing `conversation already compact` notice
   after exactly one summarizer call. Consequence, recorded: with `preserveRecentMessages: 0` the
   floor of a compaction is two messages (one rolling summary plus the newest message), and the final
   pass that discovers the floor costs one summarizer call. `COMPACT_SUMMARY_RATIO` and the Agent's
   own overflow-recovery manager (`runtime.ts`) are untouched.
3. **Swallowed failure = detected `false`, not a sentinel `error`.** Inside the loop the SDK has no
   legitimate `false`: `messagesToSummarizeCount <= 0` needs `len <= preserve` (excluded by the loop
   condition) and the all-protected branch needs `pinFirst` (never set on the `/compact` manager).
   So a `false` inside the loop is a swallowed summarization failure and `compactConversation` throws
   a bounded error naming that; the existing catch restores the cloned originals and the TUI /
   headless print `compaction failed; conversation restored: …`. The sentinel route was rejected
   because `reduce`'s `error` is typed `ContextWindowOverflowError` (a fabricated overflow instance),
   the SDK overwrites the thrown error's `.cause` with it, and darwin *does* read `.cause`:
   `failureFromError` (`src/trajectory/record.ts`) would print `cause: ContextWindowOverflowError`
   in a structured headless `--compact-before` runtime failure. The user-visible reason is not lost:
   the SDK's own `proactive summarization failed` warning is already routed into the transcript
   (`routeSdkLogs` → `sdk warn:` notice in `App.tsx`; stderr in headless) immediately before darwin's
   failure notice. A failure on any pass — first or later — rejects and restores everything
   (all-or-nothing, matching the existing persistence-failure semantics).
4. **The `compacting` pty scenario seeds 4 messages with `preserveRecentMessages: 1`.** Under
   decision 2 its old 2-message / preserve-0 case is a genuine no-op; the scenario exists to prove
   keyboard/paste ownership *during a real compaction*, so it now seeds two turns and preserves one
   message: `min(max(1, floor(4 × 0.8)), 4 − 1) = 3` messages summarized in exactly one pass →
   `conversation compacted — 4 → 2 messages`. The wait tightens to `conversation compacted`.

## Requirement → check checklist

| Requirement | Check |
|---|---|
| 2 messages / preserve 0 terminates, ≤ 1 summarizer call, `compacted: false`, `messagesAfter: 2`, messages byte-identical, nothing persisted | `spike/verify-compact.ts` new case (a) |
| The final no-shrink pass is undone, earlier shrinking passes are kept (16 messages / preserve 0 → exactly 3 summarizer calls, `compacted: true`, 2 messages left, rolling summary is `summary-2` not `summary-3`, newest message keeps identity) | `verify-compact.ts` new case (a′) |
| Summarizer failure on the second pass → rejects, conversation restored byte-identical, `persist` never called, error names the swallowed failure | `verify-compact.ts` new case (b) |
| Summarizer failure on the first pass → rejects, restored, exactly one summarizer call | `verify-compact.ts` new case (c) |
| Reasoning-only summary response (SDK `generateSummary` throws) now surfaces as failure, never a silent no-op | `verify-compact.ts` existing case updated with reason |
| Focused path inherits both guards | `verify-compact.ts` new case (e): `createCompactionManager(0, focus)` on 2 messages → one focused call, no-op |
| Existing 52 cases unchanged except the recorded reasoning-only update | `verify-compact.ts` green |
| `/compact` in the TUI compacts a real 4-message / preserve-1 seed with input ownership intact | `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts compacting` (live) |
| Headless `--compact-before` still parses and reaches `runtime.compact()` (guards live in `compactConversation`, shared) | `spike/verify-headless.ts`, code review of `headless-runner.ts:191` |
| Spec: termination + failure rules; degradation rows | `strands-sdk-contracts.md` § explicit `/compact` scenario; `error-handling.md` rows |
| Gate | `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL), `pnpm build` |

## Acceptance Criteria

- [x] `compactConversation` stops on a no-shrink pass (undone), throws on a swallowed `false`, and reports `compacted` / `messagesAfter` truthfully; focused and unfocused paths share the loop.
- [x] `spike/verify-compact.ts` covers every checklist row and passes.
- [x] `spike/verify-tui.ts compacting` green live with a real compaction.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` and `error-handling.md` state the rules; `docs/architecture/load-bearing-decisions.md` and the AGENTS.md `/compact` row name the invariant.
- [x] `pnpm typecheck` clean, full `pnpm test` green, `pnpm build` clean.

## Verification (2026-09-02)

- `spike/verify-compact.ts` 70/70 (52 existing — the reasoning-only case updated to expect the failure it is — plus 18 SER-052 assertions).
- `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts compacting` 5/5, live, compaction took 15 s and reported `conversation compacted — 4 → 2 messages`.
- `spike/verify-headless.ts` 182/182; `pnpm typecheck` clean; full `pnpm test` exit 0, zero FAIL lines.
- AGENTS.md 31 657 bytes (< 32 KiB cap).
- Break-loop analysis: `break-loop.md` in this task directory.
