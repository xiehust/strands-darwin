# 配置与上下文

[English](configuration.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 文件形式与优先级

`~/.darwin/config.json` 是唯一生效的配置。单模型可把字段直接放在根级；多模型则使用 `models`。数组形式必须且只能有一个条目设置 `"enable": true`。模型字段放在各条目中，会话字段仍放在根级。名称不区分大小写且不可重复。自定义条目会替换内置目录。

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

根级单模型配置只向 `/model` 暴露这一个模型。`/model` 会持久化数组中启用的条目；`/effort` 会把 `thinkingEffort` 写回该条目。

## 模型字段

| 字段 | 默认值 | 约定 |
|---|---|---|
| `models` | 配置文件不存在时使用内置目录 | 可选模型数组；必须且只能有一个 `enable: true` |
| `enable` | — | 仅数组形式可用 |
| `name` | 模型 ID | `/model` 使用的简短唯一名称 |
| `provider` | `bedrock` | `bedrock`、`anthropic` 或 `openai` |
| `model` | `global.anthropic.claude-opus-5` | 供应商对应的模型 ID |
| `region` | AWS 环境变量，其次 `us-west-2` | Bedrock/Mantle 区域 |
| `apiKeyEnv` | 供应商惯例 | 保存直连 API key 的环境变量名 |
| `baseUrl` | `ANTHROPIC_BASE_URL`，其次 `https://api.anthropic.com` | 仅 Anthropic；Messages API 兼容端点的 `http(s)` URL |
| `bedrockMantle` | `false` | OpenAI provider 通过 AWS 调用；不可与 `apiKeyEnv` 同时使用 |
| `openaiApi` | `chat` | `chat` 或 `responses` |
| `maxTokens` | `64000` | 最大输出 token 数 |
| `contextWindowLimit` | SDK 内置模型表，否则未知 | 整数 token 数；覆盖内置表，用于 `/context`、`/status` 和上下文压力提示 |
| `promptCache` | `true` | 仅 Claude 生效 |
| `promptCacheTtl` | 供应商默认值（`5m`） | 每个 cache point 使用 `5m` 或 `1h`；Bedrock 与 Anthropic 均生效 |
| `thinkingEffort` | `high` | `low`、`medium`、`high`、`xhigh`、`max` |
| `classifierModel` | 各供应商的低成本模型 | `auto` 权限模式使用的分类模型 |
| `requestTimeoutMs` | `180000` | Bedrock 流式请求空闲超时；收到字节后重新计时 |

## 会话字段

| 字段 | 默认值 | 约定 |
|---|---|---|
| `permissionMode` | `default` | `default`、`auto`、`plan`、`yolo` |
| `summaryRatio` | `0.8` | 上下文溢出时被摘要的旧消息比例 |
| `preserveRecentMessages` | `10` | 摘要时原样保留的消息数 |
| `contextWarnRatio` | `0.8` | 回合结束后建议 `/compact` 的阈值；`0` 关闭提醒 |
| `contextOffload` | `true` | 把超大工具结果存到会话目录，上下文只留预览和引用；`false` 显式退出 |
| `maxResultTokens` | `5000` | 卸载阈值；默认或显式 `true` 时有效，与 `contextOffload: false` 冲突，且必须大于 `1000` |
| `trajectory` | `true` | 把每轮追加到轨迹 |
| `diagnostics` | `false` | 每会话 SDK/darwin 调试日志 |
| `memory` | 轨迹可用时开启 | 项目记忆；未设置时跟随 `trajectory: false` |
| `memoryHorizonDays` | `28` | 生成记忆的有效天数，整数 `0–365`；`0` 只关闭过期检查 |
| `terminalBell` | `false` | 在权限提示和回合结束时响一次终端铃（仅交互式 TUI） |
| `systemPrompt` | 内置值 | 替换基础 prompt，并优先于项目文件 |
| `hooks` | — | 旧版内嵌后备配置；建议使用分层 `hooks/*.json` |

`memory: true` 与 `trajectory: false` 不能同时使用。权限放行规则不属于该配置，它按项目存于 `~/.darwin/projects/<project-key>/permission-rules.json`。在配置文件中写入 `permissionRules` 会导致启动失败。

上面两张表就是全部字段。其他任何键——无论在顶层还是 `models` 条目内，包括 `$schema` 或注释风格的键——都是未知字段，会导致启动失败，而不会被静默忽略：错误信息会指出文件、每个未知字段及其位置，并在拼写接近时给出最近的已知字段（`"thinkingEfort" at the top level (did you mean "thinkingEffort"?)`）。请修正拼写或删除该字段。`darwin doctor` 会在不启动会话的情况下以 `!` 行报告同样的问题（并以退出码 1 结束），因此改完配置可以先检查再启动。

## System prompt 组成

每次请求都按固定顺序组装，末尾再放最终 cache point：

```text
<base prompt>                                  内置值或你的替换内容
<project-instructions source="AGENTS.md">…    仓库规则
<available_skills>…                            官方 AgentSkills 目录
<working-context>…                             当前运行事实
<cache point>
```

只有基础 prompt 可以替换。`AGENTS.md`、skills 和工作上下文仍会追加。项目记忆由父 agent 按需调用 `memory_recall` 检索，不再把完整归档常驻注入 prompt。
内置基础 prompt 会说明始终可用的 `fileEditor` 和 `bash` 工具，并固定其他功能依赖的行为规则：编辑前先读文件、控制改动范围、运行合适的检查验证结果，以及不得绕过权限拒绝。替换基础 prompt 会把这些文字全部替掉，需要保留的规则应自行写入新版本。

基础 prompt 的优先顺序如下：

1. `~/.darwin/config.json` 中的 `systemPrompt`。
2. `.darwin/system-prompt.md`。
3. 内置基础 prompt。

配置里的空白 `systemPrompt` 会导致启动错误。项目文件为空或无法读取时，darwin 会退回内置 prompt，并在标题区说明原因。

## `AGENTS.md`

darwin 只读取启动目录中的 `AGENTS.md`，不会向父目录查找，也不会合并多份文件。文件不存在、为空或只有空白时直接忽略；读取失败会显示在标题区。超过 32 KiB 的内容会在上限前最后一个完整行处截断，并同时向用户和模型标明。

## 工作上下文

`<working-context>` 包含工作目录、操作系统与内核、shell、Node 版本、当前 UTC 日期/时区，以及当前目录第一层内容。目录排在前面，符号链接标记为 `@`。列表最多 200 项，其余数量会写明。目录无法列出不会阻止启动，但会显示原因。

每次新建或恢复运行都会重新生成该块。恢复会话时，只有工作上下文刷新；基础 prompt、`AGENTS.md` 和 skill 目录仍沿用会话创建时捕获的版本。该块明确说明自己只是快照，并要求模型重新检查可能变化的事实。

## Prompt 缓存

Claude 默认启用缓存。darwin 会给稳定的工具 schema、system prompt 和会话前缀设置 cache point，使后续回合可按缓存读取计费。覆盖范围如下：

| 部分 | Bedrock Claude | Anthropic API | OpenAI |
|---|---|---|---|
| 工具 schema | 缓存 | 缓存 | — |
| system prompt | 缓存 | 缓存 | — |
| 会话 | 缓存 | 缓存 | — |

设置 `promptCache: false` 可关闭；`promptCacheTtl: "1h"` 会延长缓存时间，但写入成本更高。非 Claude 模型会明确显示不支持。摘要会重写历史，修改 `AGENTS.md`、system prompt 或工具集合也会造成缓存未命中。darwin 把 AgentSkills 目录放在工作上下文和最终 cache point 之前，避免新建/恢复请求重复注入。

## 思考强度

Claude 4.6+ 使用 adaptive thinking：

| 级别 | 含义 |
|---|---|
| `low` | 尽量少思考，简单任务可能跳过 |
| `medium` | 中等强度，极简单任务可能跳过 |
| `high` | 总是思考；默认值 |
| `xhigh` | 更深的思考；仅 Opus 支持 |
| `max` | 不限制深度 |

不受支持的级别会降级，而不会让每次请求都失败。例如 Sonnet 的 `xhigh` 会降为 `high`。较旧 Claude 模型会显示不支持 adaptive thinking。OpenAI 接收 `reasoning_effort`；`xhigh` 和 `max` 都会降为 `high`，非推理模型可能拒绝该字段。

```text
/effort
/effort max
/model
/model claude-opus-5
```

两种切换都从下一次模型调用生效，并保留当前会话。
