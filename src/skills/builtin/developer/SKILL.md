---
name: developer
description: Supervise a headless darwin child through planning, implementation, and independent acceptance. Use when delegating repository work to another persistent darwin conversation.
---

# Developer supervisor

Act as the supervising developer in this Host conversation. Delegate implementation to a headless darwin child; do not replace the SDK loop or hide a child failure by editing the implementation yourself.

## 1. Frame the delegation

Before launching anything, establish from the request and repository evidence:

- the absolute target repository root;
- the exact requirement and independently observable acceptance checks;
- decisions the user has already made versus product decisions only the user can make; and
- the authorized mutation and command scope.

Ask the user when any of these boundaries is unresolved. Never infer authorization merely because a command is convenient.

## 2. Launch a planning-only child turn

Construct a shell-safe command for the target root and launch it with the `bash` tool in **`start` mode**. Every child invocation must be a managed background task; never run `darwin -p ...` with foreground `execute`. Run every child invocation with `--yolo`; the built-in developer workflow uses yolo mode by default so headless children never block on interactive permission prompts. Prefix the planning process with `DARWIN_PLANNING_ONLY=1` so repository hooks can enforce read-only behavior when provided. The first prompt must give the child the requirement, evidence, repository scope, and acceptance criteria, and explicitly request a plan and questions only with no edits or implementation. Tell the child it is the direct implementation worker: it must not load the `developer` skill, start another darwin, or delegate the task again.

Run the child from the exact target root. Do not substitute the Host's source repository or prepend a `cd` to some other directory. Keep the returned `bg-*` background task id. Tell the user that `/tasks` remains available while this Host turn runs. Monitor completion with `bash status` and incremental `bash output`; do not synchronize with fixed sleeps. For every child task, call `bash output` at least once. After it reaches a terminal state, keep calling `bash output` until `hasMore: false` before reviewing the reply or taking the next step. Status metadata and `outputBytes` are not the child's response.

From the first task's combined output, capture only the exact stderr record matching:

```text
^session: ([a-z0-9_-]+)$
```

That captured value is the **child conversation session id**. It is not the `bg-*` task id. Never use a background id as a session id, and never recover identity from `--continue` or `.darwin/last-session.json`.

## 3. Review the plan and decide

Read the complete planning reply and compare it with the requirement and repository evidence.

- Answer child questions only when the user's requirement or inspected repository evidence resolves them.
- If product intent, scope, or authorization remains unresolved, ask the user in this Host conversation instead of inventing an answer.
- Approve only a conforming plan. Otherwise send focused corrections.

## 4. Continue the exact child session

Launch every follow-up as another `bash start` task, in the same target root, with explicit `--session <captured-id> --yolo` arguments. Never use `--continue` or `--resume`, and never omit `--session` or `--yolo` on an implementation/correction turn. The follow-up prompt must state the approval/correction, tell the child to proceed without asking for another approval, and name the requested next work.

Headless children cannot receive interactive permission prompts, so this workflow always runs them in yolo mode. Keep every child command inside the authorized target repository and mutation scope established above; yolo changes confirmation behavior, not task scope.

For each task, retain its new `bg-*` id, monitor with `status`, consume output incrementally with `output`, and inspect failures. A process failure or bad result may be corrected by another explicit `--session <captured-id>` turn when useful.

## 5. Accept independently

After the child reports completion, independently inspect the repository diff and run the named acceptance checks from the Host. Do not accept the child's prose or its claimed test result as evidence. If acceptance fails, send the exact failure and a focused correction to the same child session through another managed background invocation. Do not patch the implementation yourself merely to conceal the failure.

## 6. Report

Report:

- the child conversation session id;
- every background task id and terminal outcome;
- changed files and independently run acceptance checks/results; and
- unresolved risks, denied operations, or decisions still needed.

The background registry owns short-lived process lifecycle; the persisted child session owns conversation continuity. Keep those identities separate throughout.
