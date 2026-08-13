# strands-darwin

A terminal coding agent built on the [Strands Agents TypeScript SDK](https://www.npmjs.com/package/@strands-agents/sdk): you talk to it in a TUI, it reads and edits files and runs commands in your repository, and it asks before doing anything that changes your machine.

```
strands-darwin
bedrock/us.anthropic.claude-sonnet-4-6 · session session-20260813-112430
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

The agent treats the **current working directory** as the project root: it reads
`config.json`, `.mcp.json` and `skills/` from there, and stores sessions under
`.strands-tui/`. Run it from the repository you want it to work on.

Keys:

| Key | Effect |
|---|---|
| `Enter` | send |
| `y` / `n` / `Esc` | answer a permission prompt (`Esc` denies) |
| `/` | list skills; `↑`/`↓` to pick, `Tab` or `Enter` to complete |
| `Ctrl+C` | cancel the current turn; press again within 2s to quit |
| `Ctrl+D`, `/exit`, `/quit` | quit |

## Configuration

`config.json` in the project root. Every field is optional — with no file at all you get
a working Bedrock setup.

```json
{
  "provider": "bedrock",
  "model": "us.anthropic.claude-sonnet-4-6",
  "region": "us-west-2",
  "maxTokens": 8192,
  "summaryRatio": 0.3,
  "preserveRecentMessages": 10
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

## Permissions

Every tool call is classified from both its name and its arguments, so a single tool that
can both read and write is handled correctly:

| Call | Behaviour |
|---|---|
| `fileEditor` with `command: view` | runs, no prompt |
| `fileEditor` with `create` / `str_replace` / `insert` | **prompts** |
| `bash` with `mode: execute` | **prompts** |
| `bash` with `mode: restart` | runs, no prompt |
| `load_skill` | runs, no prompt |
| anything else, including all MCP tools | **prompts** |

The default is deliberately fail-closed: a tool nobody has classified is gated until
someone does so on purpose. Denying a call is not an error — the model is told the user
declined, and is instructed not to retry or work around it, so it explains itself and
asks what to do instead.

## MCP servers

Drop a `.mcp.json` in the project root. This is Claude Code's format, so an existing file
works unchanged:

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

Transport is inferred: `command` means stdio, `url` means streamable HTTP. Set
`transport` explicitly for `sse`. `${VAR}` and `${env:VAR}` are interpolated in commands,
arguments, environment, URLs and headers. Per-server `disabled`, `prefix` and
`toolFilters` are supported. No `.mcp.json` simply means no MCP.

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
under `skills/`:

```
skills/
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

## Sessions and `--resume`

Each session is snapshotted after every turn under `.strands-tui/` in the project, with
`.strands-tui/last-session.json` pointing at the most recent one. Sessions live beside
the repository rather than in your home directory because a coding conversation belongs to
one repository — that scopes `--resume` per project for free. Add `.strands-tui/` to your
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
- **Single agent.** No sub-agents or multi-agent orchestration.

## Development

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # the checks that need no model calls (config, skills)
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
pnpm tsx spike/verify-mcp-config.ts                        # .mcp.json error paths, no servers started
pnpm tsx spike/verify-skills.ts                            # filesystem and parsing, no model calls
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts     # agent core, permissions, resume
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts          # real stdio MCP server
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts  # both skill trigger paths
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts          # the TUI, driven through a pty
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts      # real git repo, read → fix → test
```

The TUI suites take a scenario name to run just one, e.g.
`pnpm tsx spike/verify-tui.ts approve` (scenarios: `approve`, `deny`, `bashExit`,
`cancelThenContinue`, `completion`). They need a real pty (Ink requires raw mode);
`spike/tui-driver.ts` provides it.
