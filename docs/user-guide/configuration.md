# Configuration and context

**English** · [简体中文](configuration.zh-CN.md) · [Guide index](README.md)

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
| `bedrockMantle` | `false` | OpenAI provider via AWS; mutually exclusive with `apiKeyEnv` |
| `openaiApi` | `chat` | `chat` or `responses` |
| `maxTokens` | `64000` | maximum output tokens |
| `promptCache` | `true` | Claude only |
| `promptCacheTtl` | provider default (`5m` on Bedrock) | `5m` or `1h` at every cache point |
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
| `terminalBell` | `false` | ring the terminal bell on permission prompts and turn completion (interactive TUI only) |
| `systemPrompt` | built-in | replaces the base prompt and wins over project file |
| `hooks` | — | legacy embedded fallback; prefer layered `hooks/*.json` |

`memory: true` with `trajectory: false` is invalid. Permission allow rules are deliberately not config fields: they live per project in `~/.darwin/projects/<project-key>/permission-rules.json`; a `permissionRules` field in config is a startup error.

The two tables above are the complete key set. Any other key — at the root or inside a `models` entry, including `$schema` or comment-style keys — is an unknown key and a startup error, never a silently ignored one: the message names the file, every unknown key and where it was found, and suggests the nearest known key when a spelling is close (`"thinkingEfort" at the top level (did you mean "thinkingEffort"?)`). Fix the spelling or remove the key.

## System prompt composition

Every request uses this fixed order, followed by the final cache point:

```text
<base prompt>                                  built-in or your replacement
<project-instructions source="AGENTS.md">…    repository rules
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

## `AGENTS.md`

Only `AGENTS.md` in the run directory is loaded; darwin neither walks upward nor merges files. Missing, empty, or whitespace-only content is silently absent. Read failure is visible in the header. Content over 32 KiB is cut at the last complete line before the cap and marked truncated to the user and model.

## Working context

`<working-context>` states the working directory, OS/kernel, shell, Node version, current UTC date/time zone, and immediate directory contents. Directories come first and symlinks are marked `@`. The listing is capped at 200 entries with the remainder counted. Failure to list is nonfatal and visible.

It is rebuilt for every fresh or resumed run. On resume only working context is refreshed; base prompt, `AGENTS.md`, and skill catalogue remain the conversation's captured versions. The block says it is a snapshot and instructs the model to recheck mutable facts.

## Prompt caching

Caching is enabled by default for Claude. Darwin marks the stable tool schemas/system/conversation prefix so later turns can be cache reads. Coverage is:

| Part | Bedrock Claude | Anthropic API | OpenAI |
|---|---|---|---|
| tool schemas | cached | — | — |
| system prompt | cached | cached | — |
| conversation | cached | — | — |

Set `promptCache: false` to disable or `promptCacheTtl: "1h"` for a longer, more expensive write. Non-Claude models report caching unavailable. Summarization and changes to `AGENTS.md`, system prompt, or tool set naturally miss cache. Darwin keeps the AgentSkills catalogue before working context and the final cache point so fresh/resumed requests do not duplicate it.

## Thinking effort

Claude 4.6+ uses adaptive thinking:

| Level | Meaning |
|---|---|
| `low` | minimize; may skip simple work |
| `medium` | moderate; may skip very simple work |
| `high` | always think; default |
| `xhigh` | extended depth; Opus only |
| `max` | no depth constraint |

Unsupported levels clamp instead of causing every request to fail: for example Sonnet `xhigh` becomes `high`. Older Claude models report no adaptive thinking. OpenAI receives `reasoning_effort`; `xhigh` and `max` clamp to `high`, and non-reasoning models may reject the field.

```text
/effort
/effort max
/model
/model claude-opus-5
```

Both changes affect the next model call without discarding the conversation.
