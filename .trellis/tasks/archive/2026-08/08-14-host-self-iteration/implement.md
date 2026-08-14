# Implementation plan — Host darwin self-iteration workflow

## Ordered checklist

1. Extend the skills loader with a built-in skill source and deterministic project-skill merge/collision behavior.
2. Add the `developer` SKILL.md workflow and ensure the build copies built-in Markdown into `dist`.
3. Extend network-free skill verification for no-project discovery, load/slash expansion, packaged path behavior, and built-in collision isolation.
4. Convert `spike/verify-headless.ts` to the shared counted assertion harness without dropping current contracts.
5. Add the opt-in live Host→child acceptance spike with a temporary git fixture, real TUI, `/tasks`, explicit child-session continuation, and independent test/diff checks.
6. Document user invocation and operational boundaries in README.
7. Run focused checks, typecheck, full fast suite, build/package inspection, and the live acceptance scenario.
8. Run Trellis quality review, update backend/frontend specs with the learned contracts, rerun affected checks, then commit and push `main` to `origin`.

## Validation commands

```bash
pnpm tsx spike/verify-skills.ts
pnpm tsx spike/verify-headless.ts
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run --json
AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts
```

The live command may use the active configured inference profile/provider, but must remain opt-in and outside `pnpm test` because it makes real model calls.

## Review gates

- Confirm the built-in works in a target with no `.darwin/skills`.
- Confirm a project cannot shadow `developer` silently.
- Confirm `/developer` remains normal skill expansion, not a new local command or alternate loop.
- Confirm every child continuation is explicit `--session`, not pointer-based `--continue`.
- Confirm all child invocations use managed background mode and no fixed sleep is presented as synchronization.
- Confirm acceptance evidence is independent of the child's final prose.
- Confirm `verify-headless.ts` prints a non-zero total.

## Risk and rollback points

- **Asset packaging:** source execution and compiled installation have different module directories. Verify both build output and pack contents before live acceptance.
- **Live nondeterminism:** assert observable state transitions and artifacts, not exact prose; keep all waits bounded and diagnostics rich.
- **Permission scope:** the fixture is disposable and explicitly authorizes child `--yolo`; documentation must not normalize unrestricted elevation.
- **Exit lifecycle:** Host owns child background process groups. Any live-test change touching shutdown must also rerun the existing background/exit suites.
- No data migration exists; rollback is removal of the loader merge, asset, and documentation/tests.
