# Design — Host darwin self-iteration workflow

## Architecture and boundary

Implement the role as a built-in skill, not an in-process agent definition or a new command.

- A **skill** keeps the supervising workflow in the Host's persistent main conversation, can pause for the user's product decisions, and is invokable both autonomously and as `/developer <request>`.
- A **subagent definition** is unsuitable because the current `subagent` tool exposes only the child's final report and offers no user-facing intermediate dialogue.
- A bespoke **command/orchestrator** would duplicate behavior already available through `bash start/status/output`, `/tasks`, and headless `--session`.

Do not fork the SDK agent loop. The feature is composition of existing extension points and tools.

## Built-in skill source and discovery

Add a source-controlled built-in skill asset under `src/skills/builtin/developer/SKILL.md`. Resolve its directory from `import.meta.url` so both source (`tsx`) and compiled (`dist/src/...`) execution find the matching copied asset. TypeScript does not copy Markdown, so the build script must copy the built-in asset into `dist` after `tsc`; no dependency is needed.

Extend skill scanning to merge the built-in definition with project skills:

1. load the built-in developer skill first;
2. scan `<project>/.darwin/skills/*/SKILL.md` as today;
3. reject a case-insensitive project collision with a problem naming the reserved built-in owner;
4. sort the final advertised catalogue by name, preserving existing deterministic behavior.

The resulting `Skill` remains the existing filesystem-backed type, so `load_skill`, slash expansion, resource discovery, prompt injection, command collision handling, and runtime metadata need no parallel implementation.

## Developer workflow contract

The skill is a concise state machine:

1. **Frame** — record target root, exact requirement, acceptance checks, user-owned decisions, and permitted mutation/command scope.
2. **Launch planning turn** — quote the prompt safely, invoke the current darwin executable as `darwin -p ...` through `bash start`, and require a plan/questions-only reply.
3. **Monitor** — retain the background task id, use `status` and incremental `output`, and remind the user that `/tasks` is a local concurrent view. Never fixed-sleep as synchronization.
4. **Recover identity** — parse only `^session: ([a-z0-9_-]+)$` from child stderr. Keep this child session id separate from every `bg-*` task id.
5. **Decide** — compare the plan with the requirement and repository evidence. Answer evidence-resolved questions, ask the user about unresolved product intent, or send an explicit approval/correction.
6. **Continue** — every later child process uses `--session <captured-id>` and is again launched through `bash start`. An authorized implementation turn may use `--yolo`; otherwise existing safe/rule/default-denial behavior remains.
7. **Accept** — after child completion, the Host independently reads the diff and runs the named checks. Failed acceptance returns a focused correction to the same child session; it is not silently patched by the Host.
8. **Report** — include child session, background task outcomes, changed files, verification, and risks.

Each `darwin -p` call is a short-lived background task. The session survives between tasks in project-local snapshots; the background registry supplies process lifecycle, not conversational identity.

## Live verification

Add `spike/verify-developer-live.ts` as an opt-in model-calling acceptance test.

- Create a temporary git repository with a one-file arithmetic defect, a deterministic test, and target-local model config. Do not install a project developer skill.
- Start the real Host TUI with `/developer <request>` so the slash expansion proves the built-in role is available.
- Require the Host to ask the child for a plan before edits, then approve and continue the exact session for implementation.
- While the Host streams, submit `/tasks`; assert a current-run managed task is visible and the Host turn later completes normally.
- Capture the TUI transcript and retained background logs to prove `bash start`, lifecycle/output reads, and a child invocation containing `--session` occurred. Parse the child session line and ensure it recurs.
- Independently read the changed file, run the fixture test, and inspect `git diff`.
- Use anchored waits/deadlines and always kill the pty/remove the fixture in `finally`.

Model phrasing and exact tool order beyond the required state transitions are not assertions.

## Headless tally fix

`verify-headless.ts` currently imports Node's strict `assert`, so all checks bypass `spike/shared.ts` and `report()` sees zero passes. Alias Node assert as `nodeAssert`, import shared `assert` as the counted boolean helper, and wrap each existing contract in counted checks. Async rejection cases use explicit caught booleans. Keep strict assertions only as local comparison machinery if useful, but every contract must increment the shared counter.

## Compatibility, failure, and rollback

- Existing project skills retain their format and filesystem paths.
- Missing project skill directories remain silent because the built-in catalogue is independent.
- A missing/unreadable packaged built-in is a product installation error and should fail startup rather than silently remove a promised core role; project-skill degradation remains unchanged.
- Headless and background cleanup contracts are unchanged: each invocation gets atomic stdout and bounded stderr, and Host shutdown owns every still-running child process group.
- Rollback is localized: remove the built-in asset/discovery merge and docs/live test; no persisted format or migration is introduced.
