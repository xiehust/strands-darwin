# Implementation plan — self-evolution research skill

## Ordered checklist

1. Generalize required built-in validation for `developer` and `self-evolution-research`.
2. Add the concise built-in workflow with backlog-first, evidence, ranking, persistence, and developer-handoff contracts.
3. Add the backlog index and daily research report template.
4. Extend `spike/verify-skills.ts` for discovery, progressive disclosure, collision handling, workflow text, and docs contracts.
5. Add concise README and backend spec contracts.
6. Run focused skill verification, typecheck, full fast suite, build, and compiled asset inspection.
7. Run Trellis quality review and report ready for independent Host acceptance. Do not append an invented iteration-log record; wait for the Host's exact results in the supplied same child session.

## Validation

```bash
pnpm tsx spike/verify-skills.ts
pnpm typecheck
pnpm test
pnpm build
test -f dist/src/skills/builtin/self-evolution-research/SKILL.md
npm pack --dry-run --json
```

All commands are non-network verification. `npm pack --dry-run` only inspects package contents.

## Review gates

- Backlog is read before any fresh research.
- `进行中` outranks `未开始`; either suppresses fresh research.
- No status outside the exact four-value vocabulary is presented as valid.
- Same-day reports append timestamped run sections rather than overwrite.
- Peer claims require sources and are compared to current Darwin repository evidence.
- No more than five new directions are proposed in one run.
- Exactly one selected direction is handed to the loaded `developer` skill.
- Completion requires independent acceptance; blockers preserve `进行中`.
- Existing build copy suffices and no dependencies are added.

## Risk and rollback

The main risk is instruction drift between the skill and templates. Static assertions cover the load-bearing phrases and schemas. The other risk is hidden cardinality assumptions that only one built-in exists; search and update every such assertion. Rollback is file-local and has no migration.
