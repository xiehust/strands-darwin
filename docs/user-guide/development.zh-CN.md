# 限制与开发

[English](development.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 已知限制与安全边界

- **没有沙箱。** 模型发起的 shell 命令经权限策略放行后，会直接在宿主机执行。用户 `!` 命令由用户显式授权，同样直接运行。
- **权限 diff 比较工具输入，不读取磁盘。** 它准确展示提议的旧/新文本；若文件被并发修改，最终效果可能与提案不同。
- **Streamable HTTP MCP 已有配置支持，但没有真实联调。** 配置路径经过验证，stdio 已端到端测试；`/mcp` 检查不会主动探测。
- **没有自治调度器或 agent swarm。** `developer` 通过现有会话/任务监督一个外部无头子进程。`self-evolution-research` 选择有边界的一批方向后调用该监督器；产品、安全和验收权仍归人。
- **并行子代理写入不安全。** 子代理共享没有隔离、锁或冲突检测的工作树。并发只应用于读取，写入需要串行。
- **子代理结果可能带出思考内容。** 子对话不会按子事件写入轨迹，但当前 SDK 返回给父代理的终端渲染结果可能包含子代理思考；详情见子代理架构文档。
- **Bedrock 上下文统计通常是估算。** 2026 年 8 月在 `us-east-1`/`us-west-2` 的实测显示，`CountTokens` 只接受裸 foundation-model ID，但真正调用 Claude 又必须使用 inference profile。`anthropic.claude-sonnet-4-6` 可以计数，同一模型的 `us.`/`global.` profile 或 ARN 会返回 `ValidationException: The provided model doesn't support counting tokens`；裸 4.5/4.6 可用，测试过的 `claude-opus-4-7`、`claude-opus-4-8`、`claude-sonnet-5`、`claude-opus-5`、`claude-fable-5` 也不支持。darwin 不会只为旧模型擅自去掉前缀，在上游接受 profile ID 前统一退回 SDK 字符启发式。除非启用 diagnostics，这个降级只写入 debug 日志；IAM 缺少 `bedrock:CountTokens` 时，每个模型在每个进程中会警告一次。
- **回合编号随进程重置。** 恢复后的轨迹可能有多个 `turn 1`；费用合计仍按真实结束记录计算。
- **后台任务控制只属于当前进程。** 恢复会话保留日志，不保留 task 控制和游标。正常关闭会回收进程组；`SIGKILL` 或机器故障无法保证。
- **`SIGKILL` 或 `EPIPE` 后，结构化输出无法保证终态记录。**
- **诊断与卸载结果可能包含敏感会话/工具内容，并会一直保留。** diagnostics 需主动开启；超大结果卸载默认开启，除非显式关闭。目前没有自动会话垃圾回收。
- **直连 Anthropic 需要可选 peer dependency。** 见[入门](getting-started.zh-CN.md)。

修改相关子系统前，请先阅读[关键架构决策](../architecture/load-bearing-decisions.md)中的实现约束。

## 开发命令

```bash
pnpm typecheck    # tsc --noEmit；静态质量门
pnpm test         # 全部快速套件，不调用模型/网络
pnpm build        # 输出 dist/ 并复制内置 skill 资源
pnpm dev-repl     # 使用同一 AgentRuntime 的逐行驱动器
```

项目没有配置 linter。REPL 早于 Ink TUI 保留至今，可帮助判断问题来自 runtime 还是终端渲染。

测试不依赖 mock，而是使用真实文件、会话、进程组、SDK 对象和 PTY。`spike/` 就是测试套件，不是临时目录。`verify-*` 文件会执行断言，失败时返回非零。`pnpm test` 运行快速子集。

## 聚焦检查与在线检查

以下是免费/离线的聚焦套件示例：

```bash
pnpm tsx spike/verify-config.ts
pnpm tsx spike/verify-mcp-config.ts
pnpm tsx spike/verify-mcp-command.ts
pnpm tsx spike/verify-skills.ts
pnpm tsx spike/verify-agent-skills.ts
pnpm tsx spike/verify-headless.ts
pnpm tsx spike/verify-headless-structured.ts
pnpm tsx spike/verify-agents-md.ts
pnpm tsx spike/verify-system-prompt.ts
pnpm tsx spike/verify-permission-modes.ts
pnpm tsx spike/verify-prompt-cache.ts
pnpm tsx spike/verify-trajectory.ts
pnpm tsx spike/verify-memory.ts
pnpm tsx spike/verify-background-bash.ts
pnpm tsx spike/verify-tasks-tail.ts
pnpm tsx spike/verify-file-editor.ts
pnpm tsx spike/verify-doctor-command.ts
pnpm tsx spike/verify-copy-command.ts
pnpm tsx spike/verify-tui.ts completion
pnpm tsx spike/verify-tui.ts copy
pnpm tsx spike/verify-tui.ts escRewind
pnpm tsx spike/verify-tui.ts pathCompletion
pnpm tsx spike/verify-tui.ts recall
pnpm tsx spike/verify-tui.ts bang
pnpm tsx spike/verify-tui.ts queue
pnpm tsx spike/verify-tui.ts mcp
```

调用真实模型的检查需要有效凭证，并可能产生费用：

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-classifier.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-thinking-live.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts autonomous
AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts
pnpm tsx spike/verify-mantle-live.ts
pnpm tsx spike/probe-model-switch.ts
```

Bedrock 必须使用 inference-profile ID，不能用裸 `anthropic.*`。Ink 依赖 raw mode，因此 TUI 套件需要真实 PTY，由 `spike/tui-driver.ts` 提供。命令末尾加场景名可只运行单项。场景会随 TUI 更新，请以 `spike/verify-tui.ts` 当前内容为准。

## 架构索引

项目不会另写一套 agent loop。只有 `src/agent/runtime.ts` 构造 `Agent`，而且只是 SDK extension point 之上的轻量组装。详细依据与验证链接集中在[关键架构决策](../architecture/load-bearing-decisions.md)。[子代理架构](../architecture/sub-agents.md)单独说明发现、组装、上下文隔离、权限、可观测性、取消和并发边界。

主要源码目录：

```text
src/agent/        runtime、模型、权限、prompt、会话、诊断
src/tui/          Ink 应用、frame budget、编辑器、投影、渲染
src/trajectory/   只追加写入与离线读取/replay/fork/export
src/memory/       项目记忆提取、校验、命令
src/skills/       官方 AgentSkills 策略适配与内置 skills
src/agents/       子代理定义、派发表、subagent 工具
src/mcp/          配置与只读 registry 投影
src/hooks/        分层工具 hooks
src/config.ts     严格配置解析与模型构造
src/paths.ts      全局/项目路径归属
```

## 仓库开发流程

非琐碎改动先理解相关区域（`docs/architecture/load-bearing-decisions.md` 中对应章节和相关的 `spike/` 测试套件），再实现、用 `pnpm typecheck`、`pnpm test` 及表格中列出的检查验证，然后提交。这份记录很重要，因为 darwin 正在用自身开发自身。每次受监督的 `/developer` 批次还要把子会话、通过验收的提交和 Host 重跑证据追加到[迭代日志](../iteration-log.md)。

`AGENTS.md` 必须小于 32 KiB，因为 darwin 只预加载这一上限。不要在 `package.json` 添加 `devEngines`，否则所有 `npx` MCP 服务器都可能只报含糊的连接关闭。不要绕过 pnpm 的 `minimumReleaseAge` 安装过新的 SDK 版本。升级 SDK 后，必须重新验证固定 patch。

## 开发时的项目与全局状态

所有 `.darwin/` 路径都由 CLI cwd 派生；`process.cwd()` 只允许出现在 CLI driver 中。用户状态按项目存到工作树外。Agents/commands/skills/hooks/MCP 的项目与全局分层见[扩展](extensions.zh-CN.md)。内置名称始终保留；项目命名资源覆盖全局资源。Hook 文件属于可执行策略，因此按敏感路径处理。
