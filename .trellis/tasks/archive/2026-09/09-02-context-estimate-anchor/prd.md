# Calibrate the `/context` estimate with the prompt tokens the model actually reported

## Goal

Stop reporting `/context` as a pure character heuristic when the provider has already told us
what the request really cost. Anchor the estimate on the **measured** prompt-token total of the
most recent completed model call and estimate only the messages appended *since* that call, so
the largest and most heuristic-hostile part of the request — the system prompt plus every
`toolSpec` — becomes a measured number and the residual error is bounded by one turn's tail
instead of accumulating over a whole session.

Read-only feature: an observer over events `AgentRuntime.send` already forwards. No new model
call, no new provider request class, no trajectory field, no live-frame row, no config key.

## Background — why an anchor and not a correction factor

darwin sets `useNativeTokenCount: true`, but Bedrock's `CountTokens` refuses the
inference-profile ids darwin requires, so after the first failure the SDK caches the model as
skipped and every `/context` is `estimateTokensHeuristic` — `chars/4` for text, `chars/2` for
JSON tool specs (`node_modules/@strands-agents/sdk/dist/src/models/model.js:388`). Meanwhile
`AgentRuntime.observeCallStats` already reads the provider's real per-call counters out of
`afterModelCallEvent.stopData.message.metadata.usage`, and `averageRequestInputTokens`
(`src/agent/call-stats.ts`) already computes the exact "submitted request total" arithmetic this
task needs. The measurement is in the process; it just never reached the estimate.

The rejected alternative (recorded here so it is not re-proposed) is fitting a ratio
`measured / heuristic` and multiplying future heuristics by it. It replaces one unknown with
another: the ratio is provider-, tokenizer- and content-dependent (images, reasoning blocks and
JSON tool specs each have their own error), it needs a smoothing window and clamps nobody can
justify, and a wrong ratio silently scales *everything* — including the `contextWarnRatio`
latch. The anchor form has no fitted parameter: it is a measured base plus a one-turn tail.

## Requirements

### Shared arithmetic (no second copy)

- Extract the "what was actually submitted for this call" arithmetic into
  `requestInputTokens(usage: UsageTotals, config: AppConfig): number | undefined` in
  `src/agent/usage.ts`, over the existing `usageBuckets` projection: OpenAI Responses reports
  cache activity as subsets of `inputTokens` (so its input *is* the request total), every other
  provider reports cache read/write beside uncached input (so the request is their sum, an
  unreported cache counter contributing nothing). `undefined` when the buckets cannot split
  honestly — unknown, never 0.
- `averageRequestInputTokens` is rewritten to call it, so `/usage`'s efficiency line, `/status`
  and the new anchor cannot disagree about what a request cost.
- Export the existing private `usableUsage` from `call-stats.ts` (as `readCallUsage`) rather
  than writing a second defensive usage reader.

### The anchor (`src/agent/context-anchor.ts`, pure)

- State: `{ requestTokens: number; messageCount: number; boundary: unknown }` where
  `requestTokens` is the measured total for that call, `messageCount` is
  `agent.messages.length` observed at that moment, and `boundary` is the object reference at
  `messages[messageCount - 1]` — the identity handle that detects a rewritten history.
- Install only from a *completed* call (`stopData` present) whose usage yields a finite
  `requestInputTokens` and where `messageCount >= 1`. A failed or unmetered call installs
  nothing and invalidates nothing: the previous anchor stays the best measurement available.
- `resolveAnchor(anchor, messages)` returns the anchor only when it is still describable:
  `messages.length >= anchor.messageCount` **and**
  `messages[anchor.messageCount - 1] === anchor.boundary`. Otherwise `undefined` — a dropped
  anchor is never repaired, only replaced by the next completed call.
- Pure and non-throwing by construction, like `call-stats.ts`: allocation only, no SDK import,
  a malformed payload costs the anchor, never the turn.

### Runtime wiring (`src/agent/runtime.ts`)

- One private field plus one observer, folded into the existing `afterModelCallEvent` path in
  `send`'s `recordStream` — its own `try/catch` and its own broken latch, so an anchor failure
  can neither break the call-stats tally nor become a second reason a turn dies (the observer
  sits between `stream()` and `yield`).
- Parent-only for free: children never pass through `AgentRuntime.send`.
- `changeModel()` clears the anchor: a measurement made by the previous model's tokenizer and
  prompt overhead does not describe the new one. `/clear` and `/rewind` build a successor
  runtime through `create()`, so their anchor starts empty with no extra code; `/compact`
  shortens and rewrites `agent.messages`, so `resolveAnchor` drops it on the next read.
- `contextEstimate()` becomes:
  - **anchor live** — `estimatedTokens = anchor.requestTokens + tailTokens`, where `tailTokens`
    is `0` for an empty tail and otherwise
    `model.countTokens(messages.slice(anchor.messageCount), {})` — the same SDK counter, no
    second estimator, deliberately without `systemPrompt`/`toolSpecs` because the anchor already
    measured them.
  - **no anchor** — byte-identical to today: `countConversationTokens(model, agent)`.
  - A `countTokens` failure on the tail must not lose the measurement: fall back to
    `anchor.requestTokens` with `tailTokens: undefined` rather than throwing away the anchor.
- `ContextEstimate` grows two optional fields, absent when there is no anchor:
  `measuredTokens?: number` and `tailTokens?: number`. Absent means "not measured", the
  `usageBuckets` honesty rule — never 0.

### Presentation (`src/tui/context-format.ts`, shared with `/status`)

