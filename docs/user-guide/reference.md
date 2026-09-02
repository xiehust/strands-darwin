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

`darwin --help` (or `-h`) prints the grammar below to stdout and exits 0; `darwin --version` (or `-V`) prints `darwin <version>` from `package.json`. Both are answered locally before any argument parsing, runtime, config or model work — no file is written — and either flag anywhere in argv wins over everything else (help before version). The block is quoted from `CLI_USAGE` in `src/cli-usage.ts` and pinned by `spike/verify-cli-args.ts`:

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

An offline, read-only diagnostics report composed from the same loaders a session would run at startup: `~/.darwin/config.json` (provider, model, region or base URL, whether the named API-key variable is set — never its value — effort, prompt cache, context offload, trajectory / memory / diagnostics, permission mode), the system-prompt source, `AGENTS.md` size against the 32 KiB preload cap, the MCP config files in effect (which is read, which is ignored) and every configured server — a stdio `command` is looked up on `PATH`, an `http`/`sse` server is named as `not connected (doctor never connects)` — the skills catalogue per layer with every skipped entry and its reason, hook files with their dialect (native or Codex adapter), the permission-rules file, the sessions store and versions. A loader that would refuse to start the TUI (`ConfigError`) becomes one problem line here instead: problem lines start with `! `, are totalled at the end, and set the exit code — 0 when none, 1 when at least one. `doctor` starts no session, calls no model, spawns or connects to no MCP server, uses no network, and creates or moves nothing anywhere (not even `~/.darwin`); it takes no arguments (anything after the verb exits 2 with the usage error). Pinned by `spike/verify-doctor-command.ts`.

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
| `/context` | known/estimated context size; Bedrock may use heuristic |
| `/copy` | last *completed* answer's transcript text to the clipboard: OSC 52 to the terminal first (works over SSH), then `wl-copy`/`xclip`/`pbcopy` only when a display is present; one notice states bytes copied (`N of M` when over the cap) and any tool failure; rejects arguments |
| `/effort [level]` | show or set persisted model effort |
| `/exit`, `/quit` | quit |
| `/export <path>` | exact replay projection; no overwrite/session-internal target |
| `/help` | bounded local commands, syntax, and keys; rejects arguments |
| `/mcp` | read-only server states/tools/config paths; no reconnect |
| `/memory`, `/memory list` | entries with origin, provenance, validation/expiry reason |
| `/memory show <id|number>` | inspect one bounded entry |
| `/memory remember <note>` | screened user-authored project note |
| `/memory forget <id/number/all>` | remove/suppress entries and refresh live prompt |
| `/mode [mode]` | show/set user-only live permission mode; not persisted |
| `/model [name]` | list/switch configured models, conversation intact |
| `/permissions` | live allow rules and origins |
| `/permissions revoke <n/rule/all>` | synchronously narrow live/disk rules |
| `/status` | consolidated read-only model/cache/effort/mode/MCP/skills/spend/context report |
| `/tasks` | background jobs with their last three non-empty output lines, including while busy; reading them never moves the model's `output`/`wait` cursor |
| `/trajectory` | this run's local record status |
| `/usage` | process token buckets; unreported is not zero |
| `/workflow <task>` | ask the model to orchestrate the task as one `workflow` DAG call; bare form prints usage |
| `/skill-name [request]` | explicitly load/send a skill |
| `/developer <requirement>` | supervise a complete persistent headless worker |
| `/self-evolution-research` | bundled skill: backlog/research/scored supervised iteration loop |
| `/self-reflection [session id]` | bundled skill: trajectory-based review feeding qualified backlog items |

`/help`, `/mcp`, `/permissions`, `/status`, `/tasks`, `/trajectory`, `/usage`, memory management, and other report commands use local state and do not send their report to the model unless their documented mutation changes live prompt state. `/clear`, `/compact`, `/model`, `/exit`, and `/quit` refuse while busy; ordinary inputs queue.

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

- `/status` reads existing accessors only, mutates nothing, displays unknown metrics as `not reported`, and bounds name lists with `… N more`.
- `/help` is one bounded transcript notice, works before busy queueing, and performs no model/tool/network/config/session work.
- `/mcp` never probes or reconnects; tool names come from already registered state.
- `/context` and warning estimates are advisory. A known threshold crossing emits one post-turn `/compact` recommendation, rearmed only after a known drop; unknown estimates are silent.
- `/compact` is never automatic. Overflow summarization may still be invoked by SDK conversation management, using `summaryRatio` and `preserveRecentMessages`.
- `/export` is byte-for-byte the same formatter as offline replay.
- `/copy` copies the same plain answer text the transcript shows and `/export` writes; while a turn runs it copies the previous completed answer, and before any answer (or right after `/clear`/`/rewind`) it says `nothing to copy`. It makes no model call and records nothing. Over SSH the OSC 52 sequence needs a terminal that accepts clipboard writes (and tmux `set-clipboard on`).

## File edits

`fileEditor str_replace` requires `old_str` to occur exactly once; a repeated match is refused with
the line numbers. Pass `replace_all: true` to replace every non-overlapping occurrence in one write —
the result names the count and the (pre-edit) line numbers and shows one snippet around the first
replacement. The permission box and the finished row still show the one `old_str`→`new_str` pair,
with a `Replace all: every occurrence` / `replace_all: every occurrence` row stating the scope (from
the input, never from the file). Other commands ignore the flag.

## Web access tools (parent agent only)

Both are ordinary gated tools: they prompt in `default`, are denied in `plan`, and may be covered by
allow-rules. Subagents and workflow nodes never receive them.

| Tool | What comes back |
|---|---|
| `http_request` | the SDK tool: any method, headers and body; the raw response body, unbounded |
| `web_fetch` | GET only, `Accept` prefers markdown; `http://` upgraded to `https://`; same-host redirects followed, cross-host redirects reported instead; HTML converted to readable text (a **lossy** projection — scripts, styles, navigation, layout and attributes dropped), markdown/plain text kept verbatim, binary bodies refused with type and length; body capped at 40 000 code points (`maxChars` may lower it) with `[truncated: N of M code points]` stated; download stops at 4 MiB |
