# SRF-001 — bounded stream interruption resumption

## Goal

Recover one original user turn from the narrowly evidenced SDK `ModelError` "Stream ended without completing a message" by running one distinct, visible continuation turn through Darwin's ordinary turn orchestration. Keep the SDK loop untouched and preserve the failed turn as an append-only trajectory entry.

## Requirements

- Recognize only the SDK `ModelError` stream-interruption signature; exclude authentication, authorization, validation, context overflow, max-token, cancellation, arbitrary model, tool, and application failures.
- Attempt at most one continuation for an original user turn. A qualifying failure from that continuation surfaces normally.
- Use a bounded internal prompt which tells the model to inspect retained conversation/work, continue from the interruption, and not repeat completed work or replay the original request.
- Keep each attempt an independent `AgentRuntime.send` turn so trajectory recording, usage, permissions, cancellation, and SDK semantics remain ordinary.
- Surface the failed first attempt and automatic continuation in the TUI and all headless protocols without exposing the internal continuation prompt.
- Preserve SER-027 ownership: queued user work remains queued through a continuation and is returned unsent on cancellation or final failure.
- Keep runtime stream errors identical; do not retry in `AgentRuntime.send`, `recordStream`, or an SDK-loop fork.

## Acceptance Criteria

- [x] A deterministic real SDK `Agent`/scripted-model test records a failed turn followed by exactly one distinct successful continuation turn.
- [x] A second qualifying failure is not continued again.
- [x] Generic `ModelError`, auth/validation-like errors, `MaxTokensError`, `ContextWindowOverflowError`, cancellation, and non-model errors are not continued.
- [x] The original thrown object and failed trajectory remain intact; the continuation prompt is bounded, internal, and anti-repeat.
- [x] TUI orchestration keeps queue/cancel/failure ownership coherent.
- [x] Legacy text, JSON, and stream-JSON headless behavior is valid, visible, bounded, and does not emit the continuation prompt.
- [x] Focused checks, `pnpm typecheck`, one complete `pnpm test`, `git diff --check`, and Trellis validation pass.
- [x] The executable contract is documented in backend/frontend specs, architecture rationale, and the AGENTS.md load-bearing index.

## Lifecycle

`docs/research/backlog_index.md` remains `in-progress`; independent Host acceptance owns the transition to `done`.