- No anchor: **byte-identical to today** —
  `estimated context — ~N tokens · P% of W window · M message(s)`.
- Anchor live: `context — ~N tokens (measured M + ~T new) · P% of W window · K message(s)`,
  where `M` is the measured base and `T` the tail estimate; an empty tail reads `+ ~0 new` and a
  failed tail count reads `(measured M + tail unknown)`.
- `formatWindowShare`, the `<1%` rule and `createContextWarnLatch` are untouched: the latch
  consumes the same estimate, gets more accurate for free, and gains no second threshold.
- `/status`'s `context` row keeps using `formatContextValue`, so the two surfaces cannot drift.

## Acceptance Criteria

- [x] `spike/verify-context-anchor.ts` (new, free — offline, no model call) proves over a fake
      `Model`/messages pair: install from a completed metered call; no install from a call with
      no `stopData`, unusable usage or empty messages; the previous anchor survives an unmetered
      call; the anchor resolves after an appended message and is dropped by a shortened history,
      a replaced boundary object and `changeModel`; `estimatedTokens === measured + tail`; an
      empty tail counts zero and makes no `countTokens` call; a throwing `countTokens` degrades
      to `measured` with `tailTokens` absent; and the Bedrock/Anthropic vs OpenAI-Responses
      request-total split is asserted against `requestInputTokens` directly.
- [x] `spike/verify-context-format.ts` extends to both shapes: the no-anchor line stays
      byte-for-byte what it asserts today, and the anchored line, the empty tail, the unknown
      tail and `window unknown` are pinned.
- [x] `spike/verify-status-command.ts` still green, including its byte-zero-mutation assertions,
      with the anchored `context` row pinned in at least one case.
- [x] Full `pnpm test` green; `pnpm typecheck` clean; `pnpm build` run before reporting done.
- [x] A live check on Bedrock records the real numbers: `/context` before and after one
      tool-using turn, showing the measured base moving with each completed call and the tail
      shrinking to a fresh measurement — pasted into a Verification section below.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` § "`/context` counting and model metadata"
      documents the anchor, its invalidation matrix and the rejected correction-factor form;
      `docs/architecture/load-bearing-decisions.md` plus the `AGENTS.md` index row for the
      context-pressure decision state that the estimate is measured-base + tail.

## Verification (2026-09-02)

- `pnpm tsx spike/verify-context-anchor.ts` — 30 passed, 0 failed (new suite, free).
- `pnpm tsx spike/verify-context-format.ts` — 34 passed, 0 failed (was 29).
- `pnpm tsx spike/verify-status-command.ts` — 57 passed, 0 failed (was 56).
- `pnpm tsx spike/verify-call-stats.ts` — 24 passed, 0 failed (unchanged count; its
  `averageRequestInputTokens` assertions now run through the extracted `requestInputTokens`).
- `pnpm typecheck` clean; `pnpm build` clean; full `pnpm test`: every suite `0 failed` except one
  flake in `verify-subagent-heartbeats.ts` ("active dispatches emit periodic … heartbeats"), which
  passes standalone (36/0) — a timer-interval suite under parallel load, untouched by this change.
- Live, on the configured Bedrock Claude Opus 5 with prompt caching on — the point of the whole
  task in three lines:

  ```text
  before any call : estimated context — ~26,775 tokens · 3% of 1,000,000 window · 0 message(s)
  after turn 1    : context — ~33,107 tokens (measured 33,106 + ~1 new) · 3% of 1,000,000 window · 2 message(s)
  after tool turn : context — ~33,575 tokens (measured 33,569 + ~6 new) · 3% of 1,000,000 window · 6 message(s)
  ```

  The heuristic was undercounting the real prompt by ~19% (26,775 vs 33,106) before a single
  message existed — almost all of it system prompt and tool specs, exactly the part the anchor
  turns into a measurement. The base moves with each completed call; the tail stays tiny.

- Requirement → check: shared request arithmetic → "measured request size" section plus
  `verify-call-stats.ts`; install/refusal rules → "anchor — what a completed call installs";
  invalidation matrix (shortened, same-length rewrite, compaction shape, `/model`) → "anchor — when
  the measurement still describes the history" and the runtime section; measured-base + tail math,
  tail-only counting and failed-tail degradation → the offline runtime section; both rendered shapes
  and the byte-identical no-anchor line → `verify-context-format.ts`; shared `/status` renderer →
  `verify-status-command.ts`.

## Notes / open risks to settle during implementation

- **Tail slice validity.** A tail can begin with an assistant message or a `toolResult`-only
  user message. Where native counting *is* available, `CountTokens` may reject such a fragment;
  the SDK catches it, logs at debug and falls back to the heuristic. Only `AccessDeniedException`
  and "doesn't support counting tokens" poison the SDK's skip set, and neither is provoked by
  fragment shape — but re-read `bedrock.js:256` before relying on this, and assert the
  degradation.
- **System-prompt drift within a turn.** `<working-context>` is re-derived every run, so the
  measured base describes the previous call's system prompt, not the next one's. Every completed
  call refreshes the anchor, so the error is bounded by one call's worth of drift — which is the
  whole design claim, and belongs in the spec rather than hidden.
- **Cache accounting.** The measured base includes cache-read tokens on purpose: the question
  `/context` answers is "how full is the window", and a cached prefix still occupies it. This is
  deliberately not a billing view, and the spec must say so before someone "fixes" it.
- **Resume.** A resumed session has no anchor until its first completed call, so it reports
  today's heuristic line — honest, and self-correcting after one turn.
