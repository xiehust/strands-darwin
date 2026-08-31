# Compact summary must not carry reasoning content into a user message

## Goal

Stop `/compact` (and overflow-recovery summarization) from producing a `role: 'user'`
summary message that contains `reasoningBlock` content, which Bedrock rejects with
`ModelError: User messages cannot contain reasoning content` — and repair sessions
that already persisted such a message.

## Incident evidence

- Running `/compact` logs `warn ! sdk warn: error=<ModelError: User messages cannot
  contain reasoning content. Please remove the reasoning content and try again.> |
  proactive summarization failed, continuing`.
- Root cause is in the SDK, `dist/src/conversation-manager/compression/context-compression.js`
  `generateSummary()`: it wraps the model's **entire** response content in
  `new Message({ role: 'user', content: result.value.message.content })`. Darwin always
  runs with adaptive thinking, so the summary response carries `ReasoningBlock`s; they
  land verbatim in a user-role message.
- `compactConversation` (`src/agent/compact.ts`) loops `manager.reduce()`; the first
  pass succeeds and poisons the history, the second pass sends the poisoned summary
  message back to Bedrock and fails — the warn above. The poisoned message is then
  persisted by `/compact`'s snapshot save, so later ordinary turns and resumed
  sessions can hit the same rejection.

## Requirements

- Fix in the existing pinned pnpm patch (`patches/@strands-agents__sdk@1.12.0.patch`,
  wired in `pnpm-workspace.yaml`), narrowly scoped: `generateSummary()` must drop
  `reasoningBlock` content blocks from the model's summary response before building
  the user-role summary message. If nothing remains after dropping them, treat it as
  a failed summary (throw), never insert an empty user message. Both managers
  (overflow recovery and `/compact`) share this path, so one fix covers both.
- Repair already-poisoned histories: after session restore (post-`agent.initialize()`
  and after an explicit rewind `restoreSnapshot`), strip `reasoningBlock`s from
  **user-role** messages in the live message list. A user message can never legally
  carry reasoning content on any provider, so the strip is safe. In-memory only;
  the next ordinary save persists it. Trajectory bytes are never rewritten.
- Keep the SDK agent loop unforked; no new information channels; no model calls or
  network in tests.
- Patch hygiene per spec: regenerate the patch from the pristine package (pnpm patch),
  `node --check` the patched installed file, and keep every existing patch hunk intact.

## Acceptance Criteria

- [ ] `spike/verify-compact.ts` grows regression coverage: a deterministic model that
      emits reasoning deltas on summary calls; assert the summary message contains no
      `reasoningBlock`, remains user-role with the summary text intact, and repeated
      `reduce` passes over a compacted history succeed.
- [ ] The restore-time repair is a small exported helper with direct test coverage
      (poisoned user message is stripped, assistant reasoning is untouched, bounded
      reporting of how many messages were repaired), plus its runtime wiring.
- [ ] `pnpm typecheck` and `pnpm test` pass; the patched SDK file passes `node --check`.
- [ ] `.trellis/spec/backend/strands-sdk-contracts.md` compact scenario records the new
      contract (summary content is reasoning-free; restore-time user-message repair).
- [ ] `pnpm build` refreshes `dist/` after the accepted commit.
