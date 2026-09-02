# Command and keyboard reference

**English** · [简体中文](reference.zh-CN.md) · [Guide index](README.md)

## CLI

```bash
darwin                                      # fresh TUI
darwin --resume                             # last project session
darwin --resume <id>                        # named session
darwin --session <id>                       # named session, including a fork
darwin sessions                             # restorable snapshots
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
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
```

Print-only options: `--context-offload` (process-only force-on; offload is default-on), positive `--max-model-calls <n>`, `--compact-before`, `--output-format text|json|stream-json`. Permission overrides: `--permission-mode default|auto|plan|yolo`, `--yolo`. One leading standalone `--` is ignored for package-manager forwarding. Unknown/invalid grammar exits 2 with `error: <message>` on stderr followed by one hint line, `Run \`darwin --help\` for usage.`

## Slash commands and bundled skill entry points

`/` completion lists all of these with project skills and commands.

| Command | Behavior |
|---|---|
| `/agents` | bounded dispatch list for this run; metadata only |
| `/clear` | new successor session; live mode inherited; queue dropped |
| `/compact` | summarize older conversation; user controlled |
| `/context` | known/estimated context size; Bedrock may use heuristic |
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
| `/tasks` | background jobs, including while busy |
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
