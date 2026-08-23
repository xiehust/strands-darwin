# Sessions and state

**English** · [简体中文](sessions-and-state.zh-CN.md) · [Guide index](README.md)

## Snapshot storage and resume

Every turn snapshots the conversation under `~/.darwin/sessions/<project-key>/`; `last-session.json` points to the latest completed choice for bare resume. State is scoped to the canonical repository, so sessions from another working tree are not candidates.

```bash
darwin sessions
darwin --resume <id>
darwin --session <id>
```

`darwin sessions` is read-only, offline, and lists only restorable snapshots, newest activity first: ID, age, first recorded user prompt, and `(last)`. If trajectory was disabled it says `(not recorded)`; damaged/unusable entries are skipped with a count. Listing never writes or moves the pointer. Invalid/other-project IDs are refusals, never fallback. A named resumed session becomes the bare-resume target only after it completes another turn.

TUI resume shows a bounded read-only recap of the last completed user request/assistant answer from the exact trajectory before the prompt. Missing, disabled, damaged, or omitted history is stated. It creates no model message, model call, mutation, or pointer movement. Fresh/headless runs are unchanged.

`/clear` creates a successor runtime through the same factory. It inherits live permission mode, retires the predecessor, rebuilds session-scoped state, and does not move on-disk pointers until the new session completes a turn. Changing the runtime `AGENT_ID` orphans snapshots because it participates in their path.

## Append-only trajectory

When enabled (default), each turn appends JSONL at:

```text
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

Records include run model/mode, user input durably before invocation, assistant blocks, tool calls with bounded inputs/results, shell-command records, and `turnEnded` with stop/failure/cancel outcome, duration, spend, and omitted-event counts. Failures preserve error class/message and wrapped provider class. Child-agent transcripts/events are excluded.

Bounds: strings 8,000 code points, one record 64 KiB, one file 64 MiB. Every truncation is explicit. Reasoning is presence-only, never text. Existing bytes are never rewritten; interrupted files keep a valid prefix and readers report a partial last line. Recorder failure degrades open with one notice. Set `trajectory: false` to record nothing.

The initial `userInput` append has a bounded fail-open durability barrier before model invocation; a timeout/write failure does not replace the provider call or error.

## Offline trajectory commands

```bash
darwin trajectory list
darwin trajectory search "npm install"
darwin trajectory search "flaky test" --session <id>
darwin trajectory replay <id>
darwin trajectory replay <id> --turn 3 --json
darwin trajectory fork <id>
```

These make no model call, network request, or tool execution. `replay` reconstructs user prompts, assistant replies, tool statuses/result previews, failures, and spend; it does not recreate token timing, reasoning, capped bytes, or terminal colours. Reading a recorded failed turn succeeds (exit 0). Search no-hit in a readable record prints `no matches` and exits 0; no trajectory for that session exits 1.

`fork` copies snapshot, offloaded files, and trajectory prefix to a new ID while leaving source bytes and resume pointer unchanged:

```bash
NEW=$(darwin trajectory fork session-20260816-101112)
darwin --session "$NEW"
darwin -p "carry on" --session "$NEW"
```

`/trajectory` locally reports this run's file, record/byte counts, truncation, and problems. `/export <path>` writes `formatReplay(replayRead(...))` exactly, refuses an existing file and targets under `~/.darwin/sessions/`, and reports trajectory absence as nothing to export.

## Usage and spend

A `turnEnded.spend` record stamps provider/model and separately reports `input`, `output`, `cacheRead`, `cacheWrite`. Unreported is absent and prints `-` or `(+N unreported)` in totals; it is never zero. Recorded `0` is a measured zero. Sessions that switched model split totals rather than mixing price lists; older records say unknown.

```text
turn 3 spend: input=412 output=1350 cacheRead=130961 cacheWrite=398 · bedrock/global.anthropic.claude-opus-5
session spend: input=412 output=1350 cacheRead=130961(+1 unreported) cacheWrite=398(+1 unreported) over 2 turn(s)
```

This is SDK-meter attribution, not an invoice. Summarization calls (`/compact` and overflow handling) bypass the meter and are absent from `/usage` and trajectory spend. Turn ordinals restart per process, so resumed records may contain multiple `turn 1` entries; totals count actual closing records.

## Project memory

Memory is default-on when trajectory is available and stored outside the tree:

```text
~/.darwin/projects/<project-key>/memory/
├── state.json
├── index.md
└── topics/
```

After a successful substantive turn is visible and durable, a delayed coalesced offline rebuild considers only closed successful turns. Failed/cancelled/active/short/damaged/truncated turns are skipped. Extraction uses no model, reasoning, raw tool payload, vector index, watcher, or network. It drops likely credentials, `.env` material, code/log dumps, and instruction-like text, and records provenance.

Generated facts enter prompts only when exact bounded project-relative line/hash anchors still match and age is inside `memoryHorizonDays` (default 28; exact boundary expired). `0` disables age expiry only. Validation runs at startup, resume, `/clear`, and immediately before requests. States `invalid`, `unknown`, and `expired` stay auditable but are omitted. User notes do not auto-expire and are not presented as verified code facts.

At most one bounded `<learned-memory>` index enters after project instructions/skills and before working context/cache. It is labelled fallible context, never policy; topic bodies are not injected. Manage it locally:

```text
/memory
/memory show <id|number>
/memory remember <note>
/memory forget <id|number|all>
```

`remember` atomically rejects likely secrets, prompt-boundary markup, dumps, and oversized notes. `forget` refreshes live prompt state and suppresses generated IDs so rebuild cannot resurrect them. Unreadable, forged, wrong-project, or symlink-escaped stores are refused; extraction/validation failures only warn. Memory never rewrites trajectory, snapshot, pointer, config, or repository files.

## Diagnostics

Set `{ "diagnostics": true }` to append SDK `debug`/`info`/`warn`/`error` and darwin notices to:

```text
~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log
```

It is off by default because provider payloads may quote conversation content. With the field absent, nothing is formatted and no file exists. The log is made for `tail -f` and can reveal throttling, cache-point placement, token-count fallback, and MCP renaming.

Bounds: 8,000 code points per line, 8 MiB per session, 1 MiB pending writes. Reaching the file bound writes one terminal line; a firehose drops and counts diagnostic lines rather than stream events or agent progress. Write failure warns once. Logs are retained until you delete the session. SDK warnings appear twice (SDK source and darwin notice), and process-global SDK logging includes subagent diagnostics even though trajectory excludes child events.

## Other stored state

```text
~/.darwin/config.json                                  global model/session config
~/.darwin/sessions/<project-key>/                      snapshots, trajectories, diagnostics, jobs, offload
~/.darwin/projects/<project-key>/permission-rules.json project allow rules
~/.darwin/projects/<project-key>/memory/                learned project memory
```

Offloaded results and background logs intentionally persist so resumed references remain valid. There is no session garbage collector; remove finished session directories yourself. Legacy project-side rules/sessions may be read as migration sources and copied to user state on first write/resume; repository files stay untouched.
