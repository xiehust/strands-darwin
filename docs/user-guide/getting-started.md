# Getting started and providers

**English** · [简体中文](getting-started.zh-CN.md) · [Guide index](README.md)

## Requirements and installation

- Node.js `>=20.3.0`.
- pnpm. npm can install the package, but this repository's lockfile is pnpm's.
- Credentials for the selected provider; AWS is the default.

```bash
git clone https://github.com/xiehust/strands-darwin.git
cd strands-darwin
pnpm install
pnpm start
```

`node-pty` is a native dev dependency used for real PTY tests. pnpm builds only native packages allowed by the workspace, and it is already listed in `pnpm-workspace.yaml`. Extend that list if you add another native dependency.

### Global `darwin` command

`pnpm start` runs the TypeScript source in place and needs no build. To get the `darwin` executable on your `PATH`, build first and then install globally:

```bash
pnpm build            # emits the CLI to dist/; bin points at dist/src/cli.js
pnpm add --global .
```

The global package is linked to this clone, so keep the directory after installing. When you change the source, re-run `pnpm build` to refresh the linked `dist/`.

### Troubleshooting the global command

If `darwin` fails to start with `Error: Cannot find module '.../pnpm/global/v11/<hash>/node_modules/darwin/dist/src/cli.js'`, the global shim is pointing at a stale pnpm store entry — usually after the clone was moved, an interrupted reinstall, or a pruned global store. `pnpm build` succeeding and `node dist/src/cli.js` running fine while the `darwin` shim fails is the tell. Re-register the global package against the current clone:

```bash
pnpm remove --global darwin   # ignore "not found in global packages"; the shim is stale
pnpm build
pnpm add --global .
darwin sessions               # verify: read-only, makes no model call
```

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

Install the SDK's optional peer before selecting `provider: "anthropic"`:

```bash
pnpm add @anthropic-ai/sdk
```

Set `apiKeyEnv` to your key's environment-variable name or use `ANTHROPIC_API_KEY`.

## OpenAI and Bedrock Mantle

OpenAI support is installed. Direct access uses `OPENAI_API_KEY` by convention, or the variable named by `apiKeyEnv`. `openaiApi` is `chat` by default or `responses` for models that require Responses.

With `provider: "openai"` and `bedrockMantle: true`, darwin uses AWS credentials and Bedrock's OpenAI-compatible endpoint. Omit `apiKeyEnv`; the two are mutually exclusive. Mantle's model catalogue varies by region and is not Bedrock's ordinary catalogue:

```bash
pnpm tsx spike/probe-mantle-catalog.ts us-east-1 us-west-2
```

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
