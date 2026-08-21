# Implementation plan — `.agents` extension layers

## Ordered work

1. Add `.agents` path/source helpers in `src/paths.ts`, including containment-aware executable-hook policy paths shared by permission classification and rule exemption.
2. Generalize skill discovery to the four ordered user/project layers while preserving built-in reservations and valid-before-claim behavior.
3. Update skill resource safety for root and nested symlinks: real-root containment, bounded traversal, broken/cyclic/escape failures, and use-time rechecks through the official SDK sandbox seam.
4. Generalize agent and command discovery to the same layers and accept direct symlinked regular files without adding recursive discovery or a second parser.
5. Replace single-primary hook loading with sorted directory aggregation for all four layers, preserving `.darwin` legacy fallback only when its directory has no JSON files. Validate only active hook inputs, fail closed with exact source paths, merge in the accepted Pre/Post wrapper order, and carry active sources plus legacy-shadow notices into runtime metadata.
6. Render bounded hook shadow notices through the existing TUI header and dev REPL startup surfaces; update comments/types that still describe `.darwin` as the only source.
7. Update README, load-bearing architecture notes, backend contracts/error matrix, frontend command-discovery contract, and AGENTS path/security index where the accepted behavior changes an invariant.
8. Add/extend offline fixtures for all four layers, precedence, invalid-higher fallback, symlink success/failure/escape/bounds, hook lexical/layer order, invalid hook refusal, legacy fallback/shadowing, startup notice, permission danger/rule exemption, and missing directories.

## Validation pyramid

While editing:

- `pnpm tsx spike/verify-state-layers.ts`
- `pnpm tsx spike/verify-skills.ts`
- `pnpm tsx spike/verify-custom-commands.ts`
- `pnpm tsx spike/verify-subagents.ts`
- `pnpm tsx spike/verify-tool-hooks.ts`
- focused permission-rule/mode suite selected by the changed shared path policy
- focused visual-language/startup rendering suite
- `pnpm typecheck`

After source settles:

- `pnpm test`
- `pnpm tsx spike/verify-tui.ts completion` (free; proves custom commands/skills remain visible)
- `pnpm build`
- compare/call the compiled CLI as appropriate to prove built-in assets and runtime output are fresh
- `python3 ./.trellis/scripts/task.py validate 08-21-agents-directory-extensions`
- `git diff --check`

## Risk and rollback points

- Keep resource traversal changes isolated in `src/skills/resource-safety.ts`; an escape or TOCTOU regression blocks acceptance.
- Keep hook discovery/merge pure and separately testable before wiring it to `AgentRuntime`; executable-policy ambiguity blocks startup rather than degrading.
- Do not remove legacy hook fallback until directory aggregation tests pass; directory presence must be the only switch.
- Do not alter `Agent` construction, child transcript isolation, command expansion, or official skills activation paths.
- If completion sources change in count/order, update only the existing completion budget/fixtures required to keep every built-in visible.
