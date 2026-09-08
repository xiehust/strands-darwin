# Command and keyboard reference

**English** · [简体中文](reference.zh-CN.md) · [Guide index](README.md)

## CLI

```bash
darwin                                      # fresh TUI
darwin --resume                             # last project session
darwin --resume <id>                        # named session
darwin --session <id>                       # named session, including a fork
darwin sessions                             # restorable snapshots
darwin doctor                               # offline read-only diagnostics, exit 1 on problems
darwin -p "prompt"                          # one-shot text
darwin -p "prompt" --continue               # follow last pointer
darwin -p "prompt" --output-format json
darwin -p "prompt" --output-format stream-json
darwin trajectory list
darwin trajectory search "text" [--session <id>]
darwin trajectory replay <id> [--turn N] [--json]
darwin trajectory fork <id>
darwin --help                               # usage grammar, exit 0
darwin --version                            # darwin <version>, exit 0
```

`darwin --help` (or `-h`) prints the grammar below to stdout and exits 0; `darwin --version` (or `-V`) prints `darwin <version>` from `package.json` (the package is `strands-darwin`; the printed name is the command's). Both are answered locally before any argument parsing, runtime, config or model work — no file is written — and either flag anywhere in argv wins over everything else (help before version). One check precedes even these: if the installed `@strands-agents/sdk` lacks darwin's pinned patch (an install that skipped `postinstall`/`patch-package`, e.g. `npm install --ignore-scripts` or the unsupported `pnpm add -g`), every invocation prints one five-line refusal on stderr naming `npm install -g strands-darwin` as the fix and exits 1 (`spike/verify-npm-patch-format.ts`, `spike/verify-npm-package.ts`). The block is quoted from `CLI_USAGE` in `src/cli-usage.ts` and pinned by `spike/verify-cli-args.ts`:

```text
Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
       darwin -p <message> [--output-format text|json|stream-json]
         [--continue|--resume [<id>]|--session <id>] [permission flags]
         [--max-model-calls <n>] [--context-offload] [--compact-before]
       darwin sessions
       darwin doctor
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
With -p, piped (non-TTY) stdin is read to EOF and appended to <message> as one delimited block (256 KiB cap).
```

Print-only options: `--context-offload` (process-only force-on; offload is default-on), positive `--max-model-calls <n>`, `--compact-before`, `--output-format text|json|stream-json`. Permission overrides: `--permission-mode default|auto|plan|yolo`, `--yolo`. One leading standalone `--` is ignored for package-manager forwarding. Unknown/invalid grammar exits 2 with `error: <message>` on stderr followed by one hint line, `Run \`darwin --help\` for usage.`

### `darwin doctor`

An offline, read-only diagnostics report composed from the same loaders a session would run at startup: `~/.darwin/config.json` (provider, model, region or base URL, whether the named API-key variable is set — never its value — effort, prompt cache, context offload, trajectory / memory / diagnostics, permission mode), the system-prompt source, the project-instructions file (`AGENTS.md`, or the `CLAUDE.md` fallback) and its size against the 32 KiB preload cap, the MCP config files in effect (which is read, which is ignored) and every configured server — a stdio `command` is looked up on `PATH`, an `http`/`sse` server is named as `not connected (doctor never connects)` — the skills catalogue per layer with every skipped entry and its reason, hook files with their dialect (native or Codex adapter), the permission-rules file, the sessions store and versions. A loader that would refuse to start the TUI (`ConfigError`) becomes one problem line here instead: problem lines start with `! `, are totalled at the end, and set the exit code — 0 when none, 1 when at least one. `doctor` starts no session, calls no model, spawns or connects to no MCP server, uses no network, and creates or moves nothing anywhere (not even `~/.darwin`); it takes no arguments (anything after the verb exits 2 with the usage error). Pinned by `spike/verify-doctor-command.ts`.

### Piped stdin with `-p`

`git diff | darwin -p "review this change"` sends both. When `-p` runs with a stdin that is not a terminal, darwin reads it to EOF and appends it to the message as exactly one delimited block — the message first, then a blank line, then:

```text
--- piped stdin (<N> bytes) ---
<the piped text, verbatim>
--- end of piped stdin ---
```

`<N>` is the raw byte count; a newline is added before the footer only when the text does not already end with one. That composed text is the one user input: it is what the model receives, what the session trajectory's `userInput` line records (under its existing 8,000-code-point field cap) and what `darwin trajectory replay` shows. The `json` / `stream-json` envelopes gain no field — they never echoed the prompt.

Rules and limits:

- A terminal stdin, `/dev/null`, an immediate EOF or whitespace-only input add nothing — the run is byte-identical to one without a pipe, and nothing is printed about it. The interactive TUI never reads stdin this way.
- Cap: **256 KiB** (262,144 bytes). Larger input is refused before any session or model work, as a usage error (`error: piped standard input exceeds the 262144-byte cap for -p; …`, then the `--help` hint, exit 2). Darwin never truncates the block silently; pipe less (`head -c`, a filter) or name the file in the message instead.
- Input must be UTF-8 text without NUL bytes; binary input is refused the same way. Bytes are never sent as base64.
- Caveat, as for `cat`: a parent that holds the pipe open without writing makes `-p` wait for EOF. Redirect from `/dev/null` (or spawn with `stdio: 'ignore'`, as the developer skill's background `bash start` jobs already do) when no input is intended.

## Slash commands and bundled skill entry points

`/` completion lists all of these with project skills and commands.

| Command | Behavior |
|---|---|
| `/agents` | bounded dispatch list for this run; metadata only |
| `/clear` | new successor session; live mode inherited; queue dropped |
| `/compact [focus]` | summarize older conversation; user controlled. Optional focus text (≤400 code points after trimming, longer is refused with a notice and nothing runs) is appended to the SDK's default summarizer prompt as one fixed section the summary must keep; without it the summarizer request is unchanged |
| `/context` | known/estimated context size (Bedrock may use heuristic), then a breakdown estimated over the current request shape: system prompt by section (base, project instructions, skills catalogue, working context), tools by origin (darwin built-ins, each MCP server), conversation by role — `~N tokens · P%` per row when the window is known; a failed count reads `not reported`; counted only when you run the command |
| `/copy` | last *completed* answer's transcript text to the clipboard: OSC 52 to the terminal first (works over SSH), then `wl-copy`/`xclip`/`pbcopy` only when a display is present; one notice states bytes copied (`N of M` when over the cap) and any tool failure; rejects arguments |
| `/effort [level]` | show or set persisted model effort; a warm-cache notice precedes a level change |
| `/exit`, `/quit` | quit |
| `/export <path>` | exact replay projection; no overwrite/session-internal target |
| `/help` | bounded local commands, syntax, and keys; rejects arguments |
| `/init [focus]` | one ordinary prompt asking the model to inspect the repository and create `AGENTS.md` (or improve the loaded `AGENTS.md` in place; a loaded `CLAUDE.md` is carried into a new `AGENTS.md` and left untouched) under the 32 KiB cap, written through the ordinary file editor; bare form is the trigger, a focus is appended verbatim |
| `/mcp` | read-only server states/tools/config paths; no reconnect |
| `/memory`, `/memory list` | entries with origin, provenance, validation/expiry reason |
| `/memory show <id|number>` | inspect one bounded entry |
| `/memory remember <note>` | screened user-authored project note |
| `/memory forget <id/number/all>` | remove/suppress entries and refresh live prompt |
| `/mode [mode]` | show/set user-only live permission mode; not persisted |
| `/model [name]` | list/switch configured models, conversation intact; a warm-cache notice precedes a switch |
| `/permissions` | live allow rules and origins, then configured deny rules |
| `/permissions revoke <n/rule/all>` | synchronously narrow live/disk allow rules; deny rules are never revoked here |
| `/rewind` | chooser over this session's completed prompt checkpoints; accepting branches the conversation into a fresh successor session restored to the state before the selected prompt, which returns to the editor unsent; files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned memory are never rolled back |
| `/status` | consolidated read-only model/cache/effort/mode/MCP/skills/hooks/shell env/spend/cost/context report; the model row names the last cache miss's likely cause once one was observed; a `tangent` row appears only while a tangent is armed or active |
| `/tangent`, `/tangent start`, `/tangent end` | one-level bookmark over the rewind path: bare `/tangent` arms it and the next completed prompt starts it (its checkpoint is the return point); `/tangent` again or `/tangent end` returns there through the same successor path as `/rewind` — same omission notice, plus `returned from tangent — N prompt(s) discarded` — with no draft handed back; `/tangent start` while active is refused (no nesting, no picker: use `/rewind`); `/clear` or an accepted `/rewind` ends it with `tangent ended by …`; live TUI state only |
| `/tasks` | background jobs with their last three non-empty output lines, including while busy; reading them never moves the model's `output`/`wait` cursor |
| `/trajectory` | this run's local record status |
| `/usage` | process token buckets plus an approximate USD cost; unreported is not zero; counts cache misses and names the last one's likely cause once one was observed |
| `/workflow <task>` | ask the model to orchestrate the task as one `workflow` DAG call; bare form prints usage |
| `/skill-name [request]` | explicitly load/send a skill |
| `/developer <requirement>` | supervise a complete persistent headless worker |
| `/self-evolution-research` | bundled skill: backlog/research/scored supervised iteration loop |
| `/self-reflection [session id]` | bundled skill: trajectory-based review feeding qualified backlog items |

`/help`, `/mcp`, `/permissions`, `/status`, `/tasks`, `/trajectory`, `/usage`, memory management, and other report commands use local state and do not send their report to the model unless their documented mutation changes live prompt state. `/clear`, `/compact`, `/model`, `/rewind`, `/tangent`, `/exit`, and `/quit` refuse while busy; ordinary inputs queue.

## Prompt syntax

| Syntax | Behavior |
|---|---|
| `/prefix` | built-in/custom/skill completion |
| `@path` | workspace path completion; inserts text, never content |
| `!command` | user-authorized one-shot local shell command |
| normal text | model prompt; queues while busy |

## Keyboard

| Key | Behavior |
|---|---|
| `Enter` | accept selected completion, otherwise send/queue |
| `Ctrl+J`, trailing `\` + `Enter` | newline; multiline paste keeps all lines |
| `Tab` | accept selected completion |
| `Up` / `Down` | menu first; then queue take-back, recall, or multiline cursor |
| `Escape` | close current completion menu or end recall; preserve draft/cursor (permission prompt still denies) |
| `Esc` `Esc` | on an empty idle composer (no draft, turn, `!` command, queue or prompt), a second `Esc` within 500 ms opens the `/rewind` chooser — same behavior as typing `/rewind`; one `Esc` there does nothing |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | visible-row start/end |
| `Ctrl+K` / `Ctrl+U` | delete to row end/start |
| `Ctrl+W` | delete previous word |
| `Alt`/`Ctrl` + `Left` / `Right`, `Alt+B` / `Alt+F` | move by word |
| `Alt+Backspace` / `Alt+D` | delete the word before/after the cursor |
| `Ctrl+_` (or `Ctrl+-`) | undo the last `Ctrl+K`/`Ctrl+U`, `Ctrl+W` or `Alt` word deletion in the draft |
| `y` / `n` / `Esc` | answer permission prompt; Esc denies |
| `a` / `A` | permission prompt narrow/tool-wide always-allow option |
| `Ctrl+B` | compact/expanded tool details |
| `Ctrl+C` | cancel busy work; press again within 2s to quit; idle quits |
| `Ctrl+D` | quit |

Permission and compaction views own keyboard/paste while active. The completion menu owns arrows before recall/cursor. Prompt queue take-back wins before recall.

## Report contracts

- `/status` reads existing accessors only, mutates nothing, displays unknown metrics as `not reported`, and bounds name lists with `… N more`. Its `hooks` row lists the active hook source files in policy order (project-relative inside the project, `~` under home; `none` when nothing is armed) and appends `· N shadowed` when legacy hook inputs were shadowed at startup. Its `shell env` row states what model-spawned shells did not inherit — `nothing withheld`, or `N credential-shaped variables withheld (NAME, … N more)` — and appends `· passthrough: A, B_* … N more` only when `shellEnv.passthrough` is configured; names, never values. When N > 0 the TUI also prints one `shell env: … — see /status` transcript line at startup (text-mode `-p`: one `shell-env:` stderr line; structured `--output-format json` carries no counterpart).
- The `cost` row of `/status` and `/usage` is Σ token bucket × LiteLLM base rate, **each model at its own rates** (after `/model` the row counts the models — `≈ … (2 models; …)` — and `/usage` adds one line per model), always labelled `≈ … (base rates, LiteLLM)`; an unreported bucket turns it into a floor (`≥ $x.xxxx (cacheWrite not reported; …)`), never 0, and so does a model in the mix without a price (`≥ … (2 models; no price for <id>; …)`); `unknown (no price for <model>)` / `unknown (price unavailable)` say why there is no figure. Reading it never fetches or writes. `trajectory list` appends the same clause as `cost: …` to each session row and `trajectory replay` prints `session cost:` plus a per-model figure, priced offline from the same file — never a fetch, never a write; `/export` carries no cost lines. Rates live in `~/.darwin/model-prices.json`, filled once per model id from LiteLLM's public price table in the background at startup (and on `/model` to a new id); `DARWIN_MODEL_PRICES_FETCH=off` in the environment keeps darwin off the network and prices only what the file already knows.
- `/help` is one bounded transcript notice, works before busy queueing, and performs no model/tool/network/config/session work.
- `/mcp` never probes or reconnects; tool names come from already registered state.
- `/context` and warning estimates are advisory. A known threshold crossing emits one post-turn `/compact` recommendation, rearmed only after a known drop; unknown estimates are silent.
- Prompt-cache misses are advisory too, and Claude-only (OpenAI caches at the provider with no darwin cache points, so nothing is derived there). A completed model call that reads less than 20% of its request from the cache after a call that did read is a miss, and darwin names one likely cause from what it already knows: `model switched`, `effort changed` (only when the level actually sent changed), `compacted` (only when `/compact` really shortened the history), `idle past cache TTL (5m|1h)`, `first request of a resumed session`, else `unknown` — in that precedence. Once a miss was observed this session, `/usage` adds `cache misses  N` to its top block and `last miss  <cause>` to the last-turn block, and `/status` appends ` · last miss: <cause>` to the model row; with none observed both reports are byte-identical to before. `/rewind`, file edits, permission-mode changes and skill loads are not invalidators and are never blamed. Unreported counters, a fresh session's expected-cold first call and caching off are silent. Before `/model <target>` or `/effort <level>` changes what is sent while the cache is warm (the last call read from it less than the TTL ago), one notice states the cost and the switch proceeds: `cache is warm (<age> ago, <N> tokens read last call): switching model|effort re-reads the conversation uncached`. No confirmation, no automatic compaction, no new live row; nothing is recorded or persisted.
- `/compact` is never automatic. Overflow summarization may still be invoked by SDK conversation management, using `summaryRatio` and `preserveRecentMessages`.
- The busy rows (`working…` hint and `thinking…`) carry a model-retry wait as one appended phrase, ` · throttled, retry 3/6 in 12s` — `3/6` is the attempt about to be made, seconds left are rounded up and floored at `0s`, the provider's reason is never on the row, and no row is added; without a wait the rows are byte-identical. A subagent's own wait is the live-row/heartbeat phase `waiting on model, retry 3/6`. A turn that fails at the retry cap reads `turn failed after N attempts: <message>`; one cancelled inside a wait reads `cancelled during retry wait (attempt N/M): <message>`. Headless parity: text mode writes `model throttled, retry 3/6 in 12s — <reason>` (stderr, once per wait) and, on failure, one `notice: <heading>` line before the unchanged `error:` line; `stream-json` emits one additive `model.retrying` event per wait (`attempt`, `maxAttempts`, `waitMs`, `reason` ≤ 240 code points) and `subagent.progress` may carry `phase: "waiting-on-model"` with `attempt`/`maxAttempts`, or `phase: "continuing-after-stream-interruption"` while a child's one continuation after an interrupted stream runs (text mode: `continuing after stream interruption`); the terminal record's turn-stage `errors[]` entry gains an optional `retry` object (`{ kind: "exhausted", attempts }` or `{ kind: "cancelled", attempt, maxAttempts }`) — `name`/`message`/`cause` stay the provider's. Trajectory records, `/export` and replay are unchanged.
- `/export` is byte-for-byte the same formatter as offline replay.
- Record type `permissionDecision` (fields `toolUseId`, `toolName`, `kind`, `risk`, `mode`, `source`, `outcome`, optional `rule`, `promptedUser`; never the tool input) is written inside the turn for every tool call the permission gate settled, just ahead of the call's `beforeToolCallEvent` and with its `toolUseId`. `outcome` is one of `write-scope-denied`, `deny-rule`, `plan-denied`, `yolo`, `safe`, `allow-rule`, `classifier`, `user-approved`, `user-denied`, `restart-limit-denied`; `source` is `parent` or a child's `<agent>#<dispatchId>`. `trajectory replay` / `/export` print one `permission · <tool> · …` note only when `promptedUser` is true or the outcome is a denial; `yolo`/`safe`/`allow-rule`/`classifier` print nothing. `trajectory search` matches the tool name, outcome and rule; `trajectory list` is unchanged. Log-only: no model, tool-result, TUI or headless output changes, and no config key.
- `/copy` copies the same plain answer text the transcript shows and `/export` writes; while a turn runs it copies the previous completed answer, and before any answer (or right after `/clear`/`/rewind`) it says `nothing to copy`. It makes no model call and records nothing. Over SSH the OSC 52 sequence needs a terminal that accepts clipboard writes (and tmux `set-clipboard on`).
- The terminal window/tab title (`terminalTitle`, default `true`) reads `darwin · <project basename> · <state>` with state `idle`/`working`/`waiting for approval`, plus ` · N queued` while prompts wait (the permission prompt outranks a running turn, which outranks idle; the queue count rides beside whichever holds) — one OSC 2 sequence (`ESC ] 2 ; <title> BEL`) straight to stdout, only when stdout is a TTY and only when the composed title changes (a transition, never a tick), capped at 80 code points with control characters stripped from the project name; every exit path (`/exit`, `/quit`, Ctrl+C, Ctrl+D) restores the bare project name once, `/clear` keeps the same project and just continues; `-p` never writes one.
- The terminal-mediated attention notification (`terminalNotify`, default `false`) asks the terminal for a desktop toast at exactly the bell's two moments — a permission prompt being published (`darwin · <project basename> · waiting for approval`) and a turn completing, any outcome (`darwin · <project basename> · turn complete`) — as one OSC 9 sequence (`ESC ] 9 ; <text> ESC \`, ST-terminated, never BEL) straight to stdout, only when stdout is a TTY. Control characters and `;` are stripped from the project name and the text is capped at 120 code points. iTerm2 (with "Send escape sequence-generated alerts" enabled), kitty, Ghostty, WezTerm and foot show it; other terminals consume it silently. Inside tmux (`TMUX` set) it is wrapped in the `ESC P tmux ; … ESC \` passthrough and needs `allow-passthrough on`. It works over SSH because it travels in the byte stream; `-p`, child agents and lifecycle hooks never write one, and off performs no write at all.

## Sensitive-path reads

A read is never silent when its target resolves into the fixed sensitive set: anything under
`~/.ssh/`, `~/.aws/`, `~/.gnupg/`; `~/.netrc`, `~/.kube/config`, `~/.docker/config.json`,
`/etc/shadow`; any `.env` / `.env.*` basename; darwin's own config, hook and permission-rule files.
Targets are the `path` of `fileEditor view` and every non-option argument of `cat`, `head`, `tail`,
`grep`, `rg`, `find`, `ls` and `wc` (`~`, `$HOME`, `${HOME}`, relative and `..` forms resolved). The
prompt reads `reads a sensitive path: <path>`; it is asked in `default`, `auto` (the classifier is
never consulted for it) and — for `fileEditor view` — `plan`, denied in headless, and no allow-rule
covers it or is offered. For `grep` and `rg` only, a search started from an ancestor of a credential
location (`~`, `/home/<user>`, `/`, `/etc`, `~/.kube`, `~/.docker`) counts too and reads
`reads a sensitive path: <arg> (searches above <location>)`; `.env*` is outside that ancestor rule.
Every other read stays statically safe. Pinned by `spike/verify-permission-modes.ts`.

## File edits

`fileEditor str_replace` requires `old_str` to occur exactly once; a repeated match is refused with
the line numbers. Pass `replace_all: true` to replace every non-overlapping occurrence in one write —
the result names the count and the (pre-edit) line numbers and shows one snippet around the first
replacement. The permission box and the finished row still show the one `old_str`→`new_str` pair,
with a `Replace all: every occurrence` / `replace_all: every occurrence` row stating the scope (from
the input, never from the file). Other commands ignore the flag.

## Web access tools (parent agent only)

Both are ordinary gated tools: they prompt in `default`, are denied in `plan`, and may be covered by
allow-rules or forbidden by deny-rules. Subagents and workflow nodes never receive them.

| Tool | What comes back |
|---|---|
| `http_request` | the SDK tool: any method, headers and body; the raw response body, unbounded |
| `web_fetch` | GET only, `Accept` prefers markdown; `http://` upgraded to `https://`; same-host redirects followed, cross-host redirects reported instead; HTML converted to readable text (a **lossy** projection — scripts, styles, navigation, layout and attributes dropped), markdown/plain text kept verbatim, binary bodies refused with type and length; body capped at 40 000 code points (`maxChars` may lower it) with `[truncated: N of M code points]` stated; download stops at 4 MiB |

## Background delegation (parent agent only)

The Strands SDK's `backgroundTasks` plugin adds an optional `_background_execution` flag to `subagent`
and `workflow` only; every other tool stays foreground. A flagged call is gated exactly like a
foreground one and returns an acknowledgement with a task id. Where the report lands depends on the
runtime: in the interactive TUI (with `backgroundTaskWake` on) the dispatching turn ends after the ack,
the child keeps running while you prompt, and the report arrives in the next turn that runs — the
SDK attaches it as a `strands_background_task_result` tool-use/tool-result pair before that turn's
model call, and when the session is idle a **delegation wake** (below) starts that turn; in headless
mode and with `backgroundTaskWake: false` the SDK waits inside the invocation and the report is
delivered before the parent's next model call in the same turn. Children never see the flag or the tool
below. While a background delegation is tracked, `/clear` and `/rewind` refuse with one notice naming
the task and the two exits (`/agents cancel <id>`, or wait for the completion wake); `/exit` still
cancels the children.

| Tool | Gating |
|---|---|
| `strands_manage_background_task` | `mode: list` / `get` are reads; `mode: cancel` is a fail-closed `execute` (prompts in `default`, denied in `plan`); `/agents cancel <id>` is the user-only path |

## Background-task wake (interactive TUI, parent agent only)

When a `bash start` job reaches a terminal state (`succeeded`, `failed`, `stopped`), the transcript
shows the completion notice as before and — with `backgroundTaskWake` on (the default) — one wake
entry joins the prompt queue. It drains like any queued prompt (at idle, one ordinary turn through
`submit()`: hooks, permission gate, trajectory barrier and `TurnComplete` all fire) and hands the
model one bounded block:

```
<task-notification task="bg-…" state="succeeded" exitCode="0" signal="" elapsed="12s">
A background bash job you started with `bash start` finished successfully. …
command: …
output tail (last N line(s); `bash output` with taskId "bg-…" reads the full log from your cursor):
…
</task-notification>
```

A settled background delegation uses the same entry kind, tagged `[delegation <id8> state]`, with the
delegation label (`subagent general#…: <task>`) where a job's command sits and a block that names the
tool, task id, state and elapsed time and points at the `strands_background_task_result` pair the SDK
attaches to the same request — the report itself is never repeated:

```
<task-notification task="<uuid>" tool="subagent" state="succeeded" elapsed="1m 2s">
A background subagent delegation you dispatched with _background_execution: true finished. …
delegation: subagent general#…: <task>
Its report is in this turn's strands_background_task_result tool result for task "<uuid>" — read it there; it is not repeated here.
…
</task-notification>
```

- Exactly one wake per job, from the terminal snapshot only — never from output activity, never
  re-fired at a turn end. A job whose terminal state the model already received through a
  `bash wait`/`status`/`stop`/`list` result in a *completed* turn produces no wake.
- Busy sessions hold it in the queue like a prompt (next turn only, never mid-stream); a wake queued
  while a permission prompt is open is sent after the prompt resolves and the turn ends.
- The queue row reads `queued · [task bg-xxxxxxxx succeeded] <command>`, and the busy hint counts
  wakes as ` · N task wake(s)` apart from ` · N queued`. `Up` take-back and a cancel's return move
  only typed entries into the editor; wakes stay queued. A wake whose own turn was cancelled or
  failed is not re-sent (one `not delivered` notice names the job). `/clear` drops pending wakes.
- Record type `taskNotification` (fields `taskId`, `command`, `state`, `exitCode`, `signal`, `text`;
  a delegation wake adds `source: "delegation"`, carries the delegation label as `command` and `null`
  exit metadata) opens the wake's turn in `trajectory.jsonl` in place of a `userInput` line, so prompt
  recall and `Ctrl+R` never offer it; `trajectory search` still finds it, and `trajectory replay` /
  `/export` print it as the same `task wake · …` / `delegation wake · …` notice row the live session
  showed.
- Headless drivers have no queue and never wake; children never enqueue. A headless run keeps a
  background delegation inside its one turn (the SDK waits for the child before the run ends).
