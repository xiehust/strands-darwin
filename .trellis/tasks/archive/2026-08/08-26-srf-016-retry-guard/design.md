# Design — SRF-016 repeated-failure retry guard

## Change boundary

The gap lives at the SDK tool-call lifecycle: Darwin currently records no bounded per-invocation memory of failed tool outcomes, so the model may emit unlimited variants after the same service failure. The narrow extension point is the existing composed intervention, not the driver, trajectory observer, permission classifier, tool body, or SDK loop.

Expected source changes:

- `src/agent/retry-guard.ts`: own bounded normalization, per-Agent/per-invocation state, guidance, and threshold decisions.
- `src/hooks/tool-hooks.ts`: compose the guard around the established plan → Pre → permission → body → Post sequence without changing permission precedence.
- `src/agent/runtime.ts`: create one guard with the shared intervention used by parent and children.
- `src/agent/system-prompt.ts`: add only default behavioral guidance.
- `patches/@strands-agents__sdk@1.12.0.patch` and `pnpm-lock.yaml`: expose foreground bash command `exitCode` from the already-pinned persistent-shell implementation so nonzero outcomes are machine-identifiable without parsing prose.
- `spike/verify-retry-guard.ts` plus `spike/run-tests.ts`: focused network-free real-Agent contract.
- Backend spec, architecture rationale, and AGENTS.md: record the new invariant.

Explicitly unchanged: SDK loop, trajectory/replay, headless/TUI protocols, user `!` shell path, permission classification, custom prompt replacement, dependencies, and every pinned-SDK behavior other than adding the foreground command's numeric exit status to its existing result object.

## Runtime design

`RepeatedFailureGuard` is an SDK `InterventionHandler` collaborator composed by `ToolHookGate` (or a renamed general composite). It owns `WeakMap<LocalAgent, AgentState>` so sharing the same intervention with subagents does not share counters. `BeforeInvocationEvent` creates a fresh invocation object and associates the exact `invocationState` object; this prevents stale caller-owned invocation state from carrying counters into a later call.

For an eligible tool call:

1. Existing plan guard runs first.
2. The retry guard checks whether this tool is latched after three equivalent failures. If so, it returns an SDK denial before PreToolUse, permission, or body.
3. Existing PreToolUse and permission run unchanged.
4. Existing PostToolUse observes the unmodified result.
5. The guard observes the same final original result. It never transforms it.
6. Before the next model call, pending bounded guidance is returned with `InterventionActions.guide`, which uses the SDK's ordinary model-input extension point.

`ToolResultBlock.status === 'error'` is a failed outcome. Bash also has structured nonzero/failed status outputs, so the guard recognizes explicit `exitCode !== 0` and `state: failed` (including wait/status wrappers) without treating arbitrary stderr text as failure. Thrown/validation/service bash errors remain ordinary error results.

A success clears the retained failures and latch for that tool. Different signatures can each proceed normally. Once one signature reaches three failures, later calls to that tool are conservatively denied for the invocation because the future result is unknowable before execution; the next user turn resets state.

## Fingerprint and bounds

Failure class is the original error name when present, otherwise `tool-error`. Signature text comes from the error message when present, otherwise textual/JSON content. Normalization:

- Unicode NFKC;
- replace control/format characters with spaces;
- lowercase and collapse whitespace;
- replace volatile UUIDs, long hex tokens, numbers, quoted values, absolute paths, and URLs with stable placeholders;
- retain at most a fixed number of Unicode code points.

Fingerprint key is `tool name + failure class + normalized signature`. State retains at most a small fixed number of signatures per tool and tools per invocation with deterministic oldest-entry eviction. Visible guidance and denial reuse the bounded class/signature projection and fixed prose, so adversarial text cannot grow memory or results unboundedly.

## Guidance

After failure 2, one pending pre-model message says the failure repeated and any retry must first state a materially new evidence-backed hypothesis and identify the evidence distinguishing it from prior attempts. After failure 3, one pending message tells the model the limit is reached: stop retrying, report the blocker and artifacts already collected, and ask the user before continuing. A blocked call receives the same bounded stop/report/ask-user instruction as its error result.

## Prompt semantics

The default prompt states the three-failure rule. `loadSystemPrompt` continues returning configured inline/file text exactly; no runtime append is introduced.
