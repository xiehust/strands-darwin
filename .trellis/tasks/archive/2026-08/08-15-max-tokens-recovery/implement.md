# Implementation plan

1. Add a focused max-token recovery module under `src/agent/`.
   - Register an `AfterModelCallEvent` hook.
   - Detect `MaxTokensError` by class identity.
   - Store one-shot state in `InvocationState` using private symbols.
   - Append partial assistant context and internal continuation control message.
   - Retry exactly once; preserve and rethrow the second failure.
2. Wire the hook into the main Agent in `src/agent/runtime.ts` and every child Agent in `src/agents/subagent-tool.ts` without changing the SDK loop.
3. Add deterministic scripted-model verification.
   - normal success/no retry;
   - first maxTokens then success;
   - second maxTokens fails with both partials retained;
   - non-max error and cancellation do not retry;
   - model config/thinking fields remain unchanged;
   - successful streamed output has no duplicate partial text;
   - failed recovery snapshot persists accumulated partials.
4. Add the focused suite to `spike/run-tests.ts` and update relevant backend SDK/error specs.
5. Run `pnpm typecheck`, the focused suite, `pnpm test`, and `git diff --check`.

## Review gates

- Do not intercept or replace `Agent.stream()`.
- Do not lower effort or mutate model config.
- Do not expose a second retry path through per-cycle `attemptCount` reset.
- Do not report the twice-truncated turn as success.
- Preserve unrelated existing dirty changes.
