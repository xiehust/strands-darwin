# darwin

A terminal coding agent built on the [Strands Agents TypeScript SDK](https://www.npmjs.com/package/@strands-agents/sdk): you talk to it in a TUI, it reads and edits files and runs commands in your repository, and it asks before doing anything that changes your machine.

## Features

Each bullet links to the section that documents it in full.

- **A safe-by-default agent loop** — reads, edits and shell commands in your repository, behind
  a [permission gate](#permissions) with four modes (`default`, `auto`, `plan`, `yolo`) and
  narrow, revocable ["always allow" rules](#remembering-an-answer).
- **A terminal UI that stays readable** — assistant answers styled as markdown at render time,
  file edits shown as bounded coloured line diffs (in the transcript and in the permission
  prompt, derived from the proposed edit itself), and a busy line that ticks elapsed time and
  token spend while a turn runs.
- **Prompt affordances** — `/` completion over commands, skills and custom commands, `@` path
  completion that inserts the path text (never file contents), `↑`/`↓` recall of the
  prompts already sent in this session, and a prompt queue: messages typed while a turn runs
  are listed above the input box and sent, one per turn, when it ends — `↑` takes them back
  into the editor, and cancelling a turn returns them unsent.
- **[Sessions](#sessions-and---resume)** — snapshotted per repository after every turn;
  `--resume` and `--session <id>` reopen them, `/clear` starts fresh, and `trajectory fork`
  branches a conversation.
- **[Session trajectory](#session-trajectory)** — an append-only record of every turn, readable
  offline with `darwin trajectory list|search|replay|fork`, exportable in-session with
  `/export`, including [what each turn cost](#what-a-turn-cost).
- **[One-shot / headless mode](#one-shot--headless-mode)** — `darwin -p "…"` prints only the
  assistant reply on stdout, with opt-in [JSON / JSONL output](#structured-output) and bounded
  automation flags for CI.
- **[Background bash jobs](#background-bash-jobs)** — long-running commands as session-owned
  tasks with persistent logs, `/tasks`, and guaranteed process cleanup on exit.
- **[Subagents](#subagents)** — delegate self-contained work to child agents (parallel for
  read-heavy work), with project-defined specialists under `.darwin/agents/` and the same
  permission gate as the parent.
- **[Skills](#skills)** — progressive-disclosure instruction folders under `.darwin/skills/`,
  plus the built-in [`developer`](#built-in-developer-supervisor) supervisor and the
  [`self-evolution-research`](#built-in-self-evolution-research) loop.
- **Custom slash commands** — Markdown files under `.darwin/commands/` (or
  `~/.darwin/commands/`), sent as the message with an `$ARGUMENTS` placeholder for what you
  type after the name.
- **[MCP servers](#mcp-servers)** — Claude Code's `.mcp.json` format, stdio and HTTP
  transports, per-server prefixes and filters, inspected in-session with `/mcp`.
- **Model flexibility** — Bedrock, [Anthropic and OpenAI](#anthropic-and-openai) providers,
  switchable mid-session with `/model`; [prompt caching](#prompt-caching) on by default and
  adjustable [thinking effort](#thinking-effort) via `/effort`.
- **Standing context** — [`AGENTS.md` preloaded](#project-instructions-agentsmd) into the
  system prompt, an overridable [base prompt](#system-prompt), and a
  [working context](#working-context) re-derived on every run, including resumed ones.
- **[Session diagnostics](#session-diagnostics)** — opt-in per-session log of the SDK's debug
  output and darwin's notices, made for `tail -f`.
- **Tool hooks** — `PreToolUse` / `PostToolUse` shell commands from `.darwin/hooks.json` (and
  `~/.darwin/hooks.json`) run around tool calls in a fixed global/project order.

The built-in slash commands (`/` lists them together with your skills and custom commands):

| Command | Does |
|---|---|
| `/agents` | list subagent dispatches this run |
| `/clear` | start a new session |
| `/compact` | summarize older conversation |
| `/context` | estimated context size |
| `/effort` | report or set thinking depth |
| `/exit` (alias `/quit`) | quit darwin |
| `/export` | write this session's transcript to a file |
| `/mcp` | configured MCP servers and their tools |
| `/mode` | set the permission mode for this session |
| `/model` | list or switch models |
| `/permissions` | list or revoke allow-rules |
| `/status` | one consolidated read-only report of the session: model, cache, effort, mode, MCP, skills, spend, context |
| `/tasks` | list background jobs |
| `/trajectory` | this session's recorded trajectory |
| `/usage` | token counts this run |

## The experiment

This is an experimental project in self-hosted AI development.

**v0.0.1 — the [baseline release](../../releases/tag/v0.0.1) — was built entirely with
[Claude Code](https://claude.com/claude-code).** From this point on, darwin develops
itself: every subsequent feature, fix, and release is made by running darwin inside its
own repository (the Trellis task history under `.trellis/` is the paper trail). The name
is the thesis — evolution by iteration, with the tool as its own selection pressure. The
baseline exists so there is always a fixed point to measure that evolution against.

### How darwin develops darwin

A human remains the developer of record: they set product and safety boundaries, approve plans,
resolve decisions the repository cannot answer, and independently accept the result. The
implementation itself is written by the current darwin running in this repository; once accepted
and committed, that revision becomes the darwin used to write the next one.

The built-in [`self-evolution-research`](#built-in-self-evolution-research) workflow adds the
selection loop in front of the [`developer`](#built-in-developer-supervisor) implementation loop.
It first advances unfinished work in the persistent research backlog. Only when that queue is
empty does it make a **weighted random draw** for the next research path, before reading any source:
50% comparable-product research, 20% TUI self-review, 15% open-ended improvement, 10% unused
Strands SDK capability, and 5% logging and observability.

The random draw is load-bearing. Without it, a model tends to keep selecting familiar,
easy-to-articulate improvements and leaves less obvious weaknesses unexamined. The first draw is
binding: it runs once, is never re-rolled because its result looks uninteresting, and is copied
verbatim into the dated research report. A user may explicitly choose a path, but the report marks
that as `override (user-directed)` rather than presenting it as chance. The script uses a uniform
cryptographic integer draw over exact half-weight units and prints the raw draw beside the weights,
so path selection is diverse and auditable without offering a seed that could be shopped for a
preferred outcome.

Darwin then inspects its current behavior and architecture through the selected lens, compares the
available evidence, and proposes scored, non-duplicate improvement directions. Every qualifying
direction is handed to `developer` separately for planning, implementation, and independent Host
acceptance, with each accepted commit becoming the Darwin revision used for the next direction:

```text
unfinished backlog, or one weighted random research-path draw
  → evidence-backed research or self-review
  → scored improvement backlog
  → developer-supervised implementation
  → independent acceptance and commit
  → the new Darwin researches and builds the next improvement
```

That closes the self-improvement loop instead of merely letting Darwin implement requirements
chosen elsewhere: Darwin can discover opportunities, rank them, build them through its existing
supervision boundary, verify them, and continue from the improved revision. It is deliberately
not unbounded autonomy—failed acceptance, a falsified premise, a dirty starting point, or a product
or safety decision only the human can make stops the batch and leaves the reason on disk.

The durable evidence is split by purpose: [`docs/research/backlog_index.md`](docs/research/backlog_index.md)
and the dated reports under [`docs/research/`](docs/research/) record selection and rationale;
**[docs/iteration-log.md](docs/iteration-log.md)** records the capability milestones and every
supervised implementation batch. Every `/developer` run appends its child session, accepted
commit, and Host-rerun checks there.

```text
◆ DARWIN · ready
bedrock/us.anthropic.claude-sonnet-4-6 · session session-20260818-062400 · cache 5m · effort high
mode: default
AGENTS.md: loaded (1.2 KB)
loaded: 3 skills · 2 agents · 1 MCP server · type / for commands
/ for actions · @ for paths · ctrl+c cancels · /exit quits

you>
node test.js fails. Find the bug, fix it, then run the test to confirm.

darwin>
Let me read the file first.
tool · ✓ fileEditor view: /repo/greet.js

╭──────────────────────────────────────────────────────────────────────────────╮
│ ◆ permission required (write — modifies a file)                              │
│ [parent] fileEditor str_replace: /repo/greet.js                              │
│                                                                              │
│ Diff:                                                                        │
│   - return 'Hello, ' + nam + '!';                                            │
│   + return 'Hello, ' + name + '!';                                           │
│                                                                              │
│ allow? y n always: a=/repo/greet.js A=all fileEditor esc=deny                │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Colour reinforces the hierarchy in a capable terminal, but the role and state markers above are
intentional text: transcripts remain scan-friendly when ANSI styling is stripped or colour is off.

## Architecture

Detailed architecture decisions live under [`docs/architecture/`](docs/architecture/), with one
focused Markdown document per subsystem. This section is the index: future architecture documents
belong in that directory and should be linked here rather than scattered through unrelated README
sections.

- [Sub-agents](docs/architecture/sub-agents.md) — definition discovery, runtime assembly, context
  isolation, parallel dispatch, shared permissions, observability, cancellation, and deliberate
  concurrency boundaries.

## Requirements

- Node.js >= 20
- pnpm (the repo is set up for it; `npm` works too but the lockfile is pnpm's)
- Credentials for whichever model provider you configure — AWS by default

## Install

```bash
pnpm install
```

`node-pty` (a dev dependency used to test the TUI) compiles a native module, which pnpm
only builds for packages you allow. It is already allow-listed in `pnpm-workspace.yaml`;
if you add native dependencies of your own you will need to extend that list.

## Run

```bash
pnpm start                          # new session
pnpm start --resume                 # continue where you left off
pnpm start --resume <id>            # reopen a specific session (ids: darwin sessions)
pnpm start --session <id>           # open one conversation by id (e.g. a fork)
```

### One-shot / headless mode

Use `-p` (or `--print`) to run one turn without the TUI or stdin:

```bash
darwin -p "reply with ok" >reply.txt 2>progress.log
darwin -p "continue that work" --continue
darwin -p "continue this exact conversation" --session session-20260814-160833123
```

On success, **stdout contains only the complete assistant reply and one final newline**. Tool
starts/results and permission denials go to stderr as bounded one-line records. Every started
headless run also writes an exact, stable line of this form to stderr:

```text
session: session-20260814-160833123
```

Capture that id to select the same persisted conversation later with `--session <id>`, in
headless runs or in the TUI. `--session` is strict: the id must use lowercase letters, numbers,
hyphens, or underscores and must already have a persisted snapshot in this project. It takes
precedence over `--continue` or the compatible bare `--resume` alias. `--continue` follows
`.darwin/last-session.json` (or starts a new conversation when no pointer exists) and is
headless-only; `--resume` is its TUI spelling, and `--resume <id>` names a specific session —
the same strict path as `--session <id>`, so combining the two is a usage error.

Headless mode cannot ask for approval, so its default permission bridge immediately denies any
call that reaches it. Static-safe calls and persisted allow-rules still run; use
`--permission-mode auto`, `--permission-mode yolo`, or `--yolo` when those existing semantics
are appropriate for automation. A denied tool is not itself a failed process if the model
handles the denial and completes. Exit status is zero only after the turn, snapshot, resume
pointer, and runtime cleanup succeed. SIGINT cancels and exits nonzero.

Three opt-in headless controls support bounded long-running automation:

```bash
darwin -p "run the complete task" --context-offload
darwin -p "bounded CI task" --context-offload --max-model-calls 200
```

`--max-model-calls` refuses the next provider request after the positive-integer ceiling.
`--context-offload` enables session-scoped oversized tool-result offload for this process without
changing config. `--compact-before` summarizes restored history before the requested turn and fails
without starting that turn if compaction cannot be persisted. These flags are valid only with
`-p/--print`; omitting them preserves the existing one-shot behavior.

#### Structured output

The default is `--output-format text`, which is the protocol above unchanged. Two opt-in formats
make the same one-shot run available without parsing human progress records:

```bash
darwin -p "reply with ok" --output-format json
darwin -p "inspect the project" --output-format stream-json
```

`json` writes exactly one versioned result document to stdout, including failures and cancellation.
`stream-json` writes one versioned JSON object per line: session/run/turn lifecycle, completed
assistant messages, permission denials, tool start/completion, SDK diagnostics, and one authoritative
terminal `result`. Every object has `schemaVersion: 1`, a process-output `sequence` starting at 1,
an ISO `timestamp`, and the requested/resolved `sessionId` (or `null` only when startup failed before
resolution). Structured stderr is empty during a valid invocation; post-parse progress and warnings
are records rather than human lines. CLI usage errors still use stderr and exit 2 because no valid
output contract was established.

A terminal `outcome` is `success`, `failure`, or `cancelled`. Success is emitted only after strict
runtime shutdown and the resume-pointer write both complete; turn, cleanup and persistence errors
are ordered under `errors`, observer/SDK degradations under `warnings`, and cancellation remains
nonzero. `usage` has mutually exclusive `input`, `output`, `cacheRead`, and `cacheWrite` buckets. An
unreported metric is an absent key, while a measured zero stays `0`.

V1 deliberately streams **completed assistant text**, not raw token deltas. Provider output
guardrails can expose text in deltas and replace it only after aggregation, so public
`assistant.message` records come from the post-redaction completed SDK message. The public format is
an allowlisted projection, never a raw SDK object: it excludes model reasoning text/signatures,
reasoning and guardrail-redacted content, raw tool input/results, traces, metrics, and live agent or
invocation state. Tool/error/diagnostic fields are bounded and explicitly marked when truncated;
long assistant messages are split into numbered bounded records, while the successful terminal
`result` remains complete like text mode. JSON escaping keeps each JSONL object on one physical line.
Uncatchable `SIGKILL` and a broken stdout pipe (`EPIPE`) cannot guarantee a terminal record.

`--output-format` may appear once and is valid only with `-p/--print`; invalid or unknown values fail
before runtime construction. It does not add a server, daemon, SDK API, or checkpoint mechanism.

Run it from the repository you want it to work on. The **current working directory** is
the project root, and everything darwin reads or writes lives there:

```
<your repo>/
├── AGENTS.md              # optional: project instructions, preloaded into the system prompt
├── .mcp.json              # optional: MCP servers, Claude Code's file, used if .darwin/mcp.json is absent
└── .darwin/
    ├── config.json        # optional: provider and model
    ├── system-prompt.md   # optional: replaces darwin's built-in system prompt
    ├── mcp.json           # optional: MCP servers (takes precedence over ../.mcp.json)
    ├── skills/            # optional: one directory per skill
    │   └── commit-message/
    │       └── SKILL.md
    ├── sessions/          # written: snapshots and background logs (gitignore this)
    └── last-session.json  # written: what --resume reopens         (gitignore this)
```

Add `.darwin/sessions/` and `.darwin/last-session.json` to your `.gitignore`; the config
and skills next to them are worth committing so the whole team gets the same setup.

> **Upgrading from before the rename**: the old locations are not read any more. Move
> `config.json` to `~/.darwin/config.json` and `skills/` to `.darwin/skills/`. Old
> `.strands-tui/` sessions cannot be resumed — the snapshot path contains the agent id,
> which changed with the name — so delete that directory.

Keys:

| Key | Effect |
|---|---|
| `Enter` | send |
| `y` / `n` / `Esc` | answer a permission prompt (`Esc` denies) |
| `/` | list skills; `↑`/`↓` to pick, `Tab` or `Enter` to complete |
| `Ctrl+B` | toggle compact/expanded background bash details |
| `Ctrl+C` | cancel the current turn; press again within 2s to quit |
| `Ctrl+D`, `/exit`, `/quit` | quit |

## Project instructions (AGENTS.md)

If the directory you start darwin in has an `AGENTS.md`, its contents are preloaded into
the system prompt inside a `<project-instructions source="AGENTS.md">` block, so standing
rules about the repository apply to every turn without you repeating them. The header says
so at startup.

Only the run directory's own file is read — no walking up to parent directories, no merging
several files — so what the model was told is exactly what you can open and read. An
absent, empty or whitespace-only file is skipped silently; one that exists but cannot be
read is skipped with the reason in the header, since otherwise you would go on believing
rules were in effect. Anything over 32 KB is cut off
at the last whole line before the limit, flagged as truncated to both you and the model,
because this text is re-sent with every request and an oversized file would spend the
context the conversation needs.

## System prompt

darwin ships with a default system prompt written for coding work: it names the tools that
are always available (`fileEditor`, `bash`), and states the working rules the rest of the
program depends on — read a file before editing it, keep edits small, verify changes by
running something, and never work around a tool call the permission gate denied.

Every actual model request has the same four text parts followed by the final cache point:

```
<base prompt>                                  ← darwin's default, or your override
<project-instructions source="AGENTS.md">…     ← your repository's standing rules
<available_skills>…                            ← the official SDK skills catalogue
<working-context>…                             ← where this session is standing
<cache point>                                  ← final cached-prefix boundary, when supported
```

Only the **base** is overridable, and an override replaces it entirely — nothing of the
default is kept. AGENTS.md, the skills list and the working context are appended either way,
so repository rules stay additive and you never have to restate them in a custom prompt.

### Working context

The first three parts are rules; the last one is facts. `<working-context>` states the
working directory, the OS and kernel, the shell, the Node version, today's UTC date and time
zone, and the immediate contents of the working directory (directories first, symlinks marked
`@`). It costs a few hundred bytes and saves the agent from opening a turn with `pwd` and
`ls` — or from guessing the year, which a model with a training cutoff does confidently and
wrongly.

It is honest about being a snapshot: the block says so, and tells the model to re-check
anything that may have moved, including its own edits. The listing is capped at 200 entries
with the remainder counted, because everything in the system prompt is re-sent on every
request and one large directory would otherwise cost more context than the conversation. The
date is stated to the day and not the second, so a run does not throw away the provider-side
cache for a precision no coding task needs.

The block is re-derived on every run, including a resumed one. That matters more than it
sounds: restoring a session replays the system prompt darwin last sent, so without the
refresh a session resumed a week later would state that week-old date and directory listing
as current. Only the working context is refreshed this way — a resumed session still carries
the base prompt, AGENTS.md and skills catalogue captured when it was created. If the
directory and the date have not changed, the refreshed prompt is byte-identical and still
reads from cache. A directory that cannot be listed is not fatal: the rest of the block is
sent and the header says why the listing is missing.

Two ways to override, highest precedence first:

1. `"systemPrompt"` in `~/.darwin/config.json` — for short prompts.
2. `.darwin/system-prompt.md` — a plain Markdown file, for prompts too long to be
   comfortable inside JSON. Commit it and the whole team gets the same agent.

The header tells you which one is in effect, because a replaced prompt changes how the
agent behaves and that should not be invisible. A `system-prompt.md` that exists but is
empty or unreadable does not stop the session: darwin falls back to the default and says
why in the header, so you never go on believing your prompt is steering the agent. A blank
`systemPrompt` in the config is a startup error instead — leaving the agent with no
instructions at all is never what someone meant to configure.

## Configuration

`~/.darwin/config.json` in the user home directory. Every field is optional — with no file at all
you get a working Bedrock setup: `global.anthropic.claude-opus-5`, plus a preset catalogue
`/model` can switch between (`claude-sonnet-5`, `claude-haiku-4.5`, `claude-fable-5`,
`claude-opus-5`, and `gpt-5.6-sol` over [Bedrock Mantle](#anthropic-and-openai)). The preset
leaves `region` unset on the Bedrock entries, so `AWS_REGION` still decides where a run talks.

```json
{
  "provider": "bedrock",
  "model": "global.anthropic.claude-opus-5",
  "region": "us-west-2",
  "maxTokens": 64000,
  "summaryRatio": 0.8,
  "preserveRecentMessages": 10,
  "permissionMode": "default",
  "promptCache": true,
  "thinkingEffort": "high"
}
```

| Field | Default | Notes |
|---|---|---|
| `provider` | `bedrock` | `bedrock`, `anthropic` or `openai` |
| `model` | `global.anthropic.claude-opus-5` | provider-specific model id |
| `region` | `AWS_REGION`, else `AWS_DEFAULT_REGION`, else `us-west-2` | Bedrock only |
| `apiKeyEnv` | — | name of the env var holding the API key |
| `maxTokens` | `64000` | |
| `summaryRatio` | `0.8` | fraction of old messages summarized on context overflow |
| `preserveRecentMessages` | `10` | messages the summarizer always keeps verbatim |
| `permissionMode` | `default` | `default`, `auto`, `plan` or `yolo` — see [Permissions](#permissions) |
| `permissionRules` | — | wildcard rules that pre-approve calls; written by the prompt's "always allow" — see [Remembering an answer](#remembering-an-answer) |
| `promptCache` | `true` | prompt caching, Claude only — see [Prompt caching](#prompt-caching) |
| `promptCacheTtl` | provider default (5m) | `5m` or `1h`, applied to every cache point |
| `thinkingEffort` | `high` | how hard the model thinks — `low`, `medium`, `high`, `xhigh`, `max`; changeable with `/effort` — see [Thinking effort](#thinking-effort) |
| `classifierModel` | per provider | model id for `auto` mode's safety classifier |
| `requestTimeoutMs` | `180000` | Bedrock only — idle timeout for one streaming request; fails with "Stream timed out because of no activity" when nothing arrives for this long |
| `systemPrompt` | built-in prompt | replaces the base system prompt; wins over `.darwin/system-prompt.md` — see [System prompt](#system-prompt) |
| `trajectory` | `true` | record an append-only trajectory of every turn; set `false` to write nothing — see [Session trajectory](#session-trajectory) |
| `diagnostics` | `false` | write this session's SDK `debug`/`info` output and darwin's notices to a per-session log — see [Session diagnostics](#session-diagnostics) |

Switching providers is a config change only; no code names a provider.

### Bedrock

Uses the default AWS credential chain (environment, shared config, instance role). The
model id **must be a cross-region inference profile** — a bare `anthropic.*` id is
rejected by the service. Prefix it with `us.`, `eu.`, `apac.` or `global.`, and list what
your account can reach:

```bash
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[?contains(inferenceProfileId, `anthropic`)].inferenceProfileId'
```

### Anthropic and OpenAI

These providers need a peer dependency that is not installed by default, because a
Bedrock-only setup should not have to carry them:

```bash
pnpm add @anthropic-ai/sdk   # provider: "anthropic"
pnpm add openai              # provider: "openai"
```

The agent tells you this if the package is missing. Point `apiKeyEnv` at the variable
holding your key, or rely on each SDK's own convention (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`).

### Prompt caching

Every turn re-sends the same prefix: the tool schemas, the assembled system prompt (base +
AGENTS.md + the skills catalogue) and the whole conversation so far. darwin marks that prefix
with [cache points](https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#caching)
so the provider bills it as a cache read instead of fresh input — on a Bedrock Sonnet run that
is ~11,700 tokens read from cache against 3 charged as input on the second turn.

It is on by default and covers three parts:

| Part | Bedrock (Claude) | Anthropic API | OpenAI |
|---|---|---|---|
| tool schemas | cached | — | — |
| system prompt | cached | cached | — |
| conversation | cached | — | — |

Set `"promptCache": false` to turn it off, and `"promptCacheTtl": "1h"` to keep entries alive
for an hour instead of five minutes (a longer TTL costs more to write). Non-Claude models
cannot cache; the header says so rather than pretending otherwise. Two things naturally cost
a cache miss: the turn on which the conversation is summarized (its history is rewritten), and
any change to AGENTS.md, the system prompt, or the set of tools.

Official AgentSkills injects its catalogue immediately before each invocation. Darwin then moves
that exact catalogue block ahead of current working context and the final system cache point, so
first, repeated and resumed model requests keep one catalogue and the same cached-prefix order.

### Thinking effort

Claude 4.6 and later think *adaptively*: instead of a fixed token budget, the model decides per
request whether to reason and for how long, guided by a coarse effort level. darwin asks for
`high` — Anthropic's own default, meaning "always thinks".

| Level | Behaviour |
|---|---|
| `low` | minimizes thinking; skips it for simple tasks where speed matters |
| `medium` | moderate thinking; may skip it for very simple queries |
| `high` | always thinks (the default) |
| `xhigh` | always thinks, extended depth — Opus models only |
| `max` | always thinks, no depth constraint |

Change it mid-session with `/effort`, which takes effect on the next model call and is written
back to `~/.darwin/config.json` so it survives a restart:

```
/effort              # report the current level
/effort max          # switch, and remember it
```

A level the model cannot serve is clamped rather than sent — `xhigh` on Sonnet 4.6 becomes
`high`, and the header says why. The alternative is worse than a downgrade: the service rejects
an unsupported level on *every* request, not just once. Models older than Claude 4.6 have no
adaptive thinking at all, and the header says that too.

On the `openai` provider the level becomes `reasoning_effort`, which has no `xhigh` or `max`
(both clamp to `high`) and is only accepted by reasoning models.

## Session trajectory

Every turn is appended to an **append-only record** beside the session's other state:

```
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

One JSON object per line: the run's model and permission mode, each prompt as it was sent, the
assembled assistant blocks, every tool call with its input and result, and a per-turn summary
carrying the stop reason, the turn's duration, [what it cost](#what-a-turn-cost), and the counts of
the events that were *not* stored. If a turn *failed*, that summary also names what threw — the
error's class, its message, and the provider class it wrapped — so a failed run is readable
afterwards instead of only in the terminal it scrolled past,
and a failed turn, a turn you cancelled and a clean turn all read as themselves. It is on by
default; set `"trajectory": false` in `~/.darwin/config.json` to record nothing.

The record is bounded, so one huge tool result cannot make it dominate your disk: strings are
capped at 8,000 characters, a record at 64 KiB, and a session's file at 64 MiB — and every
truncation is written into the record itself, so a reader can always tell "this is all there
was" from "this was cut". Reasoning is recorded as presence only, never as text. Bytes already
written are never rewritten, so an interrupted session leaves a valid prefix rather than a
corrupt file, and readers report a partial last line instead of hiding it. Recording is an
observer: if it cannot write, the session keeps working and says so once.

Read it with the `trajectory` subcommand, which makes **no model calls and needs no network**:

```bash
darwin trajectory list                                  # recorded sessions, newest first
darwin trajectory search "npm install"                  # substring search across this project
darwin trajectory search "flaky test" --session <id>     # …or within one session
darwin trajectory replay <id>                            # the session's history as text
darwin trajectory replay <id> --turn 3 --json            # one turn, machine-readable
darwin trajectory fork <id>                              # branch it into a new session
```

`replay` reconstructs what the session *showed*: your prompts, the assistant's replies, each
tool call with its status and result preview, and — for a turn that failed — the same `turn failed:`
notice the TUI showed, plus a line naming the error's class. `list` says how many turns failed and
what threw, bounded to one line per session. Both exit 0: a record that faithfully describes a
failure was read successfully. `replay` re-runs nothing — no model call, no tool
execution, no file or shell action — and it does not reproduce token-level timing, reasoning
content, bytes a cap removed, or terminal colours. `search` prints `no matches` when a record it
read contains nothing (exit 0) and tells you plainly when a session has no record at all
(exit 1), rather than reporting an empty result for a file that was never written.

`fork` copies a session's snapshot — and its offloaded files, and its record as the fork's
prefix — into a fresh id, then prints that id. The source is left byte-identical and `--resume`
still points wherever it did, so a fork is a branch, not a move:

```bash
NEW=$(darwin trajectory fork session-20260816-101112)
darwin --session "$NEW"            # continue the branch in the TUI
darwin -p "carry on" --session "$NEW"
```

Inside a session, `/trajectory` reports what this run has recorded — the file, the record and
byte counts, any truncation, and any problem — without sending anything to the model.

### What a turn cost

Each turn's closing line also carries the tokens that turn spent, in the same four buckets the
headless `usage:` line prints, together with the provider and model that incurred them (the record
below is abridged — the same line still carries the counts and truncations described above):

```json
{"type":"turnEnded","stopReason":"endTurn","ms":8421,
 "spend":{"provider":"bedrock","model":"global.anthropic.claude-opus-5",
          "input":412,"output":1350,"cacheRead":130961,"cacheWrite":398}}
```

So a session stays costable after the process is gone — which it was not before, because the live
meter counts one process and `--resume` starts it again at zero. `replay` prints one line per turn
and one for the session, and `trajectory list` puts the same totals on the session's row; both still
make no model call and need no network:

```
  turn 3 spend: input=412 output=1350 cacheRead=130961 cacheWrite=398 · bedrock/global.anthropic.claude-opus-5
  turn 4 spend: input=0 output=0 cacheRead=- cacheWrite=- · bedrock/global.anthropic.claude-opus-5
  session spend: input=412 output=1350 cacheRead=130961(+1 unreported) cacheWrite=398(+1 unreported) over 2 turn(s)
```

Two properties are worth trusting deliberately. **Unknown is never zero:** a metric the provider did
not report is *absent* from the record and prints as `-`, or as `(+N unreported)` in a total — because
"nobody measured this" and "this was free" are different facts, and OpenAI Responses genuinely cannot
split uncached input when a cache subset is missing. A recorded `0` is a real measurement, which is
what a turn that failed before its first model call completed actually spent. And **a total never
silently mixes two price lists:** the model is stamped on every turn, so a session in which you used
`/model` reports the models that contributed and `replay` splits the total between them. A session
recorded before this existed says `spend: unknown` rather than pretending it was free.

The number is what the SDK's meter attributed to a turn, not an invoice: summarization (`/compact`
and overflow reduction) calls the model outside the metered path, so its tokens appear neither here
nor in `/usage`.

## Session diagnostics

Some of the most useful things the SDK has to say, it says only at `debug`: that a request was
**throttled**, where it placed its **cache points**, that native token counting fell back to
estimation, that an MCP tool was renamed. Darwin discards that level by default, so a session that
was slow because the provider throttled it leaves no evidence anywhere. Turn it on when you need it:

```json
{ "diagnostics": true }
```

Then this session's SDK `debug`, `info`, `warn` and `error` output — plus every notice darwin showed
you, with its severity — is appended to a log beside the session's other state, one timestamped line
each, made for `tail -f`:

```
~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log
```

```
2026-08-16T12:00:00.123Z darwin info  — diagnostics started · session session-20260816-120000 · darwin 0.4.0 · bedrock/global.anthropic.claude-opus-5 · pid 12345 · budget 8388608 bytes
2026-08-16T12:00:03.881Z sdk    debug — msg_idx=<3> | added cache point to last user message
2026-08-16T12:01:44.517Z sdk    debug — throttled | error_message=<Too many requests, please wait before trying again.>
2026-08-16T12:02:02.004Z darwin warn  — context is ~82% of the model window — /compact can shrink it
```

**Off by default on purpose.** Those lines quote provider payloads, so they can contain parts of your
conversation — the same reason `contextOffload` is opt-in. With the field absent nothing is written,
nothing is even formatted, and no file exists. Turning it on is a decision about your own data, so it
is yours to make.

It is bounded and it says when a bound is reached: 8,000 characters per line, 8 MiB per session
(after which one final line says it stopped, rather than the file just ending), and a firehose that
outruns the disk drops diagnostic lines and writes down how many — never blocking or delaying the
agent. If the log cannot be written at all, the session carries on and tells you once. Nothing
deletes it; remove the session directory when you are done.

Two things worth knowing before you read one: an SDK warning appears twice — once as the SDK saying
it (`sdk`) and once as darwin showing you a notice about it (`darwin`) — and, because the SDK's
logger is process-wide, a **subagent's** diagnostics are in here too, unlike the trajectory, which
records no child events.

## Background bash jobs

The existing `bash` tool can run long-lived work without blocking the current turn. Its
modes are:

| Mode | Input | Behavior |
|---|---|---|
| `execute` | `command`, optional `timeout` | Runs in the SDK's persistent foreground shell, unchanged |
| `restart` | — | Recycles that foreground shell |
| `start` | `command` | Starts a session-owned process group and immediately returns a task id, PID, and log path |
| `list` | — | Returns full status snapshots for every current-runtime task in launch order |
| `status` | `taskId` | Returns command, state, timing, exit metadata, log path, and output byte count |
| `output` | `taskId` | Returns the next complete UTF-8 chunk (at most 64 KiB, plus bytes needed to finish its final character) from that task's remembered cursor |
| `stop` | `taskId` | Stops the task's whole process group with bounded TERM→KILL cleanup |

A task is `running`, `succeeded`, `failed`, or `stopped`. The local `/tasks` command lists
all jobs in this run with concise command text and elapsed time, without sending a model
request; it is also available while a turn streams. Background lifecycle tool calls render
compactly by default: repeated successful status and empty output polls do not fill scrollback,
while child output and failures remain visible. Press `Ctrl+B` to toggle expanded lifecycle
results for active and subsequent calls; the current prompt draft is left untouched. Darwin
also adds a dim transcript notice as each task succeeds, fails, or is stopped, including
failure exit metadata when available.
Standard output and standard error are combined in
`~/.darwin/sessions/<project-key>/<session-id>/background/<task-id>.log`; the absolute path is included
in start and status results for full replay. Logs remain after completion and after darwin
exits, and are not pruned automatically.

Task ids and incremental-read cursors live only in the current process. `--resume` may
reopen the conversation and retained logs, but it does not restore control of old jobs.
Main and child agents in one run share the same task registry. Darwin owns every process
it starts: runtime shutdown stops all registered process groups, and a synchronous process
exit fallback kills anything still registered after bounded cleanup. As with foreground
bash, uncatchable termination such as `SIGKILL` or machine failure cannot provide that
guarantee.

`start` follows the same permission mode and `bash:<pattern>` allow rules as `execute`.
`list`, `status`, `output`, `stop`, and `restart` are safe lifecycle operations and do not prompt.

## Permissions

darwin runs in one of four approval modes, set by `permissionMode` in
`~/.darwin/config.json` or per run with `--permission-mode <mode>` (`--yolo` is shorthand):

| Mode | Behaviour |
|---|---|
| `default` | statically *provably safe* calls run silently; everything else prompts |
| `auto` | like `default`, but a model classifier judges the calls static rules could not clear — only classifier-flagged calls prompt |
| `plan` | only read-classified calls run; writes and executes are denied without prompts, classifier calls, allow-rule bypass, or configured hook execution |
| `yolo` | nothing prompts (the header warns you) |

"Provably safe" is a whitelist, checked against both the tool's name and its arguments
(one tool can span read and write):

`plan` is enforced from the same `(toolName, input)` classification used by every other mode,
not from prompt wording. `fileEditor view`, skill loading, background-task inspection, and
subagent delegation can proceed; `fileEditor` mutation, any command-bearing `bash` call, and
unknown/MCP tools are denied. The parent and every child share the intervention. If project
`PreToolUse` hooks are configured, a blocked plan call is rejected before their shell commands
run. Stored allow rules remain on disk for later modes, but the plan header marks them ignored.
Headless runs report the effective post-override value as `permission-mode: plan` on stderr.

| Call | Statically safe? |
|---|---|
| `fileEditor` with `command: view`, `load_skill`, `bash` restart | yes |
| `fileEditor` writes inside the project — except `.git/` internals, `.env*`, and `~/.darwin/config.json` | yes |
| `bash` where every segment starts with an allowlisted read-only command (`git status/log/diff/show/branch`, `ls`, `cat`, `grep`, `rg`, `find`, …) and uses no redirection or substitution | yes |
| anything else, including **all MCP tools** | no — prompts (or goes to the classifier in `auto`) |

The rules only whitelist, so a parsing miss costs an extra prompt, never a silent
approval. In `auto` mode the classifier is a cheap one-shot model call (Haiku by default;
`classifierModel` overrides it) and is fail-closed the same way: a verdict of unsafe, a
timeout, an error, or an unparseable reply all fall back to asking you — with the
classifier's reasoning shown in the prompt. It never auto-denies.

Denying a call is not an error — the model is told the user declined, and is instructed
not to retry or work around it, so it explains itself and asks what to do instead.

### Remembering an answer

A prompt offers more than yes and no:

```
allow?  y  n  always: a=pnpm typecheck *  A=all bash  esc=deny
```

`a` takes the narrow rule darwin derived from this very call, `A` the whole tool. Either
one approves the call *and* appends the rule to `permissionRules.allow` in
`~/.darwin/config.json`, so matching calls stop asking — in this session and every later one.
The header then shows how many rules are live (`mode: default · 2 allow rule(s)`).

```json
{
  "permissionRules": {
    "allow": ["bash:pnpm *", "fileEditor:src/**"]
  }
}
```

| Rule | Covers |
|---|---|
| `bash:pnpm *` | any `bash` command whose every chained segment starts with `pnpm` |
| `bash:pnpm typecheck *` | `pnpm typecheck`, with or without extra arguments |
| `fileEditor:src/**` | writes anywhere under `src/` (`**` crosses `/`, `*` does not) |
| `bash` | every `bash` call — the tool-wide form, and the only shape available for MCP tools |

Rules widen what runs unprompted, so they are deliberately narrow in three ways. A `bash`
pattern must match **every** chained segment (`pnpm build && rm -rf /` does not match
`bash:pnpm *`) and never matches a command using redirection or substitution. Writes to
`~/.darwin/config.json` and to `.env*` files are covered by **no** rule at all — otherwise a
broad rule would let the agent grant itself more of them. And nothing is remembered
implicitly: a plain `y` stays a one-time answer.

`/permissions` lists every rule in force with its origin — loaded from the file, or
granted this session — and `/permissions revoke <n|rule|all>` removes one (or all of
them) from the live gate *and* from the file, so the next matching call asks again and a
fresh process does not resurrect it. The command only ever narrows: new rules keep coming
exclusively from the prompt's "always allow" options. Editing the file by hand still
works; an unparseable rule is a startup error rather than a rule that silently never
matches.

## MCP servers

Put servers in `.darwin/mcp.json`, or leave an existing `.mcp.json` in the project root —
the format is Claude Code's either way, so a file that tool wrote works unchanged:

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:MY_TOKEN}" }
    }
  }
}
```

`.darwin/mcp.json` wins when both files exist, and the header says the root one is being
ignored — the two are never merged, so the effective server list is always one readable
file. Neither file simply means no MCP.

Every server's tools are exposed to the model as `<serverName>_<toolName>` (e.g.
`everything_get-sum`). Two servers may legitimately publish the same tool name —
`browser_close` ships in several — and without the prefix the duplicate is a fatal
registration error at startup. Set `"prefix": ""` on a server entry to opt back into bare
names (or any custom prefix to shorten long server names), accepting the collision risk
yourself.

`.darwin/mcp.json` is gitignored by default because `headers`/`env` entries tend to carry
real tokens. Prefer `${VAR}` / `${env:VAR}` interpolation for secrets; once the file is
clean you can delete the `.gitignore` line and commit it.

Transport is inferred: `command` means stdio, `url` means streamable HTTP. Set
`transport` explicitly for `sse`. `${VAR}` and `${env:VAR}` are interpolated in commands,
arguments, environment, URLs and headers. Per-server `disabled`, `prefix` and
`toolFilters` are supported.

A server that fails to start — or whose config references an unset `${VAR}` — is skipped
rather than fatal, so one broken entry never stops the agent from launching. The SDK logs
the reason, but that happens before the TUI takes over the screen, so in practice you
notice it as a lower server count in the header. `/mcp` names the culprit: it lists every
configured server with its connection state — a failed one is stated as `failed` instead
of silently contributing zero tools — plus each connected server's registered tool names
(capped, with an explicit `… N more`) and the config file(s) in effect, including a root
`.mcp.json` being ignored. The report is a pure read of state darwin already holds: it
never connects, reconnects or probes a server, so asking cannot change anything — a
failed server needs a restart to retry. A file that cannot be parsed at all is a
different matter and does stop startup, with the parse error and the path. MCP tools
always require approval.

> **If an `npx`-based server fails with `Connection closed`**, check your `package.json`
> for a `devEngines.packageManager` field. MCP servers are spawned in the project
> directory, and `npx` refuses to run when `devEngines` demands a different package
> manager, failing with `EBADDEVENGINES` — which reaches the agent only as a closed
> connection. Remove the field or pin `cwd` for that server.

## Skills

A skill is a folder of instructions the agent pulls in when it is relevant. Put them
under `.darwin/skills/`:

```
.darwin/skills/
└── commit-message/
    ├── SKILL.md
    ├── references/
    │   └── types.md
    └── scripts/
```

`SKILL.md` is YAML frontmatter plus markdown:

```markdown
---
name: commit-message
description: Write git commit messages following this project's conventions. Use when the user asks for a commit message.
---

# Commit message conventions

...the full instructions...
```

`description` is required — it is the only thing the model sees up front, so write it as
"what this is for and when to use it". `name` defaults to the directory name. Darwin supplies
accepted entries as official SDK `Skill` objects to official `AgentSkills`; the SDK parses the
frontmatter/body, injects the catalogue, records activation state, and lists files under
`scripts/`, `references/` and `assets/`. Listings are bounded to 20 files and three recursive
levels, with an explicit truncation marker. Host resource trees must contain no symlinks or
outside-root resolutions, and Darwin stops the safety preflight after 200 entries before invoking
the official loader.

Two ways a skill gets used:

- **The model decides.** Only names and descriptions go in the system prompt; when a
  request matches, the model calls the single safe `load_skill({name})` tool to read the rest.
  The SDK-native `skills({skill_name})` tool stays private, avoiding a second model-facing path.
  This progressive disclosure is what keeps many skills affordable.
- **You decide.** Type `/commit-message` (optionally with a request after it) and the
  skill's full text is sent with your message.

A malformed optional skill is reported at startup and skipped; the rest still load. Required
built-ins are fatal, built-in names are reserved case-insensitively, and valid project entries
override global entries with the same name.


### Built-in developer supervisor

`developer` is bundled with darwin, so it is advertised even when the target repository has
no `.darwin/skills/`. Invoke it with a delegated requirement after the command:

```text
/developer Fix the arithmetic defect, run node test.mjs, and show the diff.
```

The Host remains in the interactive conversation and supervises one complete headless Darwin
worker. The child uses the target repository's configured non-developer skills and owns its normal
workflow — task/planning artifacts, research, implementation, checks, spec updates and authorized
commits — in the first `darwin -p` turn. There is no separate planning-only child or Host plan
approval round. Only unresolved product, scope or authorization questions return to the Host/user.
Every invocation is a managed background `bash start` job, monitored with `status` and incremental
`output`; type `/tasks` while the Host turn is streaming to inspect it without interrupting it.

Two ids participate and are not interchangeable:

- `bg-…` identifies one short-lived managed process and is used by `bash status`/`output`;
- the exact `session: session-…` stderr record identifies the child's persisted conversation.
  A focused correction uses `--session <captured-id>`; the first complete worker uses a fresh
  session and never relies on `--continue`, the resume pointer, or a background id.

Headless children have no person available to answer permission prompts, so the built-in developer
workflow runs every child invocation with `--yolo` and process-only context offload. It does not
apply a model-call budget by default: the child can follow the target repository's workflow to a
natural completion. `--max-model-calls <n>` remains available only when the user or Host explicitly
sets a cost ceiling. A focused correction compacts the prior session only after a large worker turn.
Child prompts batch independent reads/checks, serialize dependent writes, and use a test pyramid:
focused checks while editing, one child full gate after source settles, then one independent Host
full gate. The Host still constrains each child to the named repository and
authorized task scope; yolo changes confirmation behavior, not that scope. It does not silently
patch over a child failure: it independently inspects the diff and runs the requested checks, then
either sends a focused correction to the same child session or reports the blocker. Its final report
includes the child session id, background outcomes, acceptance evidence, token spend, and
unresolved risks.

A project skill cannot replace this built-in name. A case-insensitive `developer` collision is
skipped and reported with the other skill problems.

### Built-in self-evolution research

`self-evolution-research` is also bundled with darwin. Invoke
`/self-evolution-research` to inspect `docs/research/backlog_index.md` and advance the
existing directions before considering new peer-product research. Unfinished `in-progress`
work comes first, then ranked `not-started` work; either suppresses fresh research.

When the backlog has no unfinished work, the skill rolls one research path before reading any
source: 50% comparable-product analysis, 20% TUI self-review, 15% open-ended improvement, 10%
unused Strands SDK capability, and 5% logging and observability. The weighted randomness is what
forces unfamiliar but potentially valuable areas to receive attention instead of letting the model
choose the same comfortable category on every run.

The first draw is binding and auditable. It uses exact half-weight units, is rolled once, is never
re-rolled because the outcome seems unproductive, and is copied verbatim into the report with its
raw draw and weight table. `--path <id>` exists only for an explicit user direction; that record
says `path-source: override (user-directed)` and cannot be presented as chance. There is no seed,
because a reproducible draw would also make it possible to shop for a preferred result.

On the peer path it compares sourced evidence from Claude Code, Codex, DeepSeek harness,
PenguinHarness, and other relevant products with Darwin's current code and architecture; on a
self-review path the evidence is this repository, cited by path and symbol, with no peer table to
pad. Either way it appends an UTC-timestamped run to
`docs/research/research_<YYYY-MM-DD>.md`, proposes at most five scored directions, and updates
the backlog. Those directions form one **batch**, and a score gate
(`MINIMUM_IMPLEMENTATION_SCORE = 6`, the score of an all-average direction) keeps anything
below it out of the queue.

It then loads the existing `developer` skill and works the batch iteratively: one direction at a
time, each in a fresh child session and delegated to the Darwin revision the previous direction
produced. Before each handoff the tree and baseline checks must be clean; after each child, the Host
independently inspects and verifies the result before accepting its commit. The loop continues until
the batch is exhausted or a recorded halt condition fires — repeated acceptance failure, a
falsified premise, a decision only the user can make, an unverifiable starting point, or nothing
left worth building. A direction becomes `done` only after independent acceptance; blocked work
stays `in-progress`, and `abandoned` requires an explicit recorded reason or the score gate. This
research → developer → acceptance → next-revision cycle is Darwin's self-evolution mechanism while
preserving the human decision boundary. The committed `docs/research/research_template.md` defines
the report and source-citation shape.

### Built-in self-reflection

`self-reflection` is the third bundled skill. Invoke `/self-reflection` to have darwin review the
session it is running in: the Host first runs the skill's bundled locator to pin this session's
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl` (verifying the printed
`last-user-input:` preview against the live conversation before trusting it), then delegates the
analysis to a fresh headless darwin worker under the same managed-child contract as `developer`.
A past session of the same project can be reflected on instead by naming its id explicitly
(the locator's `--session <id>`, with ids from `darwin sessions` or `darwin trajectory list`);
a missing id is refused rather than silently replaced.

The worker reads the record read-only — `trajectory replay` for the conversation shape, the raw
JSONL for spend, failures, and tool calls — and writes exactly one document,
`docs/reflections/reflection_<UTC-date>_<session-id>.md`, following the skill's bundled template:
an evidence-cited completion grade on a four-level rubric (Perfect / High / Medium / Low),
process observations, and improvement findings for darwin itself (system prompt, tool
descriptions, orchestration, context management, execution time, token spend). Each suggestion
is scored with
the `self-evolution-research` dimensions, formula, and score gate; directions at or above the gate
are appended to `docs/research/backlog_index.md` as `not-started` rows with stable `SRF-NNN` ids,
where the next `self-evolution-research` run picks them up as ordinary development tasks. The
reflection run itself never starts implementing them.

Like the other bundled skills, the name is reserved: a case-insensitive project-skill collision is
skipped and reported.

## Subagents

The main agent has a `subagent` tool for delegating a self-contained task to a fresh child
agent. Child work has its own conversation: intermediate messages and tool calls stay out of the
main transcript, and the child's rendered terminal result comes back as the tool result. The
current SDK rendering can include child reasoning in that result; the exact boundary and its
limitations are documented in the [sub-agent architecture](docs/architecture/sub-agents.md).
The built-in `general` agent is always available and is suitable for broad code searches,
independent implementation tasks and verification.

Add specialists as direct Markdown files under `.darwin/agents/`:

```markdown
---
name: explorer
description: Searches a large code area and returns an evidence-based map.
tools:
  - bash
  - fileEditor
---

You are a repository exploration specialist. Trace the requested behavior, cite files and
symbols, and finish with a concise report for the parent agent.
```

`name`, `description`, and a non-empty Markdown body are required. Names are
case-insensitive when selected, must use letters, numbers, hyphens or underscores, and may
not shadow `general`. `tools` is optional:

- omit it to make every child-eligible tool available;
- use `tools: []` for a tool-free specialist;
- otherwise list exact, case-sensitive registered names such as `bash`, `fileEditor`,
  `load_skill`, or a prefixed MCP tool.

An unknown tool name skips that definition rather than silently weakening it. Other malformed,
empty, duplicate or unreadable files are also skipped and reported at startup; valid agents
still load. Definitions are read once at startup.

Each dispatch creates a new model and child context. Children do not inherit main-conversation
messages, do not persist sessions, and cannot invoke `subagent` recursively. A `/model` switch
applies to children dispatched afterwards.

Tool restrictions are not permission grants. Every child tool call goes through the same
permission gate and live allow-rules as the main agent. Delegation itself does not prompt,
because it performs no project I/O; a child write, shell command, or MCP call is approved or
denied normally. Ctrl+C cancels the active child together with the parent turn, and darwin
reaps child bash sessions after each dispatch.

### Parallel dispatch, and who is asking

Two `subagent` calls the model requests in one turn run **at the same time**: the SDK executes
the tool calls of one assistant message concurrently, and each child has its own model, tools
and context. Two 300 ms children therefore take about 300 ms, not 600 (pinned offline by
`spike/verify-subagents.ts`).

Approvals stay strictly one at a time — the prompts queue, and the box shows how many are
waiting. So every permission prompt says which agent it came from, on the same line as the call
itself:

```
permission required (execute — `curl` is not on the safe-command list)
[explorer#a1b2c3d4] bash: curl https://example.com
```

`[parent]` is the main agent; `[<agent>#<dispatch>]` is one dispatch of a child. The
`/agents` command lists the dispatches of the current run — agent, dispatch id, state and
elapsed time, with a bounded one-line task summary — and a dispatch that finishes mid-turn
appends a notice of its own:

```
subagent dispatches — this run (2)
  explorer#a1b2c3d4          running       12s  find every call site of classify
  general#0f9e8d7c           succeeded      4s  summarize the permission gate

subagent general#0f9e8d7c succeeded in 4s — summarize the permission gate
```

That report is dispatch *runs*, not the catalogue of definitions the header lists, and it never
contains any part of a child's transcript: a record holds only the agent name, the delegated
task, a state and timestamps.

**Parallel delegation is for read-heavy work.** Concurrent children share one working tree with
no isolation, locking or conflict detection, so two children editing the same area will
interleave their edits and darwin will not stop them. Delegate searches, reads and analysis in
parallel; keep mutation on one agent at a time.

## Sessions and `--resume`

Each session is snapshotted after every turn under `~/.darwin/sessions/<project-key>/`, with
`last-session.json` in that directory pointing at the most recent one. Sessions are scoped to the
repository rather than in your home directory because a coding conversation belongs to one
repository — that scopes `--resume` per project for free. Both paths belong in your
`.gitignore`.

`pnpm start --resume` reopens the last session and restores its history. If there is
nothing to resume it quietly starts fresh.

To pick a session by choice instead of taking the last one, list what this project can
actually reopen and name it:

```bash
darwin sessions            # id, age, first user prompt — read-only, no model call
darwin --resume <id>       # reopen that session
```

Each row of `darwin sessions` is a session with a restorable snapshot, newest first by
activity: the first recorded user prompt where the session kept a trajectory, `(not
recorded)` where it did not, and `(last)` marking what bare `--resume` would reopen.
Listing changes nothing — no pointer moves, no file rewrites. A bogus or other-project id
given to `--resume <id>` is refused with a clear message rather than falling back to the
last session; once the resumed session finishes a turn, it becomes the one bare
`--resume` reopens.

Note that the snapshot path includes the agent id, so changing `AGENT_ID` in
`src/agent/runtime.ts` orphans existing sessions.

## Known limitations

- **Input is single line.** Ink delivers Enter as a keypress rather than a newline, so
  multi-line editing would need a separate submit binding plus wrapping and cursor
  handling. Pasted multi-line text is accepted and submitted at the first newline.
- **Streamable HTTP MCP is configured but not live-tested.** The configuration path is
  verified; no public HTTP MCP server was available to connect to. stdio is tested
  end to end.
- **The permission diff is against the tool's input, not the disk.** File edits are shown
  as a line diff, but it is computed from the old and new text the model proposed — it is
  never re-read from the file on disk, so a file changed since the model read it can make
  the shown diff and the actual effect differ.
- **No sandboxing.** `bash` runs commands directly on your machine. The confirmation
  prompt is the only thing between the model and your shell.
- **No autonomous scheduler or agent swarm.** The optional built-in developer workflow supervises one external headless child through existing sessions and managed bash jobs; it does not add another in-process agent loop.
- **Context size is an estimate, not a provider count, on Bedrock.** `/context`, the context
  warning and `/compact`'s before/after numbers ask the model to count tokens, and darwin does
  enable Bedrock's native `CountTokens` (`useNativeTokenCount: true`) — but the API cannot be
  reached for the models darwin runs, so it always falls back to the SDK's character heuristic.
  Two separate reasons, both measured against `us-east-1`/`us-west-2` in August 2026:
  `CountTokens` accepts only a **bare** foundation-model id, so every id darwin uses is rejected
  (`anthropic.claude-sonnet-4-6` counts; `us.` / `global.` / an inference-profile or
  foundation-model ARN of the same model all answer `ValidationException: The provided model
  doesn't support counting tokens` — and a profile id is exactly what Bedrock *requires* for
  these models); and past 4.6 the bare id is refused too (4.5 and 4.6 count, `claude-opus-4-7`,
  `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-5` and `claude-fable-5` do not). Stripping
  the prefix ourselves would therefore buy real counts only on 4.6 and older, so nothing is
  stripped and the estimate stands until the upstream API takes profile ids. Note that the
  fallback is silent by design: the SDK says it only at `debug`, which needs
  [`diagnostics`](#session-diagnostics) — except when the caller's IAM policy is missing
  `bedrock:CountTokens`, which is a `warn` on the transcript once per model per process.
- **Recorded turn numbers restart with each process.** A session's turns are numbered from 1 per
  run, so a resumed session's record can hold several `turn 1` lines and `trajectory list` counts
  distinct numbers rather than turns. Spend totals are unaffected — they add up the turns actually
  recorded — but a per-turn line in `replay` identifies its turn only within its own run.

## Development

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # the checks that need no model calls (config, MCP config, skills, AGENTS.md, system prompt)
pnpm build        # emit to dist/
pnpm dev-repl     # plain readline REPL against the same runtime, for debugging
```

There is no linter configured; `pnpm typecheck` is the only static gate.

`pnpm dev-repl` predates the TUI and is kept as a debugging aid: it drives the same
`AgentRuntime` with line-by-line output, so a problem that reproduces there is in the
agent layer rather than in the terminal rendering.

Verification scripts live in `spike/`. Those whose names start with `verify-` assert
rather than print, and exit non-zero on failure:

```bash
pnpm tsx spike/verify-config.ts                            # config parsing and provider switching, no model calls
pnpm tsx spike/verify-mcp-config.ts                        # MCP config precedence and error paths, no servers started
pnpm tsx spike/verify-mcp-command.ts                       # /mcp projection and report over real client states, in-process servers only
pnpm tsx spike/verify-skills.ts                            # layered skill policy and slash UX, no model calls
pnpm tsx spike/verify-agent-skills.ts                      # real offline Agents: official tool, prompt/cache/resume and bounds
pnpm tsx spike/verify-headless.ts                          # parser/output/session contracts with counted assertions
pnpm tsx spike/verify-agents-md.ts                         # AGENTS.md loading, truncation, prompt order, no model calls
pnpm tsx spike/verify-system-prompt.ts                     # default prompt, override precedence, fallbacks, no model calls
pnpm tsx spike/verify-permission-modes.ts                  # risk rules and per-mode gate decisions, no model calls
pnpm tsx spike/verify-prompt-cache.ts                      # cache decisions, config surface, cache-point placement, no model calls
AWS_REGION=us-west-2 pnpm tsx spike/verify-classifier.ts   # auto mode's safety classifier, live verdicts
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts  # cache tokens written, then read
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts     # agent core, permissions, resume, AGENTS.md injection
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts          # real stdio MCP server
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts autonomous # one low-token autonomous load_skill smoke
AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts # opt-in Host → persistent child workflow
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts          # the TUI, driven through a pty
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts      # real git repo, read → fix → test
```

The TUI suites take a scenario name to run just one, e.g.
`pnpm tsx spike/verify-tui.ts approve` (scenarios: `approve`, `deny`, `safePassthrough`,
`bashExit`, `cancelThenContinue`, `completion`, `agents`, `agentsMd`). They need a real pty (Ink requires raw mode);
`spike/tui-driver.ts` provides it. `agents` and `completion` make no model calls at all.

### Global and project Darwin state

Personal application state lives under `~/.darwin`: `config.json` is the only active
model/provider config, while sessions are stored under
`~/.darwin/sessions/<readable-project-key--sha256>/`. Permission allow-rules are not global:
they live under `~/.darwin/projects/<project-key>/permission-rules.json` and apply only to that
canonical working directory. Existing project rules and sessions are read as migration sources
and copied to user state on first write/resume; repository files are left untouched.

Agents, commands, skills, hooks, and MCP support both global and project layers. Valid project
names override global names; built-ins remain reserved. Hook order is global Pre, project Pre,
permission/tool, project Post, global Post. MCP merges `~/.darwin/mcp.json` with
`.darwin/mcp.json` (or root `.mcp.json` when absent), with project server names winning.
