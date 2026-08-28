# Extensions

**English** · [简体中文](extensions.zh-CN.md) · [Guide index](README.md)

## Discovery and precedence

Named skills, agents, and commands resolve after built-in reservations in this order:

1. project `.darwin/`
2. project `.agents/`
3. global `~/.darwin/`
4. global `~/.agents/`

The first valid case-insensitive name wins; project resources override global ones, while required built-in names remain reserved. Invalid optional resources are skipped and reported rather than stopping valid siblings.

Native direct hook files merge as wrappers: global `.agents`, global `.darwin`, project `.agents`, project `.darwin` for Pre and observation-only lifecycle events; exact reverse for Post. Legacy `.darwin/hooks.json` and config-embedded hooks are fallbacks only when a layer has no direct hook JSON directory. Direct global/project `.agents/hooks.json` is a separate Codex-compatible portable source ordered before that `.agents/hooks/*.json` layer; `.codex/hooks.json` is deliberately never loaded.

## MCP servers

Project MCP comes from `.darwin/mcp.json`, falling back to root `.mcp.json` in Claude Code format. Global `~/.darwin/mcp.json` can also contribute; project server names win. The effective/ignored paths are visible in `/mcp`.

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

`command` means stdio; `url` means streamable HTTP; set `transport: "sse"` explicitly for SSE. `${VAR}` and `${env:VAR}` interpolate in command, args, env, URL, and headers. Entries support `disabled`, `prefix`, and `toolFilters`.

Tools are normally registered as `<serverName>_<toolName>` to prevent collisions. Set `prefix: ""` for bare names, accepting collision risk, or choose a shorter custom prefix. MCP tools are unknown to static safety and always require approval outside `yolo`.

`.darwin/mcp.json` is gitignored because headers/env often contain tokens. Prefer interpolation before deciding to commit it. One server startup failure or unset variable skips that server; a whole-file parse error stops startup. `/mcp` reports configured names, connection state, bounded tool names/counts, and effective/ignored files without calling `listTools()`, connecting, or retrying. A failed server needs restart to retry.

If an `npx` server says `Connection closed`, remove `devEngines.packageManager` from project `package.json` or set another `cwd`; `npx` may be failing with `EBADDEVENGINES` before MCP can report it.

## Skills

A skill is an instruction folder:

```text
.darwin/skills/commit-message/
├── SKILL.md
├── references/types.md
└── scripts/
```

```markdown
---
name: commit-message
description: Write commit messages following this project's conventions. Use when asked for a commit message.
---

# Commit message conventions
```

`description` is required and is the only body information advertised before loading; `name` defaults to the directory. Darwin supplies accepted definitions to official SDK `AgentSkills`. The SDK parses frontmatter/body, activates skills, and lists `scripts/`, `references/`, and `assets/` to three levels/20 files with explicit truncation.

Resource roots are safety-preflighted up to 200 entries. Root/nested symlinks are accepted only while their real paths remain under the resolved skill root, and are checked again at use time.

The model calls safe `load_skill({name})` when relevant; the SDK-native `skills()` tool remains private. A user can invoke `/skill-name <request>` to send the full skill with the request. Malformed optional skills skip; required built-ins are fatal.

## Built-in workflows

### `developer`

`/developer <requirement>` keeps the Host in the interactive conversation while one managed headless darwin child owns planning, implementation, checks, spec updates, and authorized commits. It launches through `bash start` and always uses `--yolo` because headless children cannot answer prompts. Oversized-result offload is default-on; the compatible `--context-offload` flag force-enables that safety if config explicitly opts out. No model-call budget is used unless explicitly requested.

A `bg-…` ID identifies a process task; the exact `session: session-…` line identifies the persistent child conversation. Corrections use that session explicitly, never `--continue`. The Host drains output, inspects the diff, and independently reruns acceptance; it never hides a child failure with a Host-side patch. Independent reads/checks are batched, dependent writes are serialized, and verification follows a pyramid: focused checks while editing, one child full gate after source settles, then one independent Host full gate. A concrete acceptance failure gets one focused correction in the same captured child session; broad correction history may be compacted first. It reports task/session IDs, checks, spend, and risks. In this repository every accepted batch is appended to `docs/iteration-log.md`.

### `self-evolution-research`

This core workflow is described first in the [root README](../../README.md). It advances `in-progress` backlog work first, then ranked `not-started` work; only an empty unfinished queue permits a fresh draw. That draw runs exactly once with shares `peer=50%`, `tui=20%`, `open=15%`, `sdk=10%`, `observability=5%`. The script draws uniformly over exact half-weight units and records the raw draw and weights; the first draw is binding and cannot be rerolled because it looks unproductive. It deliberately exposes no seed that could be searched for a preferred outcome. User `--path` overrides are labelled user-directed, never random.

The peer path compares primary evidence from Claude Code, Codex, DeepSeek harness, PenguinHarness, and other relevant products with darwin's current implementation. Self-review paths use repository evidence instead of padding a peer table. Each UTC report follows [`docs/research/research_template.md`](../research/research_template.md), appends to `docs/research/research_<YYYY-MM-DD>.md`, proposes at most five nonduplicates, and scores:

```text
Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk
MINIMUM_IMPLEMENTATION_SCORE = 6
```

Qualifying directions form one ordered batch. Each gets a fresh `developer` child on the newest accepted darwin revision and independent Host acceptance. Only accepted work is `done`; blockers stay `in-progress`; `abandoned` requires score gate or explicit recorded decision. Batch halt reasons are exhausted work, repeated acceptance failure, falsified premise, human-only decision, unrestorable starting point, or no remaining worthwhile work.

