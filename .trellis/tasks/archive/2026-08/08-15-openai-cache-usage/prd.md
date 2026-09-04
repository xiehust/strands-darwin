# Fix OpenAI cache usage reporting

## Goal

Make `/usage` accurately report prompt-cache activity for the configured OpenAI Responses model over Bedrock Mantle without inventing unavailable values or changing Bedrock/Anthropic behavior.

## Background

- The configured path is `provider: "openai"`, `openaiApi: "responses"`, and Bedrock Mantle.
- Mantle and the installed OpenAI SDK expose `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`.
- `@strands-agents/sdk@1.12.0` maps only cached reads; published `1.13.0` has the same omission.
- Darwin currently coerces both optional SDK cache fields to zero, making an absent metric look like a measured zero.

## Requirements

- Track a pnpm patch against the installed `@strands-agents/sdk@1.12.0`; do not upgrade the SDK.
- Map Responses `cached_tokens` and `cache_write_tokens` to the SDK cache usage fields, including explicit zero values.
- Preserve metric availability through Darwin instead of coercing absent cache metrics to zero.
- Use one provider/API-aware usage projection for the TUI and dev REPL.
- Label OpenAI Responses cache reads as `cached input`; report unavailable cache metrics as `not reported` rather than numeric zero.
- Preserve Bedrock and Anthropic numeric `cache read` / `cache write` behavior.
- Preserve existing resumed-session and in-flight-turn usage notices.
- Add focused offline coverage through the real SDK OpenAI Responses adapter using a fake stream.
- Update the SDK contract spec with the provider schema, adapter patch, and absent-versus-zero rule.
- Preserve unrelated files and do not add dependencies.

## Acceptance Criteria

- [ ] OpenAI Responses provider usage maps reported cached-read and cache-write values into cumulative SDK usage.
- [ ] Explicit zero cache values remain reported values rather than becoming unavailable.
- [ ] OpenAI Responses usage uses provider-appropriate labels and never displays a false numeric cache-write zero when the value is absent.
- [ ] Bedrock/Anthropic usage keeps the existing four numeric labels and values.
- [ ] TUI `/usage` and dev REPL consume the same usage projection.
- [ ] Focused offline tests pass without model or network calls.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `git diff --check` passes.

## Out of Scope

- Upgrading `@strands-agents/sdk`.
- Deriving cache metrics from input-token totals.
- Changing prompt-cache placement or billing behavior.
- Adding live model calls to the default test suite.

## Open Questions

None; the approved plan resolves product behavior and scope.
