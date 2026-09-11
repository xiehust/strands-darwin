# Configuration and context

**English** · [简体中文](configuration.zh-CN.md) · [Guide index](README.md)

`agentCoreMemory` is a root-only, default-off object (or `false`), independent of local `memory` and the model provider. Its complete field/namespace/SDK contract is in [Optional AgentCore Memory](agentcore-memory.md). Upload defaults off; user-submitted TUI preview/send remains available; `/cloud-memory auto` explicitly authorizes automatic uploads only for the current project. `upload: "manual"` requires trajectory and collects bounded original public tool text for future turns (all tool names, no secret-word/path filtering). Each paired action is at most 8 KiB; the serialized CreateEvent body is at most 256 KiB. Content can contain secrets: manual sending requires exact preview; auto mode is standing project consent, not a confidentiality guarantee. Existing immutable outboxes are never regenerated. Standalone CLI is read-only. Explicit `projectId` is lowercase, 1–64 characters; preferences are fetched once per runtime, then local revocations are rechecked.


## File forms and precedence

`~/.darwin/config.json` is the only active config. It may describe one model with fields at the root, or several models in `models`. In array form exactly one entry must have `"enable": true`; model fields live in each entry and session fields remain at the root. Names are case-insensitively unique. Custom entries replace the built-in catalogue.

```json
{
  "models": [
    {
      "enable": true,
      "name": "claude-opus-5",
      "provider": "bedrock",
      "model": "global.anthropic.claude-opus-5",
      "maxTokens": 64000,
      "promptCache": true,
      "thinkingEffort": "high"
    },
    {
      "enable": false,
      "name": "gpt-5.6-sol",
      "provider": "openai",
      "model": "openai.gpt-5.6-sol",
      "region": "us-east-1",
      "bedrockMantle": true,
      "openaiApi": "responses",
      "maxTokens": 64000,
      "thinkingEffort": "high"
    }
  ],
  "permissionMode": "default",
  "summaryRatio": 0.8,
  "preserveRecentMessages": 10,
  "contextWarnRatio": 0.8,
  "trajectory": true,
  "memory": true
}
```

A flat file intentionally exposes only one model to `/model`. `/model` persists the enabled array entry; `/effort` persists `thinkingEffort` on that entry.

## Model fields

| Field | Default | Contract |
|---|---|---|
| `models` | built-in catalogue when file absent | optional model array; exactly one `enable: true` |
| `enable` | — | array form only |
| `name` | model ID | short unique `/model` name |
| `provider` | `bedrock` | `bedrock`, `anthropic`, or `openai` |
| `model` | `global.anthropic.claude-opus-5` | provider-specific ID |
| `region` | AWS env, then `us-west-2` | Bedrock/Mantle region |
| `apiKeyEnv` | provider convention | environment variable containing direct API key |
| `baseUrl` | `ANTHROPIC_BASE_URL`, then `https://api.anthropic.com` | Anthropic only; `http(s)` URL of a Messages API-compatible endpoint |
| `bedrockMantle` | `false` | OpenAI provider via AWS's Mantle endpoint (`openai.*` catalogue ids); mutually exclusive with `apiKeyEnv` and `bedrockRuntime` |
| `bedrockRuntime` | `false` | OpenAI provider via the Bedrock runtime endpoint's `/openai/v1` surface (`us.openai.*` / `global.openai.*` inference profiles); mutually exclusive with `apiKeyEnv` and `bedrockMantle` |
| `openaiApi` | `chat` | `chat` or `responses` |
| `maxTokens` | `64000` | maximum output tokens |
| `contextWindowLimit` | SDK per-model table, else unknown | whole tokens; overrides the table for `/context`, `/status` and the context-pressure advice |
| `promptCache` | `true` | Claude only |
| `promptCacheTtl` | `1h` | `1h` or `5m` (the provider default) at every cache point; Bedrock and Anthropic |
| `thinkingEffort` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `classifierModel` | provider-specific cheap model | model used by `auto` permission mode |
| `requestTimeoutMs` | `180000` | Bedrock streaming idle timeout; arriving bytes reset it |

## Session fields

