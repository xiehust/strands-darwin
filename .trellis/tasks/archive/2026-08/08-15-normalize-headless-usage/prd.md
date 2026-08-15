# Normalize headless usage buckets

## Goal

Make the machine-readable headless/developer usage record use mutually exclusive token buckets so `input`, `cacheRead`, and `cacheWrite` can be costed independently at different rates for every provider.

## Confirmed facts

- `AgentRuntime.usage` exposes the SDK's provider-native `inputTokens`, `cacheReadInputTokens`, and `cacheWriteInputTokens` counters.
- Bedrock and Anthropic report cache counters beside `inputTokens`, so their current headless `input` is already uncached input.
- OpenAI Responses reports cache counters as subsets of `input_tokens`; the existing TUI `/usage` projection subtracts those subsets, but `formatHeadlessUsage` currently emits the unadjusted total.
- The developer skill parses and sums the four machine-readable fields independently.

## Requirements

- Define the headless `usage:` record's `input` field as uncached input tokens for all supported providers/APIs.
- Preserve the existing field names, order, regex shape, and `-` semantics so developer parsing remains compatible.
- For OpenAI Responses, compute `input = max(0, inputTokens - cacheReadInputTokens - cacheWriteInputTokens)` only when both cache subsets were reported.
- For Bedrock, Anthropic, OpenAI Chat, and other APIs, preserve the current provider-native input value unless their documented accounting requires normalization.
- Do not manufacture cache metrics: an unreported `cacheRead` or `cacheWrite` remains `-`; when an absent OpenAI Responses subset prevents an exact split, normalized `input` also remains `-`.
- Reuse one provider-aware usage projection rather than duplicating cost-bucket arithmetic between TUI and headless paths.
- Document that all four emitted numeric buckets are mutually exclusive and may be independently summed across developer child invocations.

## Acceptance Criteria

- [x] OpenAI Responses headless usage emits uncached `input` while retaining separate cache-read and cache-write values.
- [x] Bedrock/Anthropic behavior remains unchanged and does not subtract cache counters twice.
- [x] Missing cache metrics remain `-` in the machine-readable record.
- [x] The developer regex and per-field aggregation contract remain compatible.
- [x] Focused headless and usage verification cover provider-aware normalization and pass.
- [x] `pnpm typecheck`, `pnpm test`, and `git diff --check` pass.

## Out of scope

- Calculating currency cost or embedding provider price tables.
- Renaming the four machine-readable fields.
- Changing the SDK's raw accumulated usage counters.
- Altering TUI `/usage` semantics beyond refactoring shared projection logic.

## Open questions

None.
