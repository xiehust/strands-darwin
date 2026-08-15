# Recover once from model output token limit

## Goal

When a model exhausts its configured output-token budget, preserve the SDK's partial assistant message and automatically make at most one controlled continuation attempt, so long-running coding turns can finish without lowering `thinkingEffort: high` or entering an infinite retry loop.

## Background

- The provider returns `max_output_tokens`; the Strands OpenAI Responses adapter maps that to `stopReason: 'maxTokens'`.
- `Model.streamAggregated()` then throws the exported `MaxTokensError`, carrying the assembled `partialMessage`.
- The SDK agent loop emits `AfterModelCallEvent` with the error and supports `event.retry`, but it does not add the partial message to conversation history itself.
- Darwin currently installs `SummarizingConversationManager`, which retries only `ContextWindowOverflowError`; `AgentRuntime.send()` otherwise forwards the SDK loop unchanged.
- TUI streaming already renders text deltas and flushes unterminated text on turn failure, but headless mode withholds stdout on failure and the partial message is not persisted as conversation state.
- The configured `maxTokens: 64000` is already passed through to `request.max_output_tokens`; this feature is recovery after that budget is genuinely exhausted, not a config propagation fix.

## Requirements

- Keep the configured thinking effort unchanged, including `high`.
- Handle only `MaxTokensError`; other model and transport errors retain current behavior.
- On the first `MaxTokensError` in a fresh turn:
  - retain its `partialMessage` as assistant conversation context;
  - issue one continuation model call with an explicit concise instruction to continue from the exact cutoff without repeating prior content;
  - preserve the existing SDK agent loop and use supported hooks/events rather than forking it;
  - expose the partial and continuation to TUI/headless consumers as one coherent assistant reply without duplicate text.
- Never make more than one automatic continuation attempt per fresh turn. Tool-loop model calls within the same turn must not each start an independent unbounded retry sequence.
- Persist the recovered conversation so `--resume` sees the retained partial and successful continuation.
- Preserve cancellation, permission, tool-hook, prompt-cache, model-switch, and shutdown behavior.
- Add deterministic tests with a scripted model; no network/model calls are required for the quality gate.

## Acceptance Criteria

- [ ] A first model call that throws `MaxTokensError(partialMessage)` automatically performs exactly one continuation call.
- [ ] The continuation call receives the retained partial in conversation context and a no-repeat continuation instruction.
- [ ] Successful recovery returns and persists one coherent answer containing the partial text followed by new continuation text exactly once.
- [ ] `thinkingEffort` and model config are not changed during recovery.
- [ ] A normal successful turn performs no extra model calls and is unchanged.
- [ ] Non-`MaxTokensError` failures are not retried.
- [ ] Cancellation still terminates promptly and does not trigger continuation.
- [ ] TUI and headless paths do not duplicate streamed partial text.
- [ ] If the single continuation also reaches `maxTokens`, the turn fails with an explicit truncation error while all accumulated partial assistant text remains persisted for resume/manual continuation.
- [ ] `pnpm typecheck`, focused recovery tests, `pnpm test`, and `git diff --check` pass.

## Out of Scope

- Lowering thinking effort or changing the configured `maxTokens` value.
- Repeated/unbounded continuation attempts.
- General context-window overflow policy changes.
- Automatic continuation after content filtering, refusal, guardrail, or transport errors.
