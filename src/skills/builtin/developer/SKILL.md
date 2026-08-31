---
name: developer
description: Supervise one complete headless darwin worker and independently accept its result. Use when delegating repository work to a persistent darwin conversation.
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

Model-call budgets are opt-in. Do not add `--max-model-calls` to a child command by default. If the user or Host explicitly sets a cost ceiling, pass that positive integer through unchanged and report it; the generic CLI guard then refuses the next provider request after the ceiling.

## 2. Launch the complete child worker

Construct a shell-safe command for the target root and launch it with the `bash` tool in **`start` mode**. Every child invocation must be a managed background task; never run `darwin -p ...` with foreground `execute`. Run the first worker with `--yolo --context-offload`: offload is already default-on for ordinary runs, and this compatible process-only override deliberately force-enables it even if persistent config opted out. Do not set `DARWIN_PLANNING_ONLY` and do not use `--compact-before` on a fresh child: this one turn owns the complete repository workflow. Add `--max-model-calls <n>` only for an explicit user/Host ceiling.

The first prompt must give the child the requirement, evidence, repository scope, acceptance criteria, and authorized mutation/command scope. Tell it to derive, before implementing, a concise requirement-to-test checklist — each externally observable requirement (exact routes, contracts, flags) paired with the check that proves it — and to verify every entry before reporting completion: an entry no test covers is a gap to close, not a line to drop. Tell it to proceed autonomously through the repository's own configured workflow: load any relevant non-developer skills, create or maintain task/planning/research artifacts when those skills require them, implement, run focused and final checks, update specs, and commit when authorized. It must not load the `developer` skill, start another darwin, or delegate the supervision task again. Do not make the child wait for Host plan approval; unresolved product, scope, or authorization questions are the only reason to stop and ask.

### Tool batching and verification economy

Tell every child turn to batch mutually independent read-only work in one assistant message: file reads, symbol searches, status/output checks, and independent offline checks may run together. Writes, commits, and commands whose inputs depend on an earlier result stay serial. The child must never repeat a file read or a green check merely to reconfirm it.

Use a verification pyramid. While editing, run the smallest reproduction and focused suite, then typecheck. After source settles, the child runs the complete project gate once before commit. A commit with no source change is followed only by commit/diff/status checks, not another full suite. The Host independently runs the complete acceptance gate once. A failed check is fixed and rerun; this rule removes duplicate green runs, not failure diagnosis.


Run the child from the exact target root. Do not substitute the Host's source repository or prepend a `cd` to some other directory. Keep the returned `bg-*` background task id. Tell the user that `/tasks` remains available while this Host turn runs. Monitor completion with `bash status` and incremental `bash output`; do not synchronize with fixed sleeps. For every child task, call `bash output` at least once. After it reaches a terminal state, keep calling `bash output` until `hasMore: false` before reviewing the reply or taking the next step. Status metadata and `outputBytes` are not the child's response.

From the first task's combined output, capture only the exact stderr record matching:

```text
^session: ([a-z0-9_-]+)$
```

That captured value is the **child conversation session id**. It is not the `bg-*` task id. Never use a background id as a session id, and never recover identity from `--continue` or `.darwin/last-session.json`.

From **every** child task's drained output — initial worker, correction, and retry alike — also capture the exact stderr record matching:

```text
^usage: input=(\d+|-) output=(\d+|-) cacheRead=(\d+|-) cacheWrite=(\d+|-)$
```

That is the child process's token spend for that one invocation. The four fields are mutually exclusive cost buckets: `input` excludes every reported cache read and cache write, so aggregate each field independently across tasks and apply its own provider rate. A `-` means the provider never reported that metric; it does not mean zero, so carry it through as unknown rather than adding it in as `0`. Each child process reports only its own run, so the totals never overlap. A task that fails before any model call completes may report zeros or no line at all — record its absence rather than inventing a number.

## 3. Handle child questions or completion

Read the complete worker reply and compare it with the requirement and repository evidence. Answer a child question directly only when existing evidence resolves it. If product intent, scope, or authorization remains unresolved, ask the user in this Host conversation instead of inventing an answer. A worker stopped by an explicit user/Host ceiling may continue in the same session only with renewed authorization and a precise remaining-work prompt; do not call incomplete work accepted.

## 4. Continue the exact child session only for correction

After independent acceptance finds a concrete failure, launch a correction as another `bash start` task in the same target root with `--session <captured-id> --yolo --context-offload`. Never use `--continue` or `--resume`, and never omit the explicit session, yolo, or force-on context-offload flags. Add `--max-model-calls <n>` only when the user or Host explicitly authorized a ceiling. Add `--compact-before` only when the prior worker turn left a broad implementation/check transcript; a narrow correction should retain cached continuity without paying for an unnecessary summary. State the exact acceptance failure, any explicit ceiling, and the compaction decision. Tell the child to correct, run affected focused checks, commit the fix when authorized, and report without reopening unrelated work.

Headless children cannot receive interactive permission prompts, so this workflow always runs them in yolo mode. Keep every child command inside the authorized target repository and mutation scope established above; yolo changes confirmation behavior, not task scope.

For each task, retain its new `bg-*` id, monitor with `status`, consume output incrementally with `output`, and inspect failures. A process failure or bad result may be corrected by another explicit `--session <captured-id>` turn when useful.

### Retry transient child server failures

If the drained child output contains a transient provider failure such as `turn failed: The server had an error while processing your request. Sorry about that!`, retry the same requested turn automatically. Use another managed `bash start` invocation with the same target root, prompt, yolo/context-offload flags and any explicit user/Host ceiling; when a child session id has been captured, include the same explicit `--session <captured-id>`. Preserve the prior turn's compact-before decision; an explicit ceiling exhaustion requires renewed authorization rather than an automatic retry. If the first worker attempt failed before emitting an exact session record, start a fresh worker attempt and capture its new record instead of guessing an id.

Retry at most two times after the original attempt. Drain and record every retry task normally. Do not retry deterministic failures such as invalid configuration, denied scope, failed tests, or rejected tool input under this rule. If the transient server failure persists after two retries, report it as a blocker rather than looping or implementing in the Host.

## 5. Accept independently

After the child reports completion, independently inspect the repository diff and run the named acceptance checks from the Host. This is the one Host full-gate pass in the verification pyramid; do not duplicate a green child full gate before inspecting the diff. Do not accept the child's prose or its claimed test result as evidence. If acceptance fails, send the exact failure and a focused correction to the same child session through another managed background invocation, then rerun only affected focused checks before the final full gate. Do not patch the implementation yourself merely to conceal the failure.

After every accepted requirement iteration in the darwin repository, run `pnpm build` from the repository root before reporting acceptance or launching the next worker. This refreshes the `dist` CLI and copied built-in skills that the next `darwin` process actually loads; typecheck and tests do not replace it. Treat a failed build as an acceptance failure and send the exact failure to the same child session for correction.

## 6. Report

Report:

- the child conversation session id;
- every background task id and terminal outcome;
- changed files and independently run acceptance checks/results;
- **token spend**: the captured `usage:` figures per child task, plus an aggregate total across every task in this delegation (state `-` metrics as unknown rather than folding them into a sum, and say when a task reported no line at all); and
- unresolved risks, denied operations, or decisions still needed.

The background registry owns short-lived process lifecycle; the persisted child session owns conversation continuity. Keep those identities separate throughout.
