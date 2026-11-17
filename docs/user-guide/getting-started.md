# Getting started and providers

**English** · [简体中文](getting-started.zh-CN.md) · [Guide index](README.md)

## Requirements and installation

- Node.js `>=22.0.0`.
- npm, for the global install below. Developing darwin itself uses pnpm (the repository's lockfile is pnpm's).
- Credentials for the selected provider; AWS is the default.

```bash
npm install -g strands-darwin
darwin --version      # darwin <version>
darwin doctor         # offline read-only diagnostics; exit 1 on problems
```

The registry package is `strands-darwin`; the command is `darwin`. The package's `postinstall` script runs `patch-package` to apply darwin's pinned Strands SDK patch (shipped as `dist/patches/@strands-agents+sdk+1.25.0.patch`), so install with scripts enabled. If they were skipped — `npm install --ignore-scripts`, or an unsupported installer — `darwin` refuses to start before any model call, with one message that names the missing patch and this fix: `npm install -g strands-darwin`.

`pnpm add -g strands-darwin` is unsupported: pnpm blocks a dependency's build scripts by default (the `postinstall` lands in `ignoredBuilds`), and even with `--allow-build` its isolated layout places the SDK beside the package, where `patch-package` cannot find it.

### Check for updates and upgrade

```bash
darwin update             # query npm now; report installed/latest versions only
darwin update --install   # explicitly install a newer version
```

Manual checks query the official npm registry once with a 5-second timeout, bypassing the
startup notice's 24-hour cache and off switches. They also work in a source checkout and
never read model config or start a session. Registry errors are reported with exit 1;
invalid arguments exit 2. A successful check exits 0 whether or not an update is available.

`--install` supports POSIX npm global installations only. It refuses source checkouts/links
and a package that does not match `npm prefix -g`, rather than overwriting another install.
It installs the exact version just checked into that same prefix using the user's npm
configuration, then runs the installed CLI's `--version` before reporting success. No
`sudo`, downgrade, automatic retry or rollback is attempted. Timeout (10 minutes) or
Ctrl+C stops the npm process group and reports that installation may be incomplete.
Restart other Darwin sessions after upgrading. For a source-linked CLI, update the
checkout and run `pnpm build` instead. Existing SDK patch preflight still applies; an
unpatched installation must be repaired with the manual npm command shown in its refusal.

### Bash completion

Generate a file at a path you choose, inspect it, then load it into your current Bash:

```bash
darwin completion bash > darwin-completion.bash
source ./darwin-completion.bash
```

For persistent use, move the reviewed file to a stable location and manually add `source /your/chosen/path/darwin-completion.bash` to your Bash startup file. Darwin does not install completion or edit startup files. Regenerate and reload after upgrading; remove it from the current shell with `complete -r darwin`.

Only Bash is supported. The generated source suggests static commands, nested verbs, applicable options and fixed values (for example `--permission-mode plan` and `--output-format stream-json`). Prompts, IDs, rules, URLs, credentials, server names, paths and numbers receive no suggestions; no filename fallback runs. A prompt such as `-p trajectory` stays a prompt. Completion uses Bash builtins only, never invokes darwin or discovers files, config, sessions or MCP state. Unknown contexts return no candidates. It is a grammar aid, not a validator of free-form values; repeated options are conservatively omitted. Print-only flags still require `-p` when executing, even when entered before it.

