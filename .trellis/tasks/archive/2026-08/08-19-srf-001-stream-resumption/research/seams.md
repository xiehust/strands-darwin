# SRF-001 repository research

## Evidence

- Reflection F1 identifies the observed `ModelError: Stream ended without completing a message` and asks for one bounded continuation rather than manual re-prompting.
- `AgentRuntime.send` delegates `agent.stream(input)` through `recordStream`; `recordStream` records failure and rethrows the identical object. This boundary must remain unchanged.
- TUI `runTurn` owns one busy interval, error notice, and SER-027 queue return. Its ordinary `runtime.send` call is the interactive retry seam.
- `runHeadlessProcess` owns common lifecycle, while `runHeadlessTurn` and `runStructuredHeadlessTurn` consume one ordinary turn. Headless protocols require intentional visibility without leaking raw/internal prompt data.
- SDK 1.12.0 exports `ModelError`, `MaxTokensError`, and `ContextWindowOverflowError`; the latter two subclass `ModelError`. Exact message classification is therefore required rather than `instanceof ModelError` alone.
- SDK cancellation ends with `agentResultEvent.stopReason === cancelled`, not a throw.

## Decision

Place classification and at-most-once sequencing in a driver-facing helper under `src/agent/`, not in runtime or trajectory. Drivers supply their existing one-turn consumers. This preserves SDK loop ownership and failed trajectory bytes while sharing policy across TUI and headless paths.
