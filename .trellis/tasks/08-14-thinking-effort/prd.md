# Thinking effort setting and /effort command

## Goal

Let the user choose how hard the model thinks, per provider, and change it mid-session with
`/effort` — without restarting the agent or losing the conversation.

Reference: <https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html>

## Requirements

- `thinkingEffort` in `.darwin/config.json`, one of `low | medium | high | xhigh | max`,
  default `high` — the same ladder and the same default Anthropic itself documents.
- Bedrock: `additionalRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } }`.
  `effort` must sit in its own `output_config` object; inside `thinking` it is a
  `ValidationException`.
- Adaptive thinking is Claude 4.6+/5 only, and `xhigh` is Opus-only. An effort the
  model cannot serve must not reach the API — every request would 400. Clamp to the highest
  usable level and report the clamp, the same shape `planPromptCache` already uses for
  "asked for but impossible".
- `anthropic` provider: the same two fields through `AnthropicModelConfig.params`.
  `openai`: `reasoning_effort`, which has no `xhigh`/`max` — clamp those to `high` and report.
- `/effort` reports the current level; `/effort <level>` changes it for the running session
  **and** persists it to `.darwin/config.json`, so the choice survives the next start. A
  failed write costs the file, not the session (the same rule as an accepted allow-rule).
- Changing effort must not rebuild the agent: `Model.updateConfig()` is on the SDK's abstract
  base, so the live model is re-configured in place and the conversation is untouched.
- Visible in the header, as a suffix on an existing line — the header shares the live frame
  with the permission box, and a new line pushes the box off a 50-row terminal.

## Acceptance Criteria

- [x] `thinkingEffort` loads, defaults to `high`, and rejects unknown values as `ConfigError`
      listing the five levels.
- [x] A Bedrock Claude 4.6/5 model is constructed with `thinking: adaptive` + `output_config`;
      a pre-4.6 model gets no thinking fields and records a problem.
- [x] `xhigh` on a non-Opus model clamps to `high` and records the clamp — and `max` does
      **not**, because Sonnet 4.6 actually accepts it (see Notes).
- [x] `/effort` with no argument reports; `/effort medium` switches and persists; an unknown
      level is refused with the valid list and changes nothing.
- [x] Persisting merges into the raw JSON: unknown keys and unrelated settings survive.
- [x] `pnpm typecheck` and `pnpm test` pass; `verify-tui.ts effort` proves the round trip in a
      real pty.

## Notes

- Switching between `adaptive` and `enabled`/`disabled` breaks the message cache breakpoint;
  adaptive → adaptive (every `/effort` change) preserves it. darwin only ever sends `adaptive`,
  so `/effort` is cache-safe.
- The SDK already strips `thinking` from `additionalRequestFields` when `toolChoice` forces a
  tool (`bedrock.js:_getAdditionalRequestFields`) — Bedrock rejects that combination.
- Adaptive thinking implies interleaved thinking, so the model may think between tool calls.
  The TUI already renders `reasoningContentDelta` as a `thinking…` indicator.
- The AWS page claims `max` is Opus-only alongside `xhigh`. It is not: measured in us-west-2,
  `us.anthropic.claude-sonnet-4-6` accepts `low`/`medium`/`high`/`max` and rejects only `xhigh`
  (`output_config.effort: Input should be 'low', 'medium', 'high' or 'max'`), while every
  pre-4.6 Claude rejects the whole `output_config` object. `spike/verify-thinking-live.ts`
  re-measures this matrix and cross-checks the planner against it.
- `low` vs `high` is observably different, not just a hint: on the same logic puzzle `high`
  emitted a reasoning block and a worked answer, `low` answered "Colin" with no reasoning.
