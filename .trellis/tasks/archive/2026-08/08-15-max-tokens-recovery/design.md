# Design: one-shot max-token recovery

## Boundary

Implement recovery as an SDK `AfterModelCallEvent` hook installed on every Darwin-created agent. Do not fork or wrap the SDK agent loop. The hook handles only exported `MaxTokensError` and uses `event.retry`, the SDK's supported retry extension point.

## Recovery state

Use the per-invocation `event.invocationState` record, shared by every model attempt/cycle in one `Agent.stream()` invocation, with private symbol keys:

- whether the one continuation allowance has been consumed;
- retained partial assistant messages;
- any synthetic continuation instruction inserted for the retry.

`attemptCount` alone is insufficient because tool calls can create later model-call retry sequences in the same invocation. Invocation-scoped state enforces one recovery for the whole turn.

## First max-token failure

1. Confirm `event.error instanceof MaxTokensError` and recovery is unused.
2. Mark recovery consumed before any await/mutation that could fail.
3. Append `error.partialMessage` to `event.agent.messages` as assistant context.
4. Append a synthetic user message instructing the model to continue exactly from the cutoff, avoid repeating retained content, finish concisely, and treat the synthetic message as recovery control rather than a new user request.
5. Set `event.retry = true`.

The partial message was already emitted as streaming deltas/content blocks to the current UI consumer. Appending it only to SDK conversation history must not synthesize duplicate stream events.

## Successful continuation

The SDK retries the same model call against the mutated conversation, then appends its normal assistant result. The consumer has already received partial stream content followed by continuation stream content, producing one coherent reply. The retained partial and continuation are both persisted by the normal invocation snapshot.

The synthetic user control message remains in history for provider role validity and reproducible resume context; its wording clearly marks it as internal recovery control.

## Second max-token failure

When recovery is already consumed:

1. Append the second `partialMessage` to conversation history.
2. Do not set `retry`.
3. Allow the `MaxTokensError` to propagate so TUI/headless report failure rather than false success.

The normal `AfterInvocationEvent` session snapshot then persists accumulated partial context. The next user/headless supervisor can resume and explicitly continue.

## Persistence and rendering

- Session manager already snapshots on every invocation, including error paths.
- TUI flushes live deltas on `turnEnded`; retained history mutation emits no duplicate `ContentBlockEvent`.
- Headless continues to fail and withhold stdout when the continuation also truncates; the accumulated partial remains resumable.
- A successful recovery returns the concatenated streamed partial plus continuation through the existing consumers.

## Agent coverage

The main runtime and `SubagentTool` children both receive the same max-token recovery hook factory/handler. This is separate from permission/tool-hook intervention because it participates in model-call lifecycle, not tool lifecycle.

## Risks and mitigations

- **Partial ends in an incomplete tool call:** retry context may contain a partial `ToolUseBlock`; scripted tests must cover text-first MVP. If SDK exposes malformed partial tool content, fail rather than invent arguments.
- **Duplicate visible text:** never re-emit retained partial as an agent stream event; assert exact output once in TUI reducer/headless tests.
- **Retry loop:** consume allowance in invocation state before setting `retry`; second failure never retries.
- **Persistence ordering:** rely on SDK `AfterInvocationEvent` snapshot and prove failed second continuation restores both partials from disk.
