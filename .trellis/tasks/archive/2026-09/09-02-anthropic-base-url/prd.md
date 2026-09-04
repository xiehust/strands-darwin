# Anthropic Messages API provider with custom base URL

## Goal

Make `provider: "anthropic"` actually usable and let it target any Anthropic-Messages-API-
compatible endpoint (gateway, proxy, CloudFront relay) through a configurable base URL.

Today `src/config.ts` already names an `anthropic` provider and builds the SDK's
`AnthropicModel`, but the optional peer `@anthropic-ai/sdk` is not installed (selecting the
provider fails with the "needs the @anthropic-ai/sdk package" `ConfigError`, which
`spike/verify-config.ts` currently asserts as expected), and no base URL can be set anywhere
(`rg baseURL src` is empty). The Strands docs
(<https://strandsagents.com/docs/user-guide/concepts/model-providers/anthropic/#custom-client>)
describe two ways to reach a custom endpoint: `clientConfig: ClientOptions` or a pre-built
`client`. Both are SDK extension points; neither forks the loop.

## Requirements

1. `@anthropic-ai/sdk` becomes a direct dependency (same footing as `openai`), so
   `provider: "anthropic"` works out of the box. `createAnthropicModel` keeps its dynamic import
   and `ConfigError` wrapping (no static import in `config.ts`).
2. New optional model field `baseUrl` (string, `http:`/`https:` URL) — **anthropic-only**; setting
   it on `bedrock`/`openai` is a `ConfigError` naming the key and the provider, in the same style
   as `openaiApi` / `bedrockMantle` / `requestTimeoutMs`.
3. Resolution order for the effective base URL is owned by darwin, not left to the client:
   `baseUrl` → non-empty `ANTHROPIC_BASE_URL` → SDK default (`https://api.anthropic.com`). The
   resolved value is passed as `clientConfig.baseURL` whenever it is not the default, so the
   choice is visible in one place and testable without a network.
4. A missing credential fails as `ConfigError` before the dynamic import: with no `apiKeyEnv`, an
   empty/unset `ANTHROPIC_API_KEY` is refused with a message naming both options, instead of the
   SDK's bare `Error`.
5. Thinking (`params`), `/effort` (`updateConfig({ params })`), prompt-cache planning and every
   other anthropic behaviour stay exactly as they are.
6. The closed config schema stays consistent: `MODEL_KEYS` grows with `baseUrl`, and both
   `docs/user-guide/configuration*.md` model tables get the row (`documentedKeys()` walks them).
7. Verification uses the environment's `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`: a live spike
   proves a real tool-calling turn plus a second turn through the custom endpoint.

## Non-goals

- No new provider name, no `client` instance plumbing beyond `clientConfig`, no header/`/status`
  row for the base URL, no per-provider request timeout (still Bedrock-only), no native token
  counting for anthropic.
- No change to the `openai` base URL story (Mantle derives its own).

## Acceptance Criteria

- [ ] `pnpm typecheck` passes; `pnpm test` passes (including the rewritten anthropic section of
      `spike/verify-config.ts`).
- [ ] `verify-config.ts` proves: anthropic constructs with a fake key; `baseUrl` is accepted for
      anthropic, refused for bedrock/openai, refused when not an `http(s)` URL; `ANTHROPIC_BASE_URL`
      is used when `baseUrl` is absent and ignored when `baseUrl` is set; missing key → `ConfigError`
      naming `apiKeyEnv` and `ANTHROPIC_API_KEY`.
- [ ] `pnpm tsx spike/verify-anthropic-live.ts` (new, *live*) against the current env: reports the
      resolved base URL, completes a tool-using fix-a-bug turn, then a follow-up turn, and exits 0.
- [ ] Docs: `docs/user-guide/configuration*.md` table row, `getting-started*.md` Direct Anthropic
      section (peer install no longer required; `baseUrl`/`ANTHROPIC_BASE_URL`), README note, AGENTS.md
      live-suite list entry, spec § Model Configuration.
- [ ] `pnpm build` refreshes `dist/` after the commit.
