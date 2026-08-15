# Design

## Data flow

`Responses usage payload → patched Strands Responses adapter → SDK Meter.accumulatedUsage → AgentRuntime raw usage → shared provider/API-aware projection → TUI and dev REPL`

## SDK boundary

Use pnpm's tracked patch mechanism for `@strands-agents/sdk@1.12.0`. The adapter will copy both non-negative numeric fields from `input_tokens_details` into `Usage`. Presence, not truthiness, determines availability so an explicit zero survives.

The patch is intentionally local because published `1.13.0` contains the same omission. No agent-loop fork or parallel response parser is introduced.

## Darwin usage contract

`UsageTotals` preserves the SDK's optional cache fields. A pure shared projection combines totals with the active `AppConfig` and produces ordered rows whose values are either a number or unavailable.

- Bedrock and Anthropic: `input`, `cache read`, `cache write`, `output`; cache fields normalize to numeric zero to preserve current behavior.
- OpenAI Responses: `input`, `cached input`, `cache write`, `output`; reported cache fields remain numeric, while absent fields render `not reported`.
- Other OpenAI API modes: cache fields remain unavailable unless a verified mapping exists.

Both interactive renderers consume this projection. Formatting remains local to each surface, while provider semantics and availability have one owner.

## Compatibility

Bedrock and Anthropic retain current labels and numeric output. Existing resumed and in-flight notices are unchanged. The SDK patch changes only OpenAI Responses usage metadata.

## Testing

A focused offline suite supplies a fake OpenAI client whose Responses stream emits terminal events with usage details. It exercises the actual `OpenAIModel` adapter and Agent meter, then separately verifies provider-specific projections and formatted TUI output.

## Rollback

Remove the pnpm patch and projection changes together. Do not leave the UI claiming support for a metric the adapter no longer forwards.
