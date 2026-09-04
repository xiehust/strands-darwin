# Implementation plan — Codex-compatible portable hooks

## Milestone 1 — Decode and discover the portable dialect

1. Add strict Codex hook types/decoder and regex matcher utilities with explicit limits.
2. Discover project/global `.agents/hooks.json` without reading `.codex/hooks.json` or changing native `hooks/*.json` semantics.
3. Preserve source ordering and expose source-aware runtime metadata/problems.
4. Extend executable-policy path protection to the direct portable files.
5. Add parser/discovery tests covering all eleven event names, match-all forms, invalid regex, unsupported handlers/async, symlinks, coexistence, and duplicate prevention.

## Milestone 2 — Build the bounded command/runtime adapter

1. Extract one bounded command process-group primitive from existing hook runners without changing native behavior.
2. Add timeout, stdout/stderr/input caps, Windows command selection, cancellation, close, and startup-unwind ownership.
3. Implement Codex common/event payload encoders, output decoder, context limits, and unsupported-control diagnostics.
4. Add focused real-process offline tests for execution order, timeout, output bounds, cancellation, and reaping.

## Milestone 3 — Parent/session lifecycle events

1. Wire truthful `SessionStart` sources and staged context without changing system prompt/history.
2. Wire `UserPromptSubmit` before rewind/trajectory/model work; support bounded context and local block while preserving literal durable input and multimodal rules.
3. Wire explicit `PreCompact`/`PostCompact` around TUI/headless manual compaction.
4. Project driver outcomes to observer-only `Stop` and runtime retirement/shutdown to one advisory `SessionEnd`.
5. Wire observer-only Codex `PermissionRequest` at the existing visible-prompt seam while preserving native payloads.
6. Verify clear/resume/rewind distinctions, no duplicate end, direct streaming, trajectory/memory isolation, and structured/headless behavior.

## Milestone 4 — Tool and subagent lifecycle events

1. Integrate portable Pre/Post handlers into the existing composed intervention without weakening plan/retry/permission ordering.
2. Add safe Codex matcher aliases and validated `updatedInput`; reclassify permission against the final input.
3. Keep PostToolUse observation-only while providing a bounded completed-result payload.
4. Wire `SubagentStart` context before the first child invocation and observer-only `SubagentStop` before the bounded result returns.
5. Verify parent/child policy sharing, child privacy, targeted cancellation, unsupported continuation, and unchanged retry guard behavior.

## Milestone 5 — Contracts, docs, and full acceptance

1. Update the backend SDK/error-handling specs, architecture rationale, `AGENTS.md` index, and English/Chinese extension guides with the exact compatibility subset and deliberate differences.
2. Add the focused Codex hook suite to `pnpm test` and update any verification indexes/comments.
3. Run focused suites while editing, then `pnpm typecheck`, `pnpm test`, `git diff --check`, and relevant free PTY scenarios.
4. Perform Trellis check/self-fix, update task acceptance checkboxes, and report any remaining unsupported Codex semantics explicitly.

## Guardrails

- Do not restore or modify the user's existing deletions under `.darwin/hooks/`.
- Do not add dependencies or read global/project `.codex` hook policy.
- Do not add a second model call, trajectory event family, transcript channel, TUI live row, permission bypass, or general turn continuation.
- Do not modify the pinned SDK unless a verified public extension point cannot satisfy an approved requirement; stop and re-plan before any such patch.
