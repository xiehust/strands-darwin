# Host darwin self-iteration workflow

## Goal

Let a Host darwin act as the supervising developer for another darwin process: delegate a repository change, continue the child's persisted headless conversation through planning and implementation, monitor it without blocking the Host session, and independently accept or reject the result. This closes the self-iteration loop without adding a second agent loop.

## Background

- The repository already provides session-owned background `bash` modes (`start`, `list`, `status`, `output`, `stop`) and a local `/tasks` view for the user.
- Headless darwin already supports `darwin -p <message>` plus strict continuation with `--session <id>`. Its stdout is the final reply and stderr publishes `session: <id>` plus bounded progress.
- Skills run in the main Host conversation and can therefore preserve user interaction. In-process subagents return only a final report and cannot support the required plan/question/approval dialogue.
- Project skills currently come only from `<target>/.darwin/skills`; a project-authored sample would not make an installed darwin capable in an arbitrary target repository.

## Requirements

### R1 — Built-in developer role

- Ship a built-in `developer` skill that is available even when the target repository has no `.darwin/skills/` directory.
- Keep the role in the Host's main conversation rather than a transient in-process subagent.
- Preserve progressive disclosure: advertise only name and description until `load_skill` or `/developer` loads the full workflow.
- A project skill must not silently replace the built-in name; collisions are skipped and surfaced through the existing skill-problem channel.

### R2 — Child darwin orchestration workflow

The skill must teach the Host to:

1. confirm the delegated requirement, acceptance evidence, target repository, and authorization boundary;
2. launch each `darwin -p ...` child invocation with background `bash start`, never a blocking foreground call;
3. capture the exact `session: <id>` record from the first child invocation and use `--session <id>` for every follow-up;
4. monitor with `bash status` and incremental `bash output`, while telling the user that `/tasks` remains available during the turn;
5. review the child's plan, answer only questions resolved by the user's requirement/repository evidence, approve a conforming plan, and escalate unresolved product decisions to the user rather than inventing them;
6. inspect failures and continue the same child session with corrections when useful;
7. independently inspect the diff and run acceptance checks before declaring success; and
8. report child session id, task outcomes, acceptance evidence, and unresolved risks.

- The Host must remain the supervisor: it does not edit the implementation itself merely to hide a child failure.
- The workflow must explain that headless children cannot receive interactive permission prompts. An elevated child permission mode may be used only inside the user-authorized repository/scope; otherwise pre-existing safe calls and allow-rules apply and denied work is reported.
- It must not rely on `--continue`, `.darwin/last-session.json`, fixed sleeps, or parsing a background task id as a conversation id.

### R3 — Live self-iteration acceptance

- Add an opt-in live spike in which a real Host darwin runs in a temporary git repository with no project developer skill.
- The Host must load the built-in developer workflow, start a headless child darwin as a managed background task, observe a planning-only first reply, continue that exact session with approval, and supervise a small code fix.
- During the live Host turn, the driver must exercise `/tasks` and observe the managed job without interrupting the turn.
- Acceptance must independently prove the child changed the intended file, the repository test passes, the Host used background lifecycle/output operations, and explicit `--session` continuation occurred.
- The spike must use bounded waits and clean up its temporary repository/processes.

### R4 — Headless spike tally regression

- Connect `spike/verify-headless.ts` assertions to `spike/shared.ts`'s PASS/FAIL counter so a successful standalone run reports a non-zero passed count.
- Preserve the existing network-free contract coverage and non-zero process status on any failed assertion.

### R5 — Documentation and compatibility

- Document how to invoke `/developer`, how the Host/child session and background-task ids differ, how `/tasks` participates, and the permission/acceptance boundaries.
- Keep the existing SDK `AgentRuntime.send()` loop, headless output contract, background process ownership, project skill behavior, and interactive commands compatible.
- Add no dependency.

## Acceptance Criteria

- [x] AC1: In a repository with no `.darwin/skills/`, runtime skill discovery advertises `developer`, `load_skill` can load it, and `/developer` expands it; an attempted project collision is isolated and reported.
- [x] AC2: The developer instructions cover the complete requirement → background launch → output monitoring → question/plan response → same-session continuation → independent acceptance loop, including authority and permission boundaries.
- [x] AC3: `pnpm tsx spike/verify-headless.ts` prints a non-zero PASS total and exits zero; a failed counted check would make the shared report exit non-zero.
- [x] AC4: `pnpm typecheck` and the full network-free `pnpm test` suite pass.
- [x] AC5: The live developer-workflow spike proves a Host darwin used managed background tasks and `/tasks` to drive a headless child through at least two explicit turns in one session, and the independently executed repository test passes afterward.
- [x] AC6: README and the relevant backend/frontend specs record the built-in skill, child-session orchestration, `/tasks` visibility, and required live verification.

## Out of Scope

- A new scheduler, IPC protocol, child-process API, task persistence across Host restarts, parallel child swarms, or automatic merge/release management.
- Replacing the existing `subagent` tool or SDK agent loop.
- Letting a Host answer genuinely unresolved product questions without the user.
- Making `/tasks` an agent tool or allowing the model to invoke the local slash command itself.
- Guaranteeing deterministic model wording; acceptance is based on observable tools, files, session continuation, and tests.
