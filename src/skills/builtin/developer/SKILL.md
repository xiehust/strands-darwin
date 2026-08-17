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

Classify one budget preset from repository evidence before the first launch, state it to the user, and keep it for the whole delegation unless scope materially changes:

| Preset | Use when | Direct worker soft / hard | Correction soft / hard |
|---|---|---:|---:|
| `small` | Localized, known approach, few files and one focused check | 50 / 100 | 15 / 30 |
| `normal` | Default feature or bug spanning several files | 140 / 240 | 40 / 80 |
| `complex` | SDK migration, security boundary, cross-layer protocol, or broad refactor | 240 / 400 | 80 / 120 |

The first number is a **soft target**: tell the child to finish near it, but crossing it is not failure. The second is the CLI **hard ceiling** that refuses the next provider request. At 80% of the hard ceiling, the child must stop unrelated exploration, persist current decisions/progress to task artifacts, run the smallest relevant check, and either finish or leave a precise continuation report. Use the hard value in `--max-model-calls`; never put the soft value there. A user-specified budget overrides the preset.

## 2. Launch the complete child worker

Construct a shell-safe command for the target root and launch it with the `bash` tool in **`start` mode**. Every child invocation must be a managed background task; never run `darwin -p ...` with foreground `execute`. Run the first worker with `--yolo --context-offload --max-model-calls <worker-hard>` from the selected preset. Do not set `DARWIN_PLANNING_ONLY` and do not use `--compact-before` on a fresh child: this one turn owns the complete repository workflow.

The first prompt must give the child the requirement, evidence, repository scope, acceptance criteria, authorized mutation/command scope, selected preset, worker soft target, hard ceiling, and 80% checkpoint. Tell it to proceed autonomously through the repository's own configured workflow: load any relevant non-developer skills, create or maintain task/planning/research artifacts when those skills require them, implement, run focused and final checks, update specs, and commit when authorized. It must not load the `developer` skill, start another darwin, or delegate the supervision task again. Do not make the child wait for Host plan approval; unresolved product, scope, or authorization questions are the only reason to stop and ask.

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

Read the complete worker reply and compare it with the requirement and repository evidence. Answer a child question directly only when existing evidence resolves it. If product intent, scope, or authorization remains unresolved, ask the user in this Host conversation instead of inventing an answer. A worker that stopped only because it reached its hard ceiling may continue in the same session with a correction budget and a precise remaining-work prompt; do not call incomplete work accepted.

## 4. Continue the exact child session only for correction

After independent acceptance finds a concrete failure, launch a correction as another `bash start` task in the same target root with `--session <captured-id> --yolo --context-offload --max-model-calls <correction-hard>` from the selected preset. Never use `--continue` or `--resume`, and never omit the explicit session, yolo, context-offload, or budget flags. Add `--compact-before` only when the prior worker turn was large (for example, it exhausted its budget, crossed its soft target substantially, or left a broad implementation/check transcript); a narrow correction should retain cached continuity without paying for an unnecessary summary. State the exact acceptance failure, correction soft target, hard ceiling, 80% checkpoint, and compaction decision. Tell the child to correct, run affected focused checks, commit the fix when authorized, and report without reopening unrelated work.

Headless children cannot receive interactive permission prompts, so this workflow always runs them in yolo mode. Keep every child command inside the authorized target repository and mutation scope established above; yolo changes confirmation behavior, not task scope.

For each task, retain its new `bg-*` id, monitor with `status`, consume output incrementally with `output`, and inspect failures. A process failure or bad result may be corrected by another explicit `--session <captured-id>` turn when useful.

### Retry transient child server failures

If the drained child output contains a transient provider failure such as `turn failed: The server had an error while processing your request. Sorry about that!`, retry the same requested turn automatically. Use another managed `bash start` invocation with the same target root, prompt, yolo/context-offload flags and worker/correction budget; when a child session id has been captured, include the same explicit `--session <captured-id>`. Preserve the prior turn's compact-before decision unless the retry follows a budget exhaustion, which qualifies as a large turn. If the first worker attempt failed before emitting an exact session record, start a fresh worker attempt and capture its new record instead of guessing an id.

Retry at most two times after the original attempt. Drain and record every retry task normally. Do not retry deterministic failures such as invalid configuration, denied scope, failed tests, or rejected tool input under this rule. If the transient server failure persists after two retries, report it as a blocker rather than looping or implementing in the Host.

## 5. Accept independently

After the child reports completion, independently inspect the repository diff and run the named acceptance checks from the Host. This is the one Host full-gate pass in the verification pyramid; do not duplicate a green child full gate before inspecting the diff. Do not accept the child's prose or its claimed test result as evidence. If acceptance fails, send the exact failure and a focused correction to the same child session through another managed background invocation, then rerun only affected focused checks before the final full gate. Do not patch the implementation yourself merely to conceal the failure.

## 6. Report

Report:

- the child conversation session id;
- every background task id and terminal outcome;
- changed files and independently run acceptance checks/results;
- **token spend**: the captured `usage:` figures per child task, plus an aggregate total across every task in this delegation (state `-` metrics as unknown rather than folding them into a sum, and say when a task reported no line at all); and
- unresolved risks, denied operations, or decisions still needed.

The background registry owns short-lived process lifecycle; the persisted child session owns conversation continuity. Keep those identities separate throughout.
