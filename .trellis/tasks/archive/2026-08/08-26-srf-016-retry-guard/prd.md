# SRF-016 bounded repeated-failure retry guard

## Goal

Stop a model-driven invocation from spending unbounded time and tokens on materially equivalent tool failures while preserving ordinary SDK execution, original tool results, and the user's control over whether to continue in a later turn.

## Requirements

- Count normalized failed outcomes per tool and failure signature within one SDK invocation, including explicit structured nonzero/failed bash outcomes.
- Allow the first three outcomes with one signature; deny a later call to that tool before its body once the three-failure limit is reached.
- After a signature repeats, inject bounded guidance requiring a materially new evidence-backed hypothesis before retrying. After the third failure, tell the model to stop, report the blocker and collected artifacts, and ask the user before continuing.
- Never alter or replace an allowed call's original result. Different signatures and successful calls continue normally; a success clears prior failures for that tool.
- Reset state at every SDK invocation, including when a caller reuses an invocation-state object.
- Bound normalized text, retained signatures, guidance, and denial text; normalize deterministically by Unicode code point.
- Isolate state by Agent as well as invocation so the parent and concurrent children cannot poison each other even though they share the composed intervention.
- Apply through SDK interventions to ordinary model tool calls, including bash. Do not touch user-authored `!` shell commands.
- Preserve plan-guard, PreToolUse, permission, body, and PostToolUse ordering. Unknown-tool and child permission behavior remains unchanged.
- Add the behavioral rule only to `DEFAULT_SYSTEM_PROMPT`; configured inline/file prompt replacement remains exact.

## Acceptance Criteria

- [ ] A network-free real-Agent suite proves three equivalent failures execute and the fourth call is denied before the body despite incidental input changes.
- [ ] The same suite proves all three original error results remain intact and the model receives hypothesis guidance followed by stop/report/ask-user guidance.
- [ ] A different failure signature and a success are not blocked, and a new invocation starts fresh.
- [ ] Shared-intervention parallel Agents are isolated.
- [ ] Adversarial long Unicode failure text yields bounded deterministic state-facing text and denial results.
- [ ] Permission and configured Pre/Post ordering remain unchanged; the blocked call reaches none of them.
- [ ] Default prompt states the rule and custom prompt replacement does not receive an appended rule.
- [ ] Focused suite, `pnpm typecheck`, full `pnpm test`, and `pnpm build` pass without network/model calls.
- [ ] Backend SDK contract, architecture rationale, and AGENTS.md load-bearing index record the new invariant; AGENTS.md remains under 32 KiB.

## Constraints / Out of Scope

- No SDK loop fork, model-call retry, hidden result rewrite, trajectory/output protocol change, dependency, config option, user `!` shell interception, or pinned SDK patch unless the public intervention API proves insufficient.
- The guard is conservative after the threshold: because a future result is unknowable before execution, the same tool is blocked for the rest of that invocation. A new user turn is the explicit continuation path.
