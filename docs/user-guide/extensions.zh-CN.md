# 扩展

[English](extensions.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 发现顺序与优先级

除内置保留名称外，skills、agents 和 commands 按以下顺序解析：

1. 项目 `.darwin/`
2. 项目 `.agents/`
3. 全局 `~/.darwin/`
4. 全局 `~/.agents/`

名称比较不区分大小写，第一份有效定义生效。项目资源覆盖全局资源，必需的内置名称始终保留。可选资源有误时会跳过并报告，不影响其他有效定义。

原生直接 hook 文件按 wrapper 合并：Pre 顺序为全局 `.agents`、全局 `.darwin`、项目 `.agents`、项目 `.darwin`；Post 完全反向。只有某一层没有直接 hook JSON 目录时，才回退到旧版 `.darwin/hooks.json` 或配置内嵌 hooks。全局/项目直接 `.agents/hooks.json` 是独立的 Codex 兼容可移植源，排在同层 `.agents/hooks/*.json` 之前；`.codex/hooks.json` 明确不会被读取。

## MCP 服务器

项目 MCP 优先读取 `.darwin/mcp.json`，不存在时回退到根目录 `.mcp.json`，格式与 Claude Code 相同。全局 `~/.darwin/mcp.json` 也可提供服务器；同名时项目配置优先。`/mcp` 会显示实际生效和被忽略的路径。

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

`command` 表示 stdio，`url` 表示 streamable HTTP；SSE 需显式设置 `transport: "sse"`。`${VAR}` 和 `${env:VAR}` 可用于 command、args、env、URL、headers。每个条目还支持 `disabled`、`prefix`、`toolFilters`。

工具默认注册为 `<serverName>_<toolName>`，避免重名。设置 `prefix: ""` 可恢复裸名称，但冲突风险由用户承担；也可使用更短的自定义前缀。MCP 工具无法通过静态安全证明，除 `yolo` 外都需要审批。

`.darwin/mcp.json` 默认被 gitignore，因为 headers/env 容易包含真实 token。先用变量插值清理敏感值，再决定是否提交。单个服务器启动失败或引用未设置变量时，只跳过该服务器；整个文件无法解析才会阻止启动。`/mcp` 会报告配置名称、连接状态、有上限的工具名/数量、生效与忽略文件，但不会调用 `listTools()`、连接或重试。失败服务器需重启 darwin 才会重试。

若 `npx` 服务器只报 `Connection closed`，请删除项目 `package.json` 中的 `devEngines.packageManager`，或为服务器另设 `cwd`；`npx` 可能先因 `EBADDEVENGINES` 退出，MCP 只能看到连接关闭。

## Skills

Skill 是一组按目录组织的指令：

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

`description` 必填，也是加载前唯一展示给模型的正文信息；`name` 默认取目录名。darwin 把有效定义交给官方 SDK `AgentSkills`。SDK 解析 frontmatter/正文并维护激活状态，还会列出 `scripts/`、`references/`、`assets/`，最多三层、20 个文件，截断会明说。

资源根目录预检最多扫描 200 项。根级和嵌套符号链接只有在 real path 仍位于已解析 skill root 内时才接受，并在实际使用时再次检查。

模型按需调用安全的 `load_skill({name})`；SDK 原生 `skills()` 工具不会暴露给模型。用户也可用 `/skill-name <request>`，把完整 skill 与请求一起发送。可选 skill 格式错误时跳过；必需的内置 skill 错误会阻止启动。

## 内置工作流

### `developer`

`/developer <requirement>` 让 Host 留在当前交互会话中，同时由一个受管理的无头 darwin 子进程完成规划、实现、检查、spec 更新和已授权提交。子进程通过 `bash start` 启动；无头环境无法回答权限框，因此固定使用 `--yolo`。超大结果卸载默认开启；兼容的 `--context-offload` 可在配置显式退出时强制恢复这项安全能力。除非用户明确要求，不设置模型调用预算。

`bg-…` 标识一次进程任务；精确的 `session: session-…` 行才是可持续的子会话 ID。修正必须显式使用该 session，不能用 `--continue`。Host 会耗尽输出、检查 diff，并独立重跑验收，不会用 Host 侧补丁掩盖子进程失败。互不依赖的读取/检查可以批量执行，存在依赖的写入必须串行；验证按金字塔进行：编辑时跑聚焦检查，源码稳定后由子进程跑一次完整门禁，再由 Host 独立跑一次完整门禁。若验收发现具体问题，只在同一子会话中做一次聚焦修正；先前记录很长时，修正前可压缩历史。验收通过后，Host 会做一次收尾：判断这次改动是否有读者可见的部分——命令、参数、按键、配置字段或约定——并同步 README、对应的用户指南页面（子进程通常只更新 `reference.md`，会漏掉叙述性页面）以及 `docs/architecture/load-bearing-decisions.md`，中英文一起更新；纯文档同步可以由 Host 直接提交一次，并重跑所有校验文档文本的测试。报告包含任务/会话 ID、检查、token 消耗、已同步的文档（或说明无需同步）和风险。在本仓库中，每次通过验收的批次还必须追加到 `docs/iteration-log.md`。

### `self-evolution-research`

这个核心工作流已在[根 README](../../README.zh-CN.md)优先说明。它先处理 `in-progress` 待办，再处理按优先级排列的 `not-started` 待办；只有两者都为空时才抽取新路径。路径只抽一次，权重为 `peer=50%`、`tui=20%`、`open=15%`、`sdk=10%`、`observability=5%`。脚本在精确的半权重单位上做均匀抽取，并记录原始 draw 和权重；第一次结果具有约束力，不能因为看起来没意思就重抽。脚本也不提供可用来反复寻找偏好结果的 seed。用户用 `--path` 指定时，会明确标为 user-directed，不能伪装成随机结果。

同类产品路径会对照 Claude Code、Codex、DeepSeek harness、PenguinHarness 等相关产品的一手资料与 darwin 当前实现。自检路径只引用仓库证据，不为凑表格添加无关产品。每次 UTC 研究运行都遵循 [`docs/research/research_template.md`](../research/research_template.md)，追加到 `docs/research/research_<YYYY-MM-DD>.md`，最多提出五个不重复方向，并按以下公式评分：

```text
Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk
MINIMUM_IMPLEMENTATION_SCORE = 6
```

达标方向组成一批按顺序执行的任务。每项都新建 `developer` 子会话，并使用最新通过验收的 darwin 版本实现，再由 Host 独立验收。只有通过验收才标为 `done`；阻塞项保持 `in-progress`；只有未达分数门槛或已有明确记录的决定时，才可标为 `abandoned`。整批只会因全部完成、验收反复失败、前提被证伪、遇到只能由人决定的问题、起点无法恢复，或剩余事项都不值得做而停止。

### `self-reflection`

`/self-reflection` 会定位当前项目的会话轨迹（也可显式指定 ID），核对最后输入预览，再交给受管理的无头 worker 做只读分析。它只写一份 `docs/reflections/reflection_<UTC-date>_<session-id>.md`，包括 Perfect/High/Medium/Low 完成评级、过程观察，以及有证据支撑的 darwin 改进建议。建议沿用自演进评分，达标项以稳定 `SRF-NNN` ID 写入 backlog；reflection 本身不实现这些建议。

## 子代理

内置 `general` 始终可用。专用定义是 `.darwin/agents/` 下的直接 Markdown 文件：

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

必需内容包括：有效且唯一、不能为 `general` 的名称（`[A-Za-z0-9_-]+`）、description 和非空正文。省略 `tools` 表示所有可供子代理使用的工具；`tools: []` 表示无工具；否则必须填写大小写完全匹配的已注册名称。未知工具、格式错误、重复或不可读定义会跳过。定义只在启动时读取一次。

子代理使用新的模型实例和上下文，不继承父会话消息，不持久化 session，也不能递归调用 `subagent`。之后派发的子代理使用当时已选择的模型。工具限制不是权限授权，子代理调用仍经过共享 gate 和规则。委派本身不做项目 I/O，因此安全。`Ctrl+C` 会同时取消父回合和子代理，并回收其 bash 会话。

同一条助手消息里的多个 `subagent` 调用并行执行。权限框仍串行，并标明来源。`/agents` 只列当前运行的派发元数据，从不包含子对话。并行适合读取型工作：所有子代理共享一个没有隔离、锁或冲突检测的工作树，因此写入必须串行。

## Workflow（DAG 委派）

`workflow` 是 `subagent` 的多步版本：不再一次调用只派发一个任务，而是由模型声明一个小型任务依赖图，按依赖顺序调度执行。用自然语言描述流水线即可——例如"先并行调研 X 和 Y，再据此实现，最后审查 diff"——模型可以把它作为一次 `workflow` 调用提交，而不必逐步人工推进。若想显式引导，输入 `/workflow <任务描述>`：该内置命令会展开成一条普通 prompt，请模型用 `workflow` 工具编排该任务（DAG 仍由模型拆解；不带参数的 `/workflow` 只打印用法）。

输入是数据，永远不是代码：

```json
{
  "nodes": [
    { "id": "map",    "agent": "explorer", "task": "Map the auth module; cite files and symbols." },
    { "id": "tests",  "agent": "explorer", "task": "List existing auth test coverage and gaps." },
    { "id": "plan",   "task": "Using the reports above, propose a minimal fix plan." }
  ],
  "edges": [["map", "plan"], ["tests", "plan"]]
}
```

每个节点作为一个全新子代理运行（`agent` 缺省为 `general`，同样使用 `.darwin/agents/` 里的定义）。边 `[source, target]` 表示 `target` 等待 `source` 完成，并把它的最终报告作为输入——中间报告在节点之间直接流转，不占用父会话上下文。依赖全部满足的节点并行运行，可用可选的 `maxConcurrency` 限流。

边界与拒绝：最多 8 个节点、28 条边；节点 id 重复或未知、代理名未知、任务为空、图中有环，都会在创建任何子代理之前以有界错误拒绝。只有终点报告（执行路径结束处的节点）返回给父代理；子对话保持私有。

子代理一节的所有约束对每个节点同样成立：全新模型/上下文、共享权限 gate 且提示标明来源、`/agents` 派发行与定向 `/agents cancel <id>`、bash 会话回收、Ctrl+C 取消整个运行（包括尚未启动的节点）。工作树警告同样适用：并行分支只用于读取——需要写入时用边把它们串行化。

## 自定义命令

把 Markdown 放在 `.darwin/commands/` 或对应全局/可移植目录中。输入 `/name arguments` 时，文件正文会作为消息发送，其中 `$ARGUMENTS` 替换为命令后的文字。内置名称仍保留；发现顺序遵循通用优先级。

## 工具 hooks

`PreToolUse` 和 `PostToolUse` shell 命令包裹模型工具调用。顺序是全局 Pre → 项目 Pre → 权限/工具 → 项目 Post → 全局 Post。正在生效的 hook 文件和目录属于敏感路径，不能被放行规则覆盖。`plan` 会在 Pre hook 之前拒绝写入/执行。不要把密钥写进已提交的 hook 配置；建议使用分层 `hooks/*.json`，旧文件只作为兼容后备。

### Codex 兼容可移植 hooks

darwin 还会按 Codex 三层 JSON 结构（`hooks` → matcher 组 → handler）读取 `~/.agents/hooks.json` 与 `<project>/.agents/hooks.json`。支持 11 个已文档化事件：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop`。matcher 使用正则表达式；省略、`""`、`"*"` 都表示全匹配。handler 只支持串行 `type: "command"`，在项目根目录运行，继承环境，通过有界 JSON stdin/stdout 通信；支持有界 `timeout`、可选 `commandWindows`，并校验 `additionalContextLimit`。展示元数据不会新增 TUI 表面。

为了保持 darwin 的安全契约，控制能力有意比 Codex 更窄：

- `SessionStart`、`UserPromptSubmit`、`PostCompact` 与匹配的 `SubagentStart` 可加入有界、仅本次调用可见的上下文。原始用户文本仍是 trajectory/recall/memory 的来源；不会改写 system prompt、恢复历史或子代理定义。
- `UserPromptSubmit` 的 block 输出或退出码 2 会在 trajectory/provider/tool 工作前本地拒绝。
- `PreToolUse` 支持 deny/退出码 2，以及校验后的 `allow + updatedInput`；顺序仍是 plan/retry guard 之后、最终权限分类之前。`bash` 也可匹配 `Bash`；会修改文件的 `fileEditor` 操作也可匹配 `apply_patch`、`Edit`、`Write`。
- 显式 `/compact` 与无头 `--compact-before` 以 `trigger: "manual"` 发布 `PreCompact`/`PostCompact`；不会把 SDK 自动溢出恢复伪装成 Codex `auto` 支持。
- `PermissionRequest`、`PostToolUse`、`SubagentStop`、`Stop`、`SessionEnd` 仅作观察/通知。它们不能自动放行权限、替换/重试/隐藏结果，也不能让父或子代理自动续跑。`SubagentStop` 不包含子代理 transcript 路径或 assistant 文本；只有普通的有界 subagent 结果会返回父代理。不支持的控制字段通过现有有界 notice/自动化 diagnostic 报告，但不会改变原结果。

首版在启动时拒绝 `mcp_tool`、`prompt`、`agent` 与 `async: true` handler。它不读取 `.codex/hooks.json` 或内联 TOML，不实现 Codex trust/managed/plugin 策略，不新增 `/hooks` 浏览器，不伪造 `turn_id`/transcript path，也不承诺崩溃或空闲超时下的 `SessionEnd`。在仓库中启动 darwin 即表示信任该仓库的可执行策略；活动策略的解析、schema 或正则错误会阻止启动。
