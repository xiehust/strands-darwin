# Implementation plan — `/workflow` built-in command

Ordered checklist. Validation commands at each gate.

1. [x] `src/commands/workflow-command.ts`: `parseWorkflowCommand`, `WORKFLOW_COMMAND_USAGE`,
       template naming the `workflow` tool + reads-parallel/writes-serialized rule +
       verbatim task embed.
2. [x] `src/commands/custom-commands.ts`: add `workflow` to `BUILTIN_COMMAND_NAMES` (after
       `usage`) + description entry.
3. [x] `src/tui/InputBox.tsx`: `MAX_COMPLETIONS` 19 → 20 (update its comment if it states
       the count).
4. [x] `src/agent/runtime.ts`: `ExpandedSlashCommand` gains `{ kind: 'workflow'; message }`;
       `expandSlashCommand` consults `parseWorkflowCommand` first; `'missing-task'` → null.
5. [x] `src/tui/App.tsx`: bare-`/workflow` local usage notice before the expansion block;
       expansion-notice ternary handles the new kind.
6. [x] `src/dev-repl.ts`: bare-`/workflow` usage notice next to its expansion call.
7. [x] `spike/verify-workflow-command.ts` + register in `spike/run-tests.ts`.
8. [x] Gate: `pnpm typecheck` && `pnpm test`.
9. [x] Gate: `pnpm tsx spike/verify-tui.ts completion` (free, no model).
10. [x] Spec touch-up: AGENTS.md workflow row unchanged? Add the command to any spec that
        enumerates built-ins (check `.trellis/spec/frontend/prompt-completion.md`, help spec
        mentions). Keep AGENTS.md under 32 KiB.
11. [x] `pnpm build` (dist refresh), commit via commit-message skill.

Rollback: single commit; revert it.
