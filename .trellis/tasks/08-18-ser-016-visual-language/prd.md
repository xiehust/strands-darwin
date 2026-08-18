# SER-016 cohesive TUI visual language

## Goal

Apply one cohesive, scan-friendly Darwin visual language across the existing Ink TUI without changing its interaction, SDK-loop, or live-frame architecture.

## Requirements

- Centralize semantic visual roles used by `App`, `MessageList`, `InputBox`, `PermissionPrompt`, and `ToolCallPanel`; do not add a dependency or configurable theme.
- Make the header compact and status-first, with stronger identity/state hierarchy and capability summaries instead of long inventories. Preserve every required observable state, keep `mode:` exactly once, keep cache/effort on the model line, and use no more baseline rendered rows than before.
- Give user, assistant, tool, and notice transcript entries textually distinct markers that remain distinguishable after ANSI stripping.
- Make the multiline composer visibly active and completion/path selection stronger without changing cursor geometry or key ownership.
- Polish the permission modal while preserving exact risk kind/reason, source, bounded detail, queue state, allow-rule offers, and reachable `y`/`n`/`esc` decisions.
- Preserve the shared visual-row frame budget, `Static` answer streaming and `AnswerPart` margins, permission ownership, and no-queue busy submit.
- Refresh the README opening transcript and record the executable visual contract in frontend specs.
- Maintain the existing SER-016 research/backlog bookkeeping; final acceptance status remains for the supervising Host.

## Acceptance Criteria

- [x] Deterministic rendering checks pin the composed semantic hierarchy, including ANSI-stripped distinctions.
- [x] Header rendering compactly summarizes capabilities and consumes no more baseline rows than the previous header.
- [x] Existing frame-budget checks stay bounded and no redrawn frame reaches terminal height.
- [x] Free real-pty `completion`, `pathCompletion`, `recall`, `cursor`, `multiline`, `mode`, `plan`, `clear`, and `tallDraft` scenarios pass.
- [x] Real-model 120x50 `approve` retains the complete permission modal.
- [x] `pnpm typecheck`, `pnpm test`, Trellis validation, and `git diff --check` pass.
- [x] README, frontend spec, and task artifacts describe the accepted appearance and constraints.
- [ ] Authorized changes are committed with a clean worktree.