| Field | Default | Contract |
|---|---|---|
| `permissionMode` | `default` | `default`, `auto`, `plan`, `yolo` |
| `summaryRatio` | `0.8` | fraction of old messages summarized on overflow |
| `preserveRecentMessages` | `10` | messages kept verbatim by summarization |
| `contextWarnRatio` | `0.8` | post-turn `/compact` recommendation threshold; `0` disables |
| `contextOffload` | `true` | store oversized tool results beside the session, leaving a preview/reference; `false` opts out |
| `maxResultTokens` | `5000` | offload threshold; valid with default/explicit `true`, rejected with `contextOffload: false`, must exceed `1000` |
| `trajectory` | `true` | append every turn to trajectory |
| `diagnostics` | `false` | per-session SDK/darwin debug log |
| `memory` | true while trajectory is available | project memory; omitted follows `trajectory: false` |
| `memoryHorizonDays` | `28` | generated-memory age, integer `0–365`; `0` disables age only |
| `agentCoreMemory` | disabled | root cloud identity/config or `false`; [IDs, namespaces, preferences, upload and SDK requirements](agentcore-memory.md) |
| `projectOverrides` | — | strict map keyed by canonical working-tree SHA256; registered `agentCoreMemory.upload`, `autoDailyEvents`, `autoDailyBytes`, and command-owned `authorization` only; see below |
| `maxConcurrentSubagents` | `8` | ceiling on running child dispatches (`subagent` calls plus `workflow` nodes); positive integer; a call over it is refused before any model or child exists |
| `terminalBell` | `false` | ring the terminal bell on permission prompts and turn completion (interactive TUI only) |
| `terminalNotify` | `false` | ask the terminal for a desktop notification at the same two moments — one OSC 9 sequence (`ESC ] 9 ; darwin · <project> · waiting for approval\|turn complete ESC \`) straight to stdout, only when stdout is a TTY (interactive TUI only; `-p` and child agents never write one). The terminal decides whether to show it: iTerm2 (enable Settings → Profiles → Terminal → "Notification Center Alerts" → Filter Alerts → "Send escape sequence-generated alerts"), kitty, Ghostty, WezTerm and foot show a toast; every other terminal consumes the sequence silently. Inside tmux the sequence is wrapped in tmux's passthrough DCS and needs `set -g allow-passthrough on` in `~/.tmux.conf`. Works over SSH — the notification appears on the machine running the terminal. `false` never writes it |
| `terminalTitle` | `true` | set the terminal window/tab title to `darwin · <project> · <state>` (state `idle`/`working`/`waiting for approval`, plus ` · N queued` while prompts wait), written only when it changes and only when stdout is a TTY; the bare project name is restored on exit (interactive TUI only); `false` never writes it |
| `backgroundTaskWake` | `true` | a finished `bash start` job queues one `<task-notification>` prompt that wakes the agent as its own turn (interactive TUI only); `false` keeps the transcript notice only |
| `shellEnv` | — | `{ "passthrough": [...] }`: variable names (`NPM_TOKEN`) or prefixes with one trailing `*` (`STRIPE_*`, case-sensitive) that model-spawned shells may inherit even though their names are credential-shaped — see [Shell environment](#shell-environment). Any other sub-key, a non-string entry or a `*` anywhere but the end is a startup error naming `shellEnv`. The scrub itself has no off switch |
| `systemPrompt` | built-in | replaces the base prompt and wins over project file |
| `hooks` | — | legacy embedded fallback; prefer layered `hooks/*.json` |

`memory: true` with `trajectory: false` is invalid. Permission allow and deny rules are deliberately not config fields: they live per project in `~/.darwin/projects/<project-key>/permission-rules.json`; a `permissionRules` field in config is a startup error.

The two tables above are the complete key set. Any other key — at the root or inside a `models` entry, including `$schema` or comment-style keys — is an unknown key and a startup error, never a silently ignored one: the message names the file, every unknown key and where it was found, and suggests the nearest known key when a spelling is close (`"thinkingEfort" at the top level (did you mean "thinkingEffort"?)`). Fix the spelling or remove the key. `darwin doctor` reports the same problem as a `!` line (and exits 1) without starting a session, so a config edit can be checked before the next launch.

## Project overrides

Precedence is **defaults < global config < current project override**, in both single-model and `models` array files. The local override key is always lowercase SHA256 of Darwin's canonical `projectKey(root)`. Symlink aliases share a key; distinct working trees (including git worktrees) do not. `agentCoreMemory.projectId` only selects the cloud namespace and shared quota ledger, never consent. `/cloud-memory`, `/status` and doctor label both `local key` and `cloud namespace`. Overrides cannot change their matching ID, resource, region, actor, strategies, model/provider or permissions. Legacy lowercase namespace-shaped map keys are accepted for read compatibility but never matched as consent keys. Unknown/nested fields, recursive overrides, prototype keys, invalid types and more than 1024 project entries are refused; config reads/writes cap at 1 MiB.

You may preconfigure a project's budgets without enabling auto:

```json
{ "projectOverrides": { "<local-key-sha256>": { "agentCoreMemory": {
  "autoDailyEvents": 500, "autoDailyBytes": 104857600
} } } }
```

Limits are positive integers: events up to 100000, bytes up to 107374182400. Root limits are defaults; the project wins. `/cloud-memory auto` writes `upload: "auto"` plus strict `authorization: {version: 2, epoch, at, scope, project}`: a UUID epoch, ISO timestamp, legacy cloud scope hash (region/resource/actor/cloud namespace/both strategies), and the canonical local key in `project`. Version 1 proofs and old cloud-ID-keyed entries remain readable but inactive; they require explicit reconfirmation, never migration or retroactive authorization. Existing manual v1/v2 body bytes, scope hashes and preview proofs are unchanged. Root `upload: "auto"` alone cannot authorize any project. Missing or changed bindings fall back to manual with re-confirm guidance. `/cloud-memory manual` persists immediately and cancels unsent auto work without resetting the conversation. Config writers share a private cross-process lock, fresh-read merge and synced atomic publication; unrelated settings and other projects survive. Crash locks require owner inspection, not automatic stealing.

Auto policy is standing consent, not a completion guarantee: each candidate also needs durable settlement, natural driver completion and bounded semantic integrity checks. After the background-delegation guard, `/clear`/`/rewind` synchronously stop the predecessor's automatic work before their first await and persist a per-origin-session stop marker; even a stale checkpoint or construction failure leaves that session manual (conversation/tools remain usable, with a cloud-status notice). This does not revoke project consent: future successor sessions inherit it for new turns. Fresh consent after an HTTP 403 resets the epoch-bound stop latch, not an earlier held entry; explicitly discard that entry before expecting later same-session auto work to drain. Daily budgets do not raise the 4096-body/512-pending bounds. A capacity-refused publication can still earn a finite authorized expiry/drain pass, never retry/backfill the omitted candidate; only auto-accepted bodies older than seven days expire, not manual bodies. No new config key or daemon is involved. See the [automatic-upload contract](agentcore-memory.md#project-scoped-automatic-upload).

## System prompt composition

Every request uses this fixed order, followed by the final cache point:

```text
<base prompt>                                  built-in or your replacement
<project-instructions source="AGENTS.md">…    repository rules (source names the file: AGENTS.md, or CLAUDE.md when there is none)
<available_skills>…                            official AgentSkills catalogue
<working-context>…                             current run facts
<cache point>
```

Only the base is replaceable. `AGENTS.md`, skills, and working context remain additive. Project memory is retrieved on demand through the parent-only `memory_recall` tool rather than injected as an ambient archive.
The built-in base names the always-available `fileEditor` and `bash` tools and pins the behavioral rules other features rely on: read before editing, keep edits small, verify by running an appropriate check, and never work around a permission denial. A replacement replaces all of that base text, so include any equivalent rules you still need.

Base override precedence:

1. `systemPrompt` in `~/.darwin/config.json`.
2. `.darwin/system-prompt.md`.
3. built-in base.

A blank config `systemPrompt` is a startup error. An empty/unreadable project file degrades to the built-in prompt and is reported in the header.

## `AGENTS.md` (or `CLAUDE.md`)

Only the run directory's own instructions file is loaded; darwin neither walks upward nor merges files. `AGENTS.md` is read first; when — and only when — no `AGENTS.md` exists at all, `CLAUDE.md` is read instead. An `AGENTS.md` that exists but cannot be read is reported and never falls through to `CLAUDE.md`; when both files exist, `CLAUDE.md` is not opened. The header row, `darwin doctor` and the fragment's `source="…"` attribute name the file actually loaded. Claude Code's `@path` import lines are not expanded — they stay literal text, and the `CLAUDE.md` fragment tells the model so. Missing, empty, or whitespace-only content is silently absent. Read failure is visible in the header. Content over 32 KiB is cut at the last complete line before the cap and marked truncated to the user and model; both files follow the same rules. `/init` creates or improves it: one ordinary prompt asks the model to inspect the repository and write `AGENTS.md` with the ordinary file editor (a loaded `CLAUDE.md` is carried into a new `AGENTS.md` and left untouched), so the write passes the permission gate like any other edit.

## Working context

`<working-context>` states the working directory, OS/kernel, shell, Node version, current UTC date/time zone, and immediate directory contents. Directories come first and symlinks are marked `@`. The listing is capped at 200 entries with the remainder counted. Failure to list is nonfatal and visible.

It is rebuilt for every fresh or resumed run. On resume only working context is refreshed; base prompt, `AGENTS.md`, and skill catalogue remain the conversation's captured versions. The block says it is a snapshot and instructs the model to recheck mutable facts.

## Shell environment

Shells the *model* spawns — the persistent `bash` tool shell and `bash start` background jobs, for the parent agent and every subagent alike — never inherit credential-shaped environment variables: any name containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` (case-insensitive: `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, `DB_PASSWORD`, `GOOGLE_APPLICATION_CREDENTIALS`, `my_api_key`) is withheld before the shell starts, so `echo $ANTHROPIC_API_KEY` prints an empty line instead of putting darwin's own key into a tool result, the trajectory and `/export`. `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TMPDIR`, `TZ` and the `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` names (both cases) always survive; everything else (`DATABASE_URL`, `NODE_ENV`, …) passes through untouched. The decision is made once per session from darwin's own environment; there is no off switch. To let a job see a variable the pattern caught, list it under `shellEnv.passthrough` — an exact name or a `PREFIX_*` pattern with one trailing `*`, matched case-sensitively (`STRIPE_*` restores `STRIPE_SECRET_KEY`, not `stripe_key`). When something was withheld, the TUI prints one `shell env: N credential-shaped variables withheld from model shells (…) — see /status` line at startup and `/status` gains a `shell env` row (names, never values); text-mode `-p` runs print one `shell-env:` stderr line on the same terms. Your own `!` commands, hooks and MCP servers are untouched — they run with your environment, as configured. A background job is a login shell, so your own `~/.profile` may still export whatever it exports.

## Prompt caching

Caching is enabled by default for Claude. Darwin marks the stable tool schemas/system/conversation prefix so later turns can be cache reads. Coverage is:

| Part | Bedrock Claude | Anthropic API | OpenAI |
|---|---|---|---|
| tool schemas | cached | cached | — |
| system prompt | cached | cached | — |
| conversation | cached | cached | — |

Set `promptCache: false` to disable. Cache points default to a `1h` lifetime, since a coding session routinely idles past five minutes between turns and every such gap on a `5m` cache re-writes the whole prefix; set `promptCacheTtl: "5m"` for the provider default's cheaper write in short, dense sessions. Non-Claude models report caching unavailable. Summarization and changes to `AGENTS.md`, system prompt, or tool set naturally miss cache. Darwin keeps the AgentSkills catalogue before working context and the final cache point so fresh/resumed requests do not duplicate it.

When a call misses after the cache was warm, `/usage` and `/status` name the likely cause from what darwin already knows — `model switched`, `effort changed`, `compacted`, `idle past cache TTL (5m|1h)` (the TTL is this key), `first request of a resumed session`, else `unknown` — and `/model`/`/effort` print one notice before a switch on a warm cache. Advisory only; see the reference's report contracts.

## Thinking effort

Claude 4.6+ uses adaptive thinking:

| Level | Meaning |
|---|---|
| `low` | minimize; may skip simple work |
| `medium` | moderate; may skip very simple work |
| `high` | always think; default |
| `xhigh` | extended depth; Opus only |
| `max` | no depth constraint |

Unsupported levels clamp instead of causing every request to fail: for example Sonnet `xhigh` becomes `high`. Older Claude models report no adaptive thinking. OpenAI receives `reasoning_effort`; `xhigh` and `max` clamp to `high`, and non-reasoning models may reject the field. A clamp is always reported, never silent: the interactive header and `/status` show it, `darwin doctor` notes it, and a headless run writes a `thinking:` stderr line (text) or carries `thinking.requested`/`effective`/`problem` on `run.started` plus a `thinking` warning (json/stream-json).

```text
/effort
/effort max
/model
/model claude-opus-5
```

Both changes affect the next model call without discarding the conversation.
