# TUI coding agent MVP based on Strands TypeScript SDK

## Goal

用 Strands TypeScript SDK 构建一个基于 TUI 的 coding agent MVP。验收基准是**能改真实代码**：用户在 TUI 里对话，agent 能读文件、改文件、跑命令，独立完成一次真实的小修改（例如修一个 bug）。

## 核心原则

**最大化复用 Strands SDK 原生能力，不自己造轮子。** 经调研（2026-08-13，Context7 官方文档）确认的复用清单与唯一缺口见下。

## Requirements

### R1 Agent 核心（复用 SDK）
- 模型接入：默认 Bedrock 上的 Claude，provider 抽象为配置文件可切换（SDK 原生支持 Bedrock / Anthropic / OpenAI / Gemini / Vercel AI SDK）。
- 工具：全部使用 SDK vended tools —— `bash`、`fileEditor`（`@strands-agents/sdk/vended-tools/*`），不自建文件/命令工具。搜索类操作由模型经 bash 调 grep/glob 完成。
- 会话持久化：SDK `SessionManager` + `FileStorage`，启动时 `--resume` 恢复上次会话。
- 上下文管理：SDK `SummarizingConversationManager`（已确认 TS SDK 存在）。
- MCP：SDK `McpClient`，支持 stdio 与 Streamable HTTP 两种传输；配置沿用 Claude Code 的 `.mcp.json` 格式，启动时读取并注册工具。

### R2 权限模型
- 写文件、执行命令类工具调用前弹确认框（y/n）；读类操作直接放行。
- 实现方式：SDK hooks（`BeforeToolCallEvent` 拦截）+ TUI 确认组件，不 fork agent loop。

### R3 Skills（唯一自建项）
- TS SDK 尚不支持 Skills（官方文档明确 "Skills are not yet available in TypeScript SDK"），自建轻量 loader，语义对齐 Agent Skills 规范和 Python 版 `AgentSkills` 插件，便于将来官方支持后无痛替换。
- 扫描 `skills/` 目录下含 `SKILL.md` 的子目录，解析 YAML frontmatter（name/description）。
- 双触发：
  - 模型自主触发：所有 skill 的 name+description 注入 system prompt，提供 `load_skill` 工具按需加载全文。
  - 用户斜杠命令：TUI 中输入 `/skill-name` 手动加载。

### R4 TUI（Ink / React）
- 组件化：消息列表、流式输出渲染、工具调用展示面板、权限确认框、输入框。
- 支持斜杠命令输入（`/skill-name`）。

## Acceptance Criteria

- [ ] 在一个真实 git 仓库中启动 TUI，通过对话让 agent 完成一次真实代码修改（读文件 → 改文件 → 跑命令验证），全程流式输出可见。
- [ ] 写文件 / bash 命令执行前出现确认框，拒绝后 agent 收到拒绝结果并继续对话；读类操作不弹框。
- [ ] `.mcp.json` 配置一个 stdio MCP server 后，agent 能发现并成功调用其工具；Streamable HTTP 传输同样可配。
- [ ] `skills/` 目录放入含 SKILL.md 的 skill 后：(a) 模型能在相关任务中自主调用 `load_skill` 加载；(b) 用户输入 `/skill-name` 能手动加载。
- [ ] 退出后用 `--resume` 重启，上次对话上下文恢复。
- [ ] provider 配置从 Bedrock 切到其他 provider 只需改配置文件，不改代码。

## 约束

- Node.js + TypeScript，`@strands-agents/sdk`。
- TUI 框架：Ink（React）。
- MVP 不含：multi-agent 编排、子代理、复杂 diff 预览 UI（确认框内容受 vended tool 入参格式限制，可接受）。