Generation is local and write-free (apart from your explicit shell redirection): no runtime/config/session/hook/MCP startup. The SDK patch-marker preflight still runs first. `darwin -- completion bash` is equivalent; missing/unknown shells or extra operands exit 2. Help/version keep their precedence. See the [CLI reference](reference.md#cli).

### Developer path: run from a clone

```bash
git clone https://github.com/xiehust/strands-darwin.git
cd strands-darwin
pnpm install          # applies the SDK patch through pnpm-workspace.yaml patchedDependencies
pnpm start            # runs the TypeScript source in place, no build needed
```

`node-pty` is a native dev dependency used for real PTY tests. pnpm builds only native packages allowed by the workspace, and it is already listed in `pnpm-workspace.yaml`. Extend that list if you add another native dependency.

### Global `darwin` command from a clone

To get a `darwin` on your `PATH` that tracks the clone, build first and then link it globally:

```bash
pnpm build            # emits dist/: the CLI (bin points at dist/src/cli.js), the built-in skills, dist/patches/
pnpm add --global .
```

The global package is linked to this clone, so keep the directory after installing. When you change the source, re-run `pnpm build` to refresh the linked `dist/`.

### Troubleshooting the global command

If `darwin` fails to start with `Error: Cannot find module '.../pnpm/global/v11/<hash>/node_modules/strands-darwin/dist/src/cli.js'`, the global shim is pointing at a stale pnpm store entry — usually after the clone was moved, an interrupted reinstall, or a pruned global store. `pnpm build` succeeding and `node dist/src/cli.js` running fine while the `darwin` shim fails is the tell. Re-register the global package against the current clone:

```bash
pnpm remove --global strands-darwin   # ignore "not found in global packages"; the shim is stale
pnpm build
pnpm add --global .
darwin doctor                 # verify: offline read-only diagnostics, creates nothing, exit 1 on problems
darwin sessions               # verify: read-only, makes no model call
```

`darwin doctor` is also the first thing to run when a session refuses to start or an extension seems missing: it prints the same config, MCP, skills, hooks and system-prompt findings the startup loaders would, without a session, a model call or an MCP connection, and marks each problem with `!`.

## The working directory is the project

Run darwin from the repository it should edit. The CLI's current working directory resolves all project-scoped instructions and extensions:

```text
<your repo>/
├── AGENTS.md                    # optional standing project instructions
├── .mcp.json                    # root MCP fallback
├── .agents/                     # portable agents/commands/skills/hooks
└── .darwin/
    ├── system-prompt.md         # optional replacement base prompt
    ├── mcp.json                 # project MCP config; preferred over .mcp.json
    ├── agents/                  # child-agent definitions
    ├── commands/                # custom slash commands
    ├── hooks/                   # direct hook JSON files
    └── skills/                  # one folder per skill
```

Personal settings and generated state live under `~/.darwin/`, not in the target repository. See [Sessions and state](sessions-and-state.md).

## Migrate local prompt content

Before starting a session, run `darwin import --from claude-code` from the target project. It prints source and destination paths without changing files or starting a model, hook, MCP server or session. On Linux, `darwin import --from claude-code --apply` copies only supported prompt content; review every manual item first. No provider credentials are needed. Your Claude Code files remain unchanged; chats/history and executable policy are not imported. See [mappings, collisions and limits](extensions.md#import-a-claude-code-setup). You can also keep using the existing root `CLAUDE.md` fallback without importing anything; `@path` imports are not expanded.

## Start and resume

```bash
pnpm start                          # new TUI session
pnpm start --resume                 # last session in this project; fresh if none
pnpm start --resume <id>            # strict named resume
pnpm start --session <id>           # the same strict named-session path
pnpm tsx src/cli.ts sessions        # restorable sessions, read-only
```

A bogus or other-project ID is refused rather than falling back. `--session` takes precedence over compatible bare `--resume`/`--continue`; combining it with `--resume <id>` is a usage error. One conventional leading `--` is accepted, so `pnpm start -- --yolo` and `pnpm start --yolo` are equivalent.

## Default model catalogue

The only active config is `~/.darwin/config.json`; `.darwin/config.json` is not read. With no file, darwin starts with `global.anthropic.claude-opus-5` and offers these built-ins through `/model`:

- `claude-sonnet-5`
- `claude-haiku-4.5`
- `claude-fable-5`
- `claude-opus-5`
- `gpt-5.6-sol` through Bedrock Mantle

Bedrock Claude entries leave `region` unset so `AWS_REGION` can choose it. The Mantle entry is pinned to `us-east-1`, where that model is served. A custom `models` array replaces, rather than extends, the built-in catalogue.

## Amazon Bedrock

Bedrock uses the standard AWS chain: environment, shared config, then instance role. Claude model IDs must be cross-region inference profiles. Bare `anthropic.*` IDs are rejected; use a `us.`, `eu.`, `apac.`, or `global.` prefix.

```bash
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[?contains(inferenceProfileId, `anthropic`)].inferenceProfileId'
```

Region resolution is `region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-west-2`.

## Direct Anthropic

Anthropic support is installed. Set `apiKeyEnv` to your key's environment-variable name or use `ANTHROPIC_API_KEY`; with neither, darwin refuses to start and names both.

Any Anthropic Messages API-compatible endpoint (gateway, proxy, relay) is reached through `baseUrl`, which must be an `http:` or `https:` URL. Without it darwin uses `ANTHROPIC_BASE_URL`, then the client's default `https://api.anthropic.com`. `baseUrl` is also supported by direct OpenAI, but refused on Bedrock and the OpenAI AWS endpoint switches.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "baseUrl": "https://gateway.example.com",
  "apiKeyEnv": "ANTHROPIC_API_KEY"
}
```

## OpenAI and Bedrock Mantle

OpenAI support is installed. Direct access uses `OPENAI_API_KEY` by convention, or the variable named by `apiKeyEnv`. `openaiApi` is `chat` by default or `responses` for models that require Responses.

With `provider: "openai"` and `bedrockMantle: true`, darwin uses AWS credentials and Bedrock's OpenAI-compatible endpoint. Omit `apiKeyEnv`; the two are mutually exclusive. Mantle's model catalogue varies by region and is not Bedrock's ordinary catalogue:

```bash
pnpm tsx spike/probe-mantle-catalog.ts us-east-1 us-west-2
```

With `provider: "openai"` and `bedrockRuntime: true`, darwin instead talks to the ordinary Bedrock runtime endpoint's OpenAI-compatible surface (`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`) with the same AWS credentials. Name a cross-region inference profile as the model (`global.openai.gpt-6-astra`, `us.openai.gpt-6-astra`); the built-in `gpt-6-astra` preset uses this route, which is priced below Mantle's in-region rate. `bedrockRuntime`, `bedrockMantle` and `apiKeyEnv` are mutually exclusive.

## OpenAI gateways with a login helper

Direct OpenAI accepts `baseUrl` (otherwise `OPENAI_BASE_URL`, then the client default).
For gateways needing a rotating bearer token and an identity header, use a user-installed
helper such as llmar. Sign in outside Darwin first (`llmar login`; SSH supports
`llmar login --no-browser`). Darwin does not open a browser, register OAuth clients,
or maintain a second refresh-token store.

```json
{
  "provider": "openai",
  "name": "llmar",
  "model": "auto",
  "openaiApi": "responses",
  "baseUrl": "https://your-gateway.example.com/inference/v1",
  "headersCommand": {
    "command": "/home/ubuntu/bin/llmar",
    "args": ["headers"],
    "timeoutMs": 15000,
    "refreshIntervalMs": 240000
  },
  "contextWindowLimit": 1000000,
  "contextWarnRatio": 0.7
}
```

Replace the URL and executable path with yours. Configure the base through `/v1`, not
`/responses`; the SDK appends the resource path. In a `models` array, put model fields
in the entry and keep `contextWarnRatio` at the root. The window is a client declaration,
not a gateway guarantee; `0.7` recommends `/compact`, **not automatic compaction**.
Darwin sends `reasoning.effort` (default `high`); `auto` must accept it and the configured
output budget. In `auto` permission mode, also choose a gateway-supported `classifierModel`;
OpenAI's default classifier is `gpt-4o-mini`, not the main model's `auto` id.

The helper contract is deliberately narrow:

- `command` is an absolute executable path (at most 4096 characters); no shell or
  expansion. `args` defaults to `[]`, at most 32 strings of at most 4096 characters.
- `timeoutMs` defaults to `15000`, integer `1–60000`; `refreshIntervalMs` defaults to
  `240000`, integer `1–3600000`. Refresh is lazy, not a background timer.
- stdout must contain `Authorization: Bearer <token>` and optionally `x-api-key: <token>`,
  one line each, case-insensitive names, LF or CRLF. No other headers or duplicate names.
  Total output is capped at 16 KiB, each value at 8192 characters. Stderr is discarded.
  Client logs are disabled; HTTP error responses are capped at 64 KiB and have active
  credential values redacted before SDK error handling. Thrown SSE errors are also redacted,
  and helper failures retain their sign-in/restart explanation through SDK wrapping;
  successful content and stream events are unchanged.
- The helper inherits the user's environment with the `DARWIN` marker, has stdin closed,
  and runs from the executable's directory, not the project. On POSIX a timed-out or
  cancelled helper's process group is killed; Windows kills the direct child only.
- Headers stay in memory, outside model configuration/history. Models built from the same
  validated configuration share a single in-flight refresh and success cache. Cancelling
  one waiter does not cancel siblings; the last waiter cancelling kills the helper.
- A helper failure blocks further attempts for that configuration: sign in or repair the
  helper and restart Darwin. Expired credentials are never used as a fallback. HTTP 401
  does not trigger a refresh/replay; there is no helper-owned retry loop.
- An explicit HTTPS `baseUrl` is required (loopback HTTP allowed for local tests), without
  URL credentials, query or fragment. Authenticated requests cannot leave its origin/path
  prefix, and redirects are forbidden. `apiKeyEnv`, `bedrockMantle`, and `bedrockRuntime`
  cannot join `headersCommand`; ambient `OPENAI_API_KEY` is not a fallback.

`llmar headers` currently puts the same access token into both headers. Check that your
particular gateway accepts that contract; it is not equivalent to maintaining an independent
Codex `gateway_oauth` session. Never paste helper output or refresh tokens into a prompt.

## Minimal examples

```json
{
  "provider": "bedrock",
  "model": "global.anthropic.claude-opus-5",
  "permissionMode": "default"
}
```

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "apiKeyEnv": "OPENAI_API_KEY",
  "openaiApi": "responses"
}
```

See [Configuration and context](configuration.md) for every field and multi-model configuration.

## Upgrade from the pre-rename layout

Old paths are no longer read. Move `config.json` to `~/.darwin/config.json` and skills to `.darwin/skills/`. Old `.strands-tui/` sessions cannot resume because the snapshot path contains the renamed agent ID; delete that directory.
