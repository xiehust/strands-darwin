# darwin

A terminal coding agent built on the [Strands Agents TypeScript SDK](https://www.npmjs.com/package/@strands-agents/sdk): you talk to it in a TUI, it reads and edits files and runs commands in your repository, and it asks before doing anything that changes your machine.

## The experiment

This is an experimental project in self-hosted AI development.

**v0.0.1 — the [baseline release](../../releases/tag/v0.0.1) — was built entirely with
[Claude Code](https://claude.com/claude-code).** From this point on, darwin develops
itself: every subsequent feature, fix, and release is made by running darwin inside its
own repository (the Trellis task history under `.trellis/` is the paper trail). The name
is the thesis — evolution by iteration, with the tool as its own selection pressure. The
baseline exists so there is always a fixed point to measure that evolution against.

```
darwin
bedrock/us.anthropic.claude-sonnet-4-6 · session session-20260813-112430
AGENTS.md: loaded (1.2 KB)
skills: commit-message — type / to use one
/exit to quit · ctrl+c cancels a turn

you
  node test.js fails. Find the bug, fix it, then run the test to confirm.

agent
  Let me read the file first.
✓ fileEditor view: /repo/greet.js

┌─ permission required (write)
│ fileEditor str_replace: /repo/greet.js
│
│ Replace:
│     return 'Hello, ' + nam + '!';
│ With:
│     return 'Hello, ' + name + '!';
└─
  allow? y / n (esc denies)
```

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
pnpm start            # new session
pnpm start --resume   # continue where you left off
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

Capture that id to select the same persisted conversation later with `--session <id>`.
`--session` is strict: the id must use lowercase letters, numbers, hyphens, or underscores and
must already have a persisted snapshot in this project. It takes precedence over `--continue`
or the compatible `--resume` alias. `--continue` follows `.darwin/last-session.json` (or starts
a new conversation when no pointer exists).

Headless mode cannot ask for approval, so its default permission bridge immediately denies any
call that reaches it. Static-safe calls and persisted allow-rules still run; use
`--permission-mode auto`, `--permission-mode yolo`, or `--yolo` when those existing semantics
are appropriate for automation. A denied tool is not itself a failed process if the model
handles the denial and completes. Exit status is zero only after the turn, snapshot, resume
pointer, and runtime cleanup succeed. SIGINT cancels and exits nonzero.

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
> `config.json` to `.darwin/config.json` and `skills/` to `.darwin/skills/`. Old
> `.strands-tui/` sessions cannot be resumed — the snapshot path contains the agent id,
> which changed with the name — so delete that directory.

Keys:

| Key | Effect |
|---|---|
| `Enter` | send |
| `y` / `n` / `Esc` | answer a permission prompt (`Esc` denies) |
| `/` | list skills; `↑`/`↓` to pick, `Tab` or `Enter` to complete |
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

The assembled prompt always has the same three parts, in this order:

```
<base prompt>                                  ← darwin's default, or your override
<project-instructions source="AGENTS.md">…     ← your repository's standing rules
<available-skills>…                            ← the skills catalogue
```

Only the **base** is overridable, and an override replaces it entirely — nothing of the
default is kept. AGENTS.md and the skills list are appended either way, so repository rules
stay additive and you never have to restate them in a custom prompt.

Two ways to override, highest precedence first:

1. `"systemPrompt"` in `.darwin/config.json` — for short prompts.
2. `.darwin/system-prompt.md` — a plain Markdown file, for prompts too long to be
   comfortable inside JSON. Commit it and the whole team gets the same agent.

The header tells you which one is in effect, because a replaced prompt changes how the
agent behaves and that should not be invisible. A `system-prompt.md` that exists but is
empty or unreadable does not stop the session: darwin falls back to the default and says
why in the header, so you never go on believing your prompt is steering the agent. A blank
`systemPrompt` in the config is a startup error instead — leaving the agent with no
instructions at all is never what someone meant to configure.

## Configuration

`.darwin/config.json` in the project root. Every field is optional — with no file at all
you get a working Bedrock setup.

```json
{
  "provider": "bedrock",
  "model": "us.anthropic.claude-sonnet-4-6",
  "region": "us-west-2",
  "maxTokens": 8192,
  "summaryRatio": 0.3,
  "preserveRecentMessages": 10,
  "permissionMode": "default",
  "promptCache": true,
  "thinkingEffort": "high"
}
```

| Field | Default | Notes |
|---|---|---|
| `provider` | `bedrock` | `bedrock`, `anthropic` or `openai` |
| `model` | `us.anthropic.claude-sonnet-4-6` | provider-specific model id |
| `region` | `AWS_REGION`, else `AWS_DEFAULT_REGION`, else `us-west-2` | Bedrock only |
| `apiKeyEnv` | — | name of the env var holding the API key |
| `maxTokens` | `8192` | |
| `summaryRatio` | `0.3` | fraction of old messages summarized on context overflow |
| `preserveRecentMessages` | `10` | messages the summarizer always keeps verbatim |
| `permissionMode` | `default` | `default`, `auto` or `yolo` — see [Permissions](#permissions) |
| `permissionRules` | — | wildcard rules that pre-approve calls; written by the prompt's "always allow" — see [Remembering an answer](#remembering-an-answer) |
| `promptCache` | `true` | prompt caching, Claude only — see [Prompt caching](#prompt-caching) |
| `promptCacheTtl` | provider default (5m) | `5m` or `1h`, applied to every cache point |
| `thinkingEffort` | `high` | how hard the model thinks — `low`, `medium`, `high`, `xhigh`, `max`; changeable with `/effort` — see [Thinking effort](#thinking-effort) |
| `classifierModel` | per provider | model id for `auto` mode's safety classifier |
| `systemPrompt` | built-in prompt | replaces the base system prompt; wins over `.darwin/system-prompt.md` — see [System prompt](#system-prompt) |

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
back to `.darwin/config.json` so it survives a restart:

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
request; it is also available while a turn streams. Darwin adds a dim transcript notice as
each task succeeds, fails, or is stopped, including failure exit metadata when available.
Standard output and standard error are combined in
`.darwin/sessions/<session-id>/background/<task-id>.log`; the absolute path is included
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

darwin runs in one of three approval modes, set by `permissionMode` in
`.darwin/config.json` or per run with `--permission-mode <mode>` (`--yolo` is shorthand):

| Mode | Behaviour |
|---|---|
| `default` | statically *provably safe* calls run silently; everything else prompts |
| `auto` | like `default`, but a model classifier judges the calls static rules could not clear — only classifier-flagged calls prompt |
| `yolo` | nothing prompts (the header warns you) |

"Provably safe" is a whitelist, checked against both the tool's name and its arguments
(one tool can span read and write):

| Call | Statically safe? |
|---|---|
| `fileEditor` with `command: view`, `load_skill`, `bash` restart | yes |
| `fileEditor` writes inside the project — except `.git/` internals, `.env*`, and `.darwin/config.json` | yes |
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
`.darwin/config.json`, so matching calls stop asking — in this session and every later one.
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
`.darwin/config.json` and to `.env*` files are covered by **no** rule at all — otherwise a
broad rule would let the agent grant itself more of them. And nothing is remembered
implicitly: a plain `y` stays a one-time answer.

Edit or delete rules by editing the file; an unparseable rule is a startup error rather
than a rule that silently never matches.

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
notice it as a lower server count in the header. A file that cannot be parsed at all is a
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
"what this is for and when to use it". `name` defaults to the directory name. Files under
`scripts/`, `references/` and `assets/` are listed to the model when the skill loads, so
instructions can point at them.

Two ways a skill gets used:

- **The model decides.** Only names and descriptions go in the system prompt; when a
  request matches, the model calls `load_skill` to read the rest. This progressive
  disclosure is what keeps many skills affordable.
- **You decide.** Type `/commit-message` (optionally with a request after it) and the
  skill's full text is sent with your message.

A malformed skill is reported at startup and skipped; the rest still load.


### Built-in developer supervisor

`developer` is bundled with darwin, so it is advertised even when the target repository has
no `.darwin/skills/`. Invoke it with a delegated requirement after the command:

```text
/developer Fix the arithmetic defect, run node test.mjs, and show the diff.
```

The Host remains in the interactive conversation and supervises a separate headless darwin.
It first asks the child for a plan, reviews questions and escalates unresolved product choices
to you, then explicitly approves or corrects the plan. Planning processes carry
`DARWIN_PLANNING_ONLY=1`, which target repositories may enforce in PreToolUse hooks. Every
child invocation is launched as a managed background `bash start` job, monitored with `status`
and incremental `output`; type `/tasks` while the Host turn is streaming to inspect those jobs
without interrupting it.

Two ids participate and are not interchangeable:

- `bg-…` identifies one short-lived managed process and is used by `bash status`/`output`;
- the exact `session: session-…` stderr record identifies the child's persisted conversation.
  Every follow-up uses `--session <captured-id>`; it never relies on `--continue`, the resume
  pointer, or a background id.

Headless children have no person available to answer permission prompts. Safe calls and existing
allow-rules still work; an elevated mode such as `--yolo` is appropriate only when you explicitly
authorized it for the named repository and scope. The Host does not silently patch over a child
failure: it independently inspects the diff and runs the requested checks, then either sends a
focused correction to the same child session or reports the blocker. Its final report includes
the child session id, background outcomes, acceptance evidence, and unresolved risks.

A project skill cannot replace this built-in name. A case-insensitive `developer` collision is
skipped and reported with the other skill problems.

## Subagents

The main agent has a `subagent` tool for delegating a self-contained task to a fresh child
agent. Child work has its own conversation: reasoning, intermediate messages and tool calls
stay out of the main transcript, and only the final report comes back as the tool result. The
built-in `general` agent is always available and is suitable for broad code searches,
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

## Sessions and `--resume`

Each session is snapshotted after every turn under `.darwin/sessions/`, with
`.darwin/last-session.json` pointing at the most recent one. Sessions live beside the
repository rather than in your home directory because a coding conversation belongs to one
repository — that scopes `--resume` per project for free. Both paths belong in your
`.gitignore`.

`pnpm start --resume` reopens the last session and restores its history. If there is
nothing to resume it quietly starts fresh.

Note that the snapshot path includes the agent id, so changing `AGENT_ID` in
`src/agent/runtime.ts` orphans existing sessions.

## Known limitations

- **Input is single line.** Ink delivers Enter as a keypress rather than a newline, so
  multi-line editing would need a separate submit binding plus wrapping and cursor
  handling. Pasted multi-line text is accepted and submitted at the first newline.
- **Streamable HTTP MCP is configured but not live-tested.** The configuration path is
  verified; no public HTTP MCP server was available to connect to. stdio is tested
  end to end.
- **The permission prompt is not a diff.** It shows the tool's own arguments — for
  `str_replace` that is the old and new text, which is usually enough, but it is not a
  computed diff against the file on disk.
- **No sandboxing.** `bash` runs commands directly on your machine. The confirmation
  prompt is the only thing between the model and your shell.
- **No autonomous scheduler or agent swarm.** The optional built-in developer workflow supervises one external headless child through existing sessions and managed bash jobs; it does not add another in-process agent loop.

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
pnpm tsx spike/verify-skills.ts                            # project and built-in skill discovery, no model calls
pnpm tsx spike/verify-headless.ts                          # parser/output/session contracts with counted assertions
pnpm tsx spike/verify-agents-md.ts                         # AGENTS.md loading, truncation, prompt order, no model calls
pnpm tsx spike/verify-system-prompt.ts                     # default prompt, override precedence, fallbacks, no model calls
pnpm tsx spike/verify-permission-modes.ts                  # risk rules and per-mode gate decisions, no model calls
pnpm tsx spike/verify-prompt-cache.ts                      # cache decisions, config surface, cache-point placement, no model calls
AWS_REGION=us-west-2 pnpm tsx spike/verify-classifier.ts   # auto mode's safety classifier, live verdicts
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts  # cache tokens written, then read
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts     # agent core, permissions, resume, AGENTS.md injection
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts          # real stdio MCP server
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts  # both skill trigger paths
AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts # opt-in Host → persistent child workflow
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts          # the TUI, driven through a pty
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts      # real git repo, read → fix → test
```

The TUI suites take a scenario name to run just one, e.g.
`pnpm tsx spike/verify-tui.ts approve` (scenarios: `approve`, `deny`, `safePassthrough`,
`bashExit`, `cancelThenContinue`, `completion`, `agentsMd`). They need a real pty (Ink requires raw mode);
`spike/tui-driver.ts` provides it.
