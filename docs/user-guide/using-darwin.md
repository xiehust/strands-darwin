# Using darwin

**English** · [简体中文](using-darwin.zh-CN.md) · [Guide index](README.md)

## TUI workflow

The startup frame identifies the model, session, cache, effort, permission mode, loaded instructions, extensions, and local help. Assistant Markdown styling is presentation-only: ANSI-stripped output preserves every character and replay/export remain plain-text projections. File-edit diffs come from proposed tool input, not a reread of disk; finished transcript diffs are complete while live permission/tool panels remain bounded.

While a turn runs, the existing `working…`/`thinking…` row shows elapsed time and reported token spend. Unreported usage is omitted, never rendered as zero. `Ctrl+B` toggles compact/expanded tool details without changing the prompt draft.

## Prompt editing and completion

- `/` offers built-ins, skills, and custom commands. The bounded menu windows around the selected row and states omitted rows.
- `@` scans the workspace asynchronously and inserts path text only. It never opens or injects the file; `.git`, `node_modules`, escaping symlinks, and large scans are bounded/excluded.
- `Up`/`Down` first control an open menu; otherwise `Up` can take back the oldest queued message, then recall sent trajectory prompts from this project, or move in a multiline draft.
- Recall contains sent `userInput` records only, newest first, collapses consecutive duplicates, and excludes entries over 4,000 code points. No trajectory means no history, not an error.
- `Escape` closes the current `/` or `@` completion menu without changing the draft or cursor. Editing the query opens completion again. During recall, `Escape` ends the walk but keeps the recalled prompt in the editor.
- `Ctrl+J` or trailing `\` + `Enter` inserts a newline. Multiline paste does not send unexpectedly.

## Queueing while busy

Submitting a normal prompt or `!` command while a turn is busy queues it for the next turn. Entries are visible above the input and drain one at a time through the ordinary submit path after the current turn. They are not injected mid-stream and are recorded only when actually sent.

`Up` from the first draft row takes a queued entry back. Cancel/failure returns the currently draining entry unsent; pending permission holds the queue. `/clear` drops queued work. `/clear`, `/compact`, `/model`, `/exit`, and `/quit` refuse while busy rather than being queued.

A turn that fails with the exact retryable `ModelError: Stream ended without completing a message` gets at most one visible successor continuation. The failed turn remains recorded; retry happens through ordinary orchestration, never inside the SDK loop.

## User shell commands

A prompt beginning with `!` runs one user-authorized `bash -c` process group, in every permission mode including `plan`:

```text
!git status --short
!pnpm test
```

This bypasses the model permission gate because you typed the command; it does not use the runtime's persistent shell. Output streams in the tool panel and is reduced to one bounded report for transcript, a `shellCommand` trajectory record, and context prepended to the next model prompt. It is never a `userInput`, so recall does not offer it. Timeout/cancel/shutdown use TERM then KILL on the whole group. Replay uses the same report reducer.

## Headless text mode

`-p`/`--print` runs one turn without TUI or stdin:

```bash
darwin -p "reply with ok" >reply.txt 2>progress.log
darwin -p "continue that work" --continue
darwin -p "continue this exact conversation" --session session-20260814-160833123
```

On success stdout is only the complete reply plus one newline. Tool progress and denials are bounded stderr lines. Every started run emits a stable session line:

```text
session: session-20260814-160833123
```

The session ID uses lowercase letters, numbers, hyphens, or underscores and must name an existing snapshot for strict selection. `--continue` follows the last-session pointer and is headless-only; with no pointer it starts fresh.

Headless mode cannot prompt. Static-safe calls and persisted allow rules run; any call reaching the default bridge is immediately denied. Use `--permission-mode auto`, `--permission-mode yolo`, or `--yolo` only when those semantics fit the automation. A denial is not necessarily process failure if the model handles it. Success requires the turn, snapshot, resume pointer, and strict cleanup to succeed. SIGINT is cancellation and exits nonzero.

Bounded automation flags, valid only with `-p/--print`:

```bash
darwin -p "run the complete task"
darwin -p "force offload on despite config opt-out" --context-offload
darwin -p "bounded task" --max-model-calls 200
darwin -p "continue" --session <id> --compact-before
```

`--max-model-calls` refuses the next provider request after the positive ceiling. Oversized-result offload is already default-on; `--context-offload` is a compatible process-only force-on override for a persistent `contextOffload: false` opt-out. `--compact-before` summarizes restored history first and does not start the requested turn if that summary cannot be persisted.

## Structured output

```bash
darwin -p "reply with ok" --output-format json
darwin -p "inspect the project" --output-format stream-json
```

`json` emits one versioned result document, including failure/cancellation. `stream-json` emits one JSON object per physical line for session/run/turn lifecycle, completed assistant messages, permission denials, tool start/completion, diagnostics, and one terminal `result`.

Every valid record has `schemaVersion: 1`, monotonic process `sequence` from 1, ISO `timestamp`, and resolved/requested `sessionId` (or `null` only before startup resolution). Structured stderr is empty after valid parsing; CLI usage errors still use stderr and exit 2.

Terminal `outcome` is `success`, `failure`, or `cancelled`. Success is written only after runtime shutdown and pointer persistence. `errors` contains turn/cleanup/persistence errors in order; observer/SDK degradations are `warnings`. Usage has mutually exclusive `input`, `output`, `cacheRead`, and `cacheWrite`; missing means unreported and measured zero stays `0`.

V1 streams completed post-redaction assistant text, not token deltas. It is an allowlisted projection: no reasoning text/signatures, guardrail-redacted content, raw tool inputs/results, traces, metrics, or live invocation objects. Bounded fields say when truncated; long assistant messages split into numbered records, while a successful terminal result remains complete. `SIGKILL` and broken stdout (`EPIPE`) cannot guarantee the terminal record. `--output-format` may appear once, only with print mode; it adds no daemon, server, SDK API, or checkpoint mechanism.

## Background bash jobs

The model-facing `bash` tool has these modes:

| Mode | Inputs | Behavior |
|---|---|---|
| `execute` | `command`, optional `timeout` | serialized persistent foreground shell |
| `restart` | — | recycle foreground shell |
| `start` | `command` | session-owned process group; returns task ID/PID/log |
| `list` | — | all current-runtime tasks in launch order |
| `status` | `taskId` | command, state, timing, exit, log, byte count |
| `output` | `taskId` | next complete UTF-8 chunk from shared cursor, at most 64 KiB plus final-character bytes |
| `wait` | `taskId`, `waitMs`, optional `wakeOnOutput` | wait 1–30,000 ms by default; terminal-focused waits allow up to 300,000 ms |
| `stop` | `taskId` | TERM→KILL whole process group |

States are `running`, `succeeded`, `failed`, `stopped`. `wakeOnOutput: false` aggregates terminal-focused incremental output until terminal state, cancellation, shutdown, or timeout; omitted/true wakes on output. If a terminal-focused timeout is still running, its result tells the model to wait again before ending when later work depends on completion, because background completion does not resume the agent. All readers share the cursor; no wait automatically continues the turn.

`/tasks` is local, works while streaming, and makes no model call. Repeated successful polls stay compact; explicit output and failures remain visible. Combined stdout/stderr logs are retained at `~/.darwin/sessions/<project-key>/<session-id>/background/<task-id>.log` and are never pruned automatically.

Task IDs/cursors are process-only. Resume keeps logs but cannot regain control of old jobs. Main/child agents share the registry. Shutdown reaps every registered process group; `SIGKILL` or machine failure cannot guarantee cleanup. `start` follows bash permissions/rules; lifecycle inspection, `stop`, and `restart` are safe.
