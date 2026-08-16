# Check — session trajectory

## What was verified, and how

| Claim | Evidence |
|---|---|
| Two turns append; the first turn's bytes are byte-identical afterwards | `spike/verify-trajectory.ts` → sha256 of the prefix before/after, and `seq` contiguity across two processes |
| A partial trailing line is tolerated, and the next append cannot glue onto it | truncate mid-line, re-read (1 partial line reported, 0 unreadable), append a second run, re-read (exactly 1 unreadable line, both runs' records parse) |
| Caps are enforced and every truncation is recorded | 24k-char user input and 24k-char tool input/result: each capped to 8,000 code points with `trunc` naming path, original and kept size; no line over 64 KiB; injected 512-byte budget produces `recordingStopped` and latches |
| Reasoning is presence only | a turn that really emits a reasoning block: neither its text nor its signature is in the file, the `reasoning` key is, and it still replays |
| A write failure degrades | injected failing `open`: turn completes, no throw, problem latched once, later turns keep working, TUI report names it |
| Recording does not alter the stream | identity tee over a real `Agent.stream()`: same objects, same order, nothing added or swallowed; same type sequence with recording off; an early `break` still closes the turn and leaves a valid record |
| Replay reconstructs the live history | live `HistoryItem[]` (events through `turnReducer`) deep-equals replay output ignoring process-local ids; deterministic; per-turn view; a payload a cap removed is counted, not invented |
| Replay makes no model call | comment-stripped source scan (no `new Agent`/`new *Model`/`createModelFromConfig`/`.stream(`/`.invoke(`/`runtime.js` in `src/trajectory/**`) plus a correct replay with region, endpoint, credentials and profile sabotaged |
| Search finds a known event and reports misses honestly | assistant text and tool input matched case-insensitively; type filter and limit; `no matches` for a real record; unknown session refused; snapshot-only session named |
| Fork leaves its source untouched and is usable | source snapshot and record byte-identical after fork and after the fork is used; fork snapshot verbatim; offload copied; background not copied; pointer untouched; `resolveSession` accepts it and a fresh `Agent` restores the same conversation |
| Child isolation | a child that makes its own tool call and reasons internally: neither reaches the record; one turn only; recorded and unrecorded parent conversations identical |
| CLI surface | all four verbs and 13 malformed invocations through the real parser and executor, with exit codes; `--session` accepted interactively while `--continue`/invalid ids stay usage errors |

## Commands run

- `pnpm typecheck` — clean.
- `pnpm test` — exit 0, no `FAIL` line (25 suites, `verify-trajectory` 148 assertions).
- `pnpm tsx spike/verify-trajectory.ts` — 148 passed, 0 failed.
- `pnpm tsx spike/verify-tui.ts completion` — 25 passed, 0 failed (network-free; now covers `/trajectory`).
- One live end-to-end check outside the suite (one Haiku turn, isolated HOME): the turn recorded 5
  records, `trajectory list` reported them, `trajectory replay` reproduced `you>` / `darwin>`.
- `git diff --check` — clean.

## Findings worth keeping

1. **`toJSON()` is the wire shape, not the in-memory shape.** A serialized `TextBlock` has no
   `type`, a tool result nests under `toolResult`, and a reasoning block becomes `{reasoning:…}`.
   The first draft's reasoning strip matched `type === 'reasoningBlock'` and therefore never fired
   — reasoning text would have been recorded. Fixed by matching the serialized shape, and replay
   now rehydrates through the SDK's own `contentBlockFromData`.
2. **Batch-time timestamps were misleading.** A turn is appended in one write, so stamping at flush
   gave every event in a turn the same instant. Records are now stamped when observed, and the
   `runStarted` header at recorder construction so it cannot post-date the events it precedes.
3. **A child's reasoning already reaches parent context** through `AgentResult.toString()`
   (`💭 Reasoning:`), independently of recording. Recorded in `strands-sdk-contracts.md`; the
   record contains exactly parent context and nothing more, which is what the test asserts.

## Weak assertions that were replaced rather than kept

- Cross-run event equality for pass-through (two `Agent` runs differ legitimately) → identity tee
  over one real stream.
- "reasoning text is never recorded" against a file with no reasoning in it → a turn that really
  produces one.
- A tautological "recording did not change the parent conversation" → recorded vs unrecorded
  delegation compared with tracking ids normalized.
