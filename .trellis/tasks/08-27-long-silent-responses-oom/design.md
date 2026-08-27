# Design: bound memory during silent OpenAI Responses requests

## Investigation boundary

Trace one ordinary `AgentRuntime.send()` call from the TUI driver through Strands `Agent`, its OpenAI Responses model adapter and the `openai` stream object while no provider event arrives. In parallel, isolate each local periodic source (Ink frame tick, usage display, trajectory recorder, diagnostics, SDK telemetry/local traces) and identify allocations that remain reachable for the request lifetime.

The production symptom requires a time-dependent retained allocation: the initial request is large but stable, and no stream event exists to feed ordinary response accumulation. The reproduction will therefore hold a provider request silent while accelerating or observing the same periodic callback path and sampling memory after forced GC where available. Controls will disable or isolate adjacent subsystems so correlation is not mistaken for causation.

## Fix boundary

Apply the smallest correction at the owner of the retained allocation. Darwin must continue consuming `AgentRuntime.send()` directly and the Strands agent loop must remain untouched. If ownership lies in `@strands-agents/sdk`, amend `patches/@strands-agents__sdk@1.12.0.patch` and installed package output consistently with the repository's existing patch workflow.

The fix must release or reuse request-lifetime state rather than masking growth with a larger heap or timeout. Cleanup must cover normal completion, provider failure, and cancellation. It may not buffer stream events, change trajectory records, suppress TUI state, or alter context-offload content.

## Verification design

Add a standalone offline spike that uses no network and exercises the real leaking implementation with controlled scheduling. Run it in a child Node process with an intentionally constrained heap and/or forced-GC samples. Assert both that a leak-shaped control is detectable and that the production implementation remains below a conservative bound for substantially more synthetic ticks than the incident required.

Retain focused functional checks around any touched subsystem, then run TypeScript typecheck and the repository's complete offline test command.

## Compatibility and rollback

No config or user-visible protocol changes are planned. The patch can be rolled back by removing only the targeted dependency/source change and its regression harness/spec clause. Existing session data remains untouched.
