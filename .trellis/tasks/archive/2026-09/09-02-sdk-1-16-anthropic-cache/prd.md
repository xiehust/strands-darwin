# Upgrade `@strands-agents/sdk` to 1.16.0 and enable anthropic `cacheConfig`

## Goal

Move darwin's pinned SDK from 1.12.0 to the current `latest` (1.16.0, 2026-08-31) so the
`anthropic` provider can use the SDK's official `cacheConfig` — the same tools / system prompt /
conversation caching, with the configured TTL, that the `bedrock` provider already has.

Origin: the previous task (`09-02-anthropic-base-url`) made `provider: "anthropic"` usable, but a
live probe against `ANTHROPIC_BASE_URL` showed only the tools+system prefix (~5,037 tokens) being
read from cache while the conversation was re-sent at full price every turn (836 → 1,344 → 1,867
uncached input tokens over three turns), and `promptCacheTtl: "1h"` silently did nothing. Cause:
SDK 1.12.0's `AnthropicModel` has no `cacheConfig` and hard-codes `cache_control: {type:'ephemeral'}`
for hand-placed points; 1.16.0 adds `cacheConfig` (`ttl`, `toolsTTL`, `systemPromptTTL`,
`messagesTTL`) with the same shape as Bedrock. The user chose the upgrade over a darwin-side shim.

## Requirements

1. `@strands-agents/sdk` pinned at `1.16.0`; `patches/@strands-agents__sdk@1.16.0.patch` replaces the
   1.12.0 patch and carries **every** existing hunk intent (verified on a pristine 1.16.0 tarball:
   11 hunks apply, 3 need re-doing by hand — `bash/index.js`, `bash/index.d.ts` (`createBash` export
   moved into a re-shaped index) and `file-editor.js` hunk 3 (miss-context advisory onto the rewritten
   `findOccurrences` str_replace)). No patched behaviour regresses.
2. SDK 1.16.0's optional `@tobilu/qmd` dependency (pulls native `better-sqlite3`, `node-llama-cpp`,
   `tree-sitter-*`; darwin never imports it) is excluded via `ignoredOptionalDependencies` so
   `pnpm install` stays clean without approving native builds darwin does not use.
3. Darwin adapts to 1.16.0 API changes: `ToolContext.cancelSignal` is now required (one src site,
   two spikes). Any other typecheck breakage is fixed with minimal edits, never by loosening types.
4. `createAnthropicModel` passes `cacheConfig` derived from `planPromptCache` (one `ttl` for every
   section, exactly as `bedrockCacheConfig` does), and `planPromptCache` reports the anthropic parts
   truthfully: `tools`, `system prompt`, `conversation`. Darwin's hand-placed system-prompt cache point
   stays (1.16 honours it and fills its TTL from `cacheConfig.ttl`). Bedrock behaviour unchanged.
5. Docs/spec that state `1.12.0` as the pinned version are updated where the statement is about the
   pin (README badge, AGENTS/spec/doc references to the patch file name); "measured on 1.12.0" comments
   in source stay unless the measurement changes.

## Non-goals

- Adopting any other new 1.13–1.16 feature (qmd storage, notebook/shell/sleep vended tools, …).
- Changing what the `openai` provider caches.

## Acceptance Criteria

- [ ] `pnpm install --frozen-lockfile` clean (no ignored-build error); `node --check` on installed
      `file-editor.js`; `pnpm typecheck` green.
- [ ] `pnpm test` green; focused patch suites first: `verify-file-editor.ts`, `verify-background-bash.ts`,
      `verify-compact.ts`, `verify-context-offload.ts`, `verify-retry-guard.ts`, `verify-http-request-tool.ts`.
- [ ] Free pty scenarios: `verify-tui.ts completion`, `bang`, `mcp`, `clear`.
- [ ] `verify-config.ts` asserts the anthropic model's `getConfig().cacheConfig` shape and the plan parts.
- [ ] Live: `spike/verify-anthropic-live.ts` extended with a cache assertion — turn 1 writes
      (`cacheWriteInputTokens > 0`) and a later turn's `cacheReadInputTokens` exceeds the tools+system
      prefix alone (conversation is cached); `verify-prompt-cache-live.ts` (Bedrock) still passes.
- [ ] `pnpm build` after commit.