### `self-reflection`

`/self-reflection` locates the current (or explicitly named) project trajectory, verifies its last-input preview, and sends read-only analysis to a managed headless worker. It writes exactly one `docs/reflections/reflection_<UTC-date>_<session-id>.md`: completion grade (Perfect/High/Medium/Low), process observations, and evidence-cited Darwin improvements. Suggestions use self-evolution scoring; qualifying entries receive stable `SRF-NNN` backlog IDs. Reflection does not implement them.

## Subagents

The built-in `general` child is always available. Specialists are direct Markdown files under `.darwin/agents/`:

```markdown
---
name: explorer
description: Searches a large code area and returns an evidence-based map.
tools:
  - bash
  - fileEditor
---

Trace the requested behavior, cite files and symbols, and report to the parent.
```

Required: valid unique non-`general` name (`[A-Za-z0-9_-]+`), description, nonempty body. Omit `tools` for all child-eligible tools, use `tools: []` for none, or exact case-sensitive registered names. Unknown tools or malformed/duplicate/unreadable definitions skip. Definitions load once at startup.

Children have fresh model/context, no parent messages, no persisted session, and no recursive `subagent`. Later children use the currently selected model. Tool restrictions are not permission grants: child calls use the shared gate/rules. Delegation itself is safe. Ctrl+C cancels child with parent and its bash session is reaped.

Multiple subagent calls in one assistant message run concurrently. Permission prompts remain serialized and source-labelled. `/agents` lists only this run's dispatch metadata, never child transcripts. Parallelism is for read-heavy work: children share one unisolated working tree with no locks/conflict detection, so serialize mutation.

## Custom commands

Place Markdown under `.darwin/commands/` or global/portable counterparts. `/name arguments` sends the file body as the message, replacing `$ARGUMENTS` with text after the command. Built-ins remain reserved; command discovery follows the common precedence.

## Command hooks

Hook files accept exactly four event keys. `PreToolUse` and `PostToolUse` shell commands wrap model tool calls. Their order is global Pre → project Pre → permission/tool → project Post → global Post. In `plan`, denied writes/executes stop before Pre hooks.

`TurnComplete` and `PermissionRequest` are observation-only lifecycle commands. They run global `.agents` → global `.darwin` → project `.agents` → project `.darwin`, with files lexical inside each layer. Their group `matcher` is matched case-sensitively against the event source (`interactive` or `headless` for `TurnComplete`; `parent` or the bounded `<agent>#<dispatchId>` label for `PermissionRequest`). A matching command receives exactly one newline-terminated JSON object on stdin:

```json
{"event":"TurnComplete","outcome":"success","source":"interactive"}
{"event":"PermissionRequest","source":"parent"}
```

`TurnComplete.outcome` is `success`, `failure`, or `cancelled`. `PermissionRequest` fires once when a logical prompt actually becomes current; queued prompts wait and prompts withdrawn before display do not fire. Lifecycle commands start without blocking the turn or permission decision. Darwin discards their stdout, stderr, launch errors, and exit status; they cannot write into Ink, model context, permission decisions, tool events, or trajectory records. Cancel, `/clear`, and shutdown terminate their process groups with bounded TERM→KILL cleanup.


### Portable Codex-compatible hooks

Darwin also reads `~/.agents/hooks.json` and `<project>/.agents/hooks.json` using the Codex three-level JSON shape (`hooks` → matcher groups → handlers). It accepts the eleven documented event names: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and `Stop`. Matchers are regular expressions; omission, `""`, and `"*"` mean match all. Handlers are sequential `type: "command"` processes with project-root cwd, inherited environment, bounded JSON stdin/output, bounded `timeout`, optional `commandWindows`, and validated `additionalContextLimit`. Presentation metadata is inert.

Supported control is intentionally narrower than Codex where Darwin's safety contracts require it:

- `SessionStart`, `UserPromptSubmit`, `PostCompact`, and matching `SubagentStart` can add bounded invocation-local context. Literal submitted text remains the trajectory/recall/memory source; no system prompt, restored history, or child definition is rewritten.
- `UserPromptSubmit` block output or exit 2 refuses locally before trajectory/provider/tool work.
- `PreToolUse` deny/exit 2 and validated `allow + updatedInput` are supported after plan/retry guards and before final permission classification. `bash` also matches `Bash`; mutating `fileEditor` operations also match `apply_patch`, `Edit`, and `Write`.
- Manual `/compact` and headless `--compact-before` publish `PreCompact`/`PostCompact` with trigger `manual`; SDK automatic overflow recovery is not presented as Codex `auto` parity.
- `PermissionRequest`, `PostToolUse`, `SubagentStop`, `Stop`, and `SessionEnd` are observation/advisory projections. They cannot auto-allow, replace/retry/suppress a result, or continue a parent/child turn. `SubagentStop` omits the child transcript path and assistant text; only the ordinary bounded subagent result reaches the parent. Unsupported controls are reported through bounded existing notices/automation diagnostics without changing the owner.

The first adapter rejects `mcp_tool`, `prompt`, `agent`, and `async: true` handlers at startup. It does not read `.codex/hooks.json` or inline TOML, implement Codex trust/managed/plugin policy, add a `/hooks` browser, fabricate `turn_id`/transcript paths, or promise crash/idle `SessionEnd`. Commands are trusted executable repository policy when Darwin is launched in that repository; active parse/schema/regex errors fail startup.

Active hook files/directories are executable policy and cannot be covered by allow rules. Keep secrets out of committed hook config and prefer direct layered `hooks/*.json`; legacy files remain compatibility fallbacks.
