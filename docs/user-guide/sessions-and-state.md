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

`/trajectory` locally reports this run's file, record/byte counts, truncation, and problems. `/export <path>` writes `formatReplay(replayRead(...))` exactly, refuses an existing file and targets under `~/.darwin/sessions/`, and reports trajectory absence as nothing to export. `/copy` puts the last completed answer's text — the same plain text the export contains — on the clipboard via OSC 52, without touching the trajectory.

## Usage and spend

A `turnEnded.spend` record stamps provider/model and separately reports `input`, `output`, `cacheRead`, `cacheWrite`. Unreported is absent and prints `-` or `(+N unreported)` in totals; it is never zero. Recorded `0` is a measured zero. Sessions that switched model split totals rather than mixing price lists; older records say unknown.

```text
turn 3 spend: input=412 output=1350 cacheRead=130961 cacheWrite=398 · bedrock/global.anthropic.claude-opus-5
session spend: input=412 output=1350 cacheRead=130961(+1 unreported) cacheWrite=398(+1 unreported) over 2 turn(s)
session cost: ≥ $0.0415 (cacheRead partly reported, cacheWrite partly reported; base rates, LiteLLM)
```

`trajectory list` and `trajectory replay` also price the record, offline, from the same `~/.darwin/model-prices.json` the live session fills — each model at its own cached rates. `list` appends one `cost: …` clause per session row; `replay` prints `session cost:` under `session spend:` and, when more than one model contributed, each model's own figure after its token row. A model the cache does not know is *unpriced*: the total becomes a floor that names it (`≥ $3.1250 (2 models; no price for us.made-up.model; …)`), never 0 and never dropped; a bucket only some turns reported is priced over the reported part and marked `partly reported`; turns without a recorded spend make the total a floor too (`N turn(s) unknown`). Without a cache file the clause reads `cost: unknown (price unavailable)`. Reading a record never fetches or writes a price, and `/export` carries no cost lines at all — a transcript file depends on the record alone.

This is SDK-meter attribution, not an invoice. Summarization calls (`/compact` and overflow handling) bypass the meter and are absent from `/usage` and trajectory spend. Turn ordinals restart per process, so resumed records may contain multiple `turn 1` entries; totals count actual closing records.

### Cost

`/status` and `/usage` price this run's buckets at LiteLLM base rates, **each model at its own** — `cost  ≈ $0.0123 (base rates, LiteLLM)` — and a headless run writes the same figures as one stderr record after `usage:`:

```text
usage: input=412 output=1350 cacheRead=130961 cacheWrite=398
cost: total=0.0415 input=0.0008 output=0.0135 cacheRead=0.0262 cacheWrite=0.0010 model=global.anthropic.claude-sonnet-5 pricing=global.anthropic.claude-sonnet-5
```

It is an estimate: base tier only (no long-context or 1-hour-cache rates), and summarization calls excluded because the meter excludes them. After a `/model` switch each model's tokens are priced at that model's rates: the row counts the models (`≈ $4.6250 (2 models; base rates, LiteLLM)`), `/usage` adds one line per model under it, and a model in the mix without a price makes the figure a floor that names it (`≥ $3.1250 (2 models; no price for <id>; …)`). Headless then writes `model=2-models pricing=mixed`. An unreported bucket is never priced as 0 — the TUI shows a floor (`≥ $0.0030 (cacheRead not reported, cacheWrite not reported; …)`) and headless writes `-` for that bucket *and* for `total`. `pricing=` names the LiteLLM key the rates came from, or `none` (LiteLLM lists no such model) / `unavailable` (the table has not been fetched — offline, or the background download has not finished yet). Subagents run the parent's live model and are priced at its rates.

Rates come from `~/.darwin/model-prices.json`, which stores only the resolved mapping per model id (never the whole table): a model the file already knows is never fetched again; an unknown id triggers one background fetch per process at startup or on `/model`, and an id LiteLLM does not list is recorded as unpriced so it is not retried on every launch. Delete the file to refresh prices. `DARWIN_MODEL_PRICES_FETCH=off` disables the download entirely.

## Project memory

Memory is default-on when trajectory is available and stored outside the tree:

```text
~/.darwin/projects/<project-key>/memory/
├── state.json       # strict versioned authority
└── index.md         # optional human-readable projection
```

The parent agent decides when to call `memory_recall` and `memory_save`; subagents receive neither tool. Recall performs bounded local lexical ranking over currently validated entries and returns explicitly fallible data, not instructions or policy. It makes no network, vector, embedding, or hidden model call, and the full archive is never injected into every prompt.

Save is an ordinary permission-gated write. Project facts require one exact current project-relative source line; explicit preferences and non-secret account identity require one exact quote from the current user input. A save is staged and becomes durable only after that same turn closes as a successfully recorded `endTurn`. Failure, cancellation, partial output, recorder degradation, or `/clear` before durable acceptance discards it. Generated facts expire under `memoryHorizonDays` (default 28; `0` disables age only) and are revalidated on recall.

Manage and audit it locally:

```text
/memory
/memory show <id|number>
/memory remember <note>
/memory forget <id|number|all>
```

`remember` atomically rejects likely secrets, prompt-boundary markup, dumps, and oversized notes. `forget` suppresses generated IDs so an exact forgotten fact cannot be restored. Unreadable, forged, wrong-project, or symlink-escaped stores are refused; validation/commit failures only warn. Memory never rewrites trajectory, snapshot, pointer, config, or repository files.

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
