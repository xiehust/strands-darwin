# Claude prompt caching

## Goal

Cut token cost and latency on every turn by placing Bedrock/Anthropic **cache points** around
the parts of a request darwin re-sends unchanged: the tool schemas, the assembled system
prompt (base + AGENTS.md + `<available-skills>`), and the accumulated conversation.

Reference: <https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#caching>

## Requirements

- Reuse the SDK, never hand-roll cache blocks in a request:
  - tools + conversation via `BedrockModel({ cacheConfig: { strategy: 'auto' } })`, which appends
    a cache point after `toolConfig.tools` and to the last user message each request;
  - system prompt via a `CachePointBlock` appended to `Agent.systemPrompt` as a block array.
- The system-prompt cache point must be applied **after** `agent.initialize()`, because
  `SkillsPlugin.initAgent` appends `<available-skills>` and throws on a block-array prompt.
  Prompt composition itself stays string concatenation.
- Claude-only, and off for providers/models that cannot cache. The SDK logs a `console.warn`
  for `strategy: 'auto'` on a non-caching model, which would garble the Ink frame — so gate on
  the model id rather than letting the SDK warn.
- `anthropic` provider: system-prompt caching only (`AnthropicModelConfig` has no `cacheConfig`).
  `openai`: nothing.
- Configurable in `.darwin/config.json`, on by default (a coding agent re-sends a large static
  prefix every turn; the write premium pays back within one turn):
  - `promptCache: boolean` — default `true`
  - `promptCacheTtl: '5m' | '1h'` — default unset (Bedrock's own 5m). One TTL for every cache
    point, since Bedrock requires TTLs to be non-increasing across tools → system → messages.
- The `auto`-mode safety classifier must not carry cache config: single-shot sub-1k-token
  prompts can never reach the minimum cacheable size.
- Visible in the header, like every other startup decision, including why it is off when the
  user asked for it and the model cannot do it.

## Acceptance Criteria

- [x] `promptCache` / `promptCacheTtl` load, validate, and reject bad values as `ConfigError`.
- [x] Bedrock Claude model is constructed with `cacheConfig`; non-Claude Bedrock model is not.
- [x] After `initialize()`, `agent.systemPrompt` is `[TextBlock, CachePointBlock]` and the text
      still contains the base prompt, `<project-instructions>` and `<available-skills>`, in order.
- [x] `promptCache: false` leaves a plain string prompt and no `cacheConfig`.
- [x] Live: two turns against Bedrock report `cacheWriteInputTokens > 0` on the first and
      `cacheReadInputTokens > 0` on the second.
- [x] `pnpm typecheck` and `pnpm test` pass; header shows the cache state.

## Notes

- Summarization (`SummarizingConversationManager`) rewrites history and invalidates the
  conversation cache on the turn it fires; the system prompt and tools cache survive it.

## Outcome

Implemented in `src/agent/prompt-cache.ts` (decision + placement), `src/config.ts`
(`promptCache` / `promptCacheTtl`, `cacheConfig` on the Bedrock model), `src/agent/runtime.ts`
(cache point applied after `initialize()`, plan on `RuntimeInfo`), `src/agent/safety-classifier.ts`
(opted out), header lines in `src/tui/App.tsx` and `src/dev-repl.ts`.

Verified: `pnpm typecheck`; `pnpm test` (241 assertions, including the new
`spike/verify-prompt-cache.ts`, 35); `spike/verify-prompt-cache-live.ts` — turn 1 wrote 12,035
tokens, turn 2 read 12,035 and was charged 3 input tokens; `verify-tui.ts` `approve`,
`bashExit`, `cancelThenContinue`.

Lesson worth keeping (captured in `.trellis/spec/frontend/tui-testing.md`): the first version
put the cache state on its own header line, which pushed the permission box off the 50-row pty
and broke three `approve` assertions. Header state now rides on the model line.
