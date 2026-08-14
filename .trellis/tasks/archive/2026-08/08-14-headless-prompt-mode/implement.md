# Headless prompt mode implementation plan

## Ordered checklist

1. Refactor CLI argument parsing into a pure validated parser covering prompt, session selector,
   permission mode, aliases, precedence, duplicates, and unknown flags.
2. Extend session resolution/runtime options to accept explicit session ids while preserving
   existing fresh/resume behavior and correct `RuntimeInfo` restoration reporting.
3. Add the headless one-turn driver: immediate-deny permission bridge, assembled final-answer
   capture, concise bounded stderr tool records, pointer update, and no Ink construction.
4. Wire headless orchestration, SIGINT cancellation, cleanup, exit codes, and expected error
   reporting into `src/cli.ts` without changing the interactive path.
5. Add deterministic no-network verification for parser, output separation, permission denial,
   session selection/restore, failure paths, and bounded process exit. Add the suite to `pnpm test`.
6. Run focused verification, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the relevant free TUI
   scenario. Run a live headless smoke/multiturn test only if the configured provider credentials
   are available; report any live-test limitation plainly.
7. Update README plus backend SDK/error specs with the final CLI, session, stdout/stderr, exit-code,
   and shutdown contracts.
8. Run Trellis quality check, inspect the final diff/status, commit using project conventions,
   archive/record the task as appropriate, and push the current branch to its configured remote.

## Risky files and rollback points

- `src/cli.ts`: preserve the existing pre-Ink `ConfigError` boundary and forced-exit ordering.
- `src/agent/session.ts` and `src/agent/runtime.ts`: do not change SDK agent id, storage layout, or
  pointer timing; explicit ids must not break TUI `--resume`.
- New headless driver: never write assistant/tool content to the wrong file descriptor and never
  infer process failure from one tool result alone.
- Process handling: cleanup remains explicit and awaited before the forced-exit timer is armed.

## Validation commands

```bash
pnpm tsx spike/verify-headless.ts
pnpm typecheck
pnpm test
pnpm build
pnpm tsx spike/verify-tui.ts model
AWS_REGION=us-west-2 pnpm tsx spike/verify-headless-live.ts   # if credentials/config allow
```

## Follow-up checks before start

- Planning artifacts contain no unresolved product decisions.
- `implement.jsonl` and `check.jsonl` include the SDK contracts and error-handling specs.
- User explicitly approves the latest planning summary before `task.py start`.
