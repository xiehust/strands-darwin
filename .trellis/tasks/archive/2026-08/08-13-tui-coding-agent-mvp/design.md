# Design — TUI coding agent MVP (Strands TypeScript SDK)

## 总体架构

```
┌─────────────────────────── TUI (Ink/React) ───────────────────────────┐
│  MessageList │ ToolCallPanel │ PermissionPrompt │ InputBox(/commands) │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ stream events / confirm callbacks
┌──────────────────────────────▼─────────────────────────────────────────┐
│                        AgentRuntime (thin glue)                        │
│  Agent (@strands-agents/sdk)                                           │
│   ├─ model: createModelFromConfig()   ← config.json (provider 可切换)  │
│   ├─ tools: [bash, fileEditor, loadSkillTool, ...mcpClients]           │
│   ├─ sessionManager: SessionManager + FileStorage (--resume)           │
│   ├─ conversationManager: SummarizingConversationManager               │
│   ├─ interventions: [PermissionGate extends InterventionHandler]       │
│   └─ printer: false（必须，否则 SDK 自带 stdout 输出与 Ink 抢终端）    │
└────────────────────────────────────────────────────────────────────────┘
        ▲                          ▲
   SkillLoader (自建)          McpRegistry (读 .mcp.json → McpClient[])
   skills/*/SKILL.md           stdio | streamableHttp
```

## 模块边界与契约

### 1. AgentRuntime（`src/agent/`）
- 组装 Agent：model、tools、sessionManager、conversationManager、hooks。
- 对 TUI 暴露单一接口：`send(userInput) → AsyncIterable<AgentEvent>`（直接透传 SDK 流事件，TUI 按事件类型渲染）。
- 不 fork SDK 的 agent loop；一切定制走 hooks。

### 2. PermissionGate（`src/agent/permission.ts`）
- **Spike 定案（2026-08-13，见 research/spike-results.md）**：用 SDK 原生 intervention 框架——继承 `InterventionHandler`，override `beforeToolCall(event)`，经 `AgentConfig.interventions: [gate]` 注入。不用裸 hook，不用 tool wrapper（原设计的"最大技术风险"已实测消除）。
- 决策返回 `InterventionActions.proceed()` 或 `InterventionActions.deny(自定义文案)`；**不要用 `confirm({response})`**（拒绝语义模糊，实测模型会误解）。deny 走 `event.cancel` → error ToolResultBlock 回灌模型，loop 不中断。
- 策略表按 `(toolName, input)` 二元判定，不是只按工具名：
  - `bash`：`mode === 'execute'` 需确认；`mode === 'restart'` 放行
  - `fileEditor`：`command === 'view'` 放行；`create` / `str_replace` / `insert` 需确认
  - `load_skill`：放行
  - MCP 工具：默认需确认
- 确认流程：`beforeToolCall` 内 `await` 一个由 TUI resolve 的 Promise（SDK 串行 await callback，实测可行）。
- 不直接用 SDK 自带 `HumanInTheLoop`：其 `allowedTools` 只按工具名匹配（无法只放行 fileEditor 的 view），`ask` 回调拿不到结构化 toolUse（TUI 无法分类型渲染）。但其源码是参考，将来"永久允许"可照抄 `agent.appState` 的 trustedTools 思路。

### 3. McpRegistry（`src/mcp/`）
- 读项目根 `.mcp.json`（Claude Code 格式：`mcpServers.<name>.{command,args,env}` → StdioClientTransport；`{url,headers}` → StreamableHTTPClientTransport）。
- 每个 server 构造一个 `McpClient`，作为 tool source 直接放入 Agent `tools` 数组（SDK 自动发现/注册/懒连接）。
- 退出时统一 `disconnect()`。

### 4. SkillLoader（`src/skills/`，唯一自建轮子）
- 对齐 Agent Skills 规范；将来 TS SDK 官方支持后整模块可删。
- SDK 有 `plugins?: Plugin[]` 扩展点（源码推断，未实测）——步骤 4 实现时优先评估做成 Plugin，接口不够用再退回普通模块。
- `scan(dir)`: 遍历 `skills/*/SKILL.md`，解析 frontmatter（name, description），错误容忍（坏 skill 跳过并警告）。
- 注入：system prompt 追加 `<available-skills>` 列表（仅 name+description，渐进披露）。
- `load_skill` 工具（`tool()` + zod）：入参 `name`，返回 SKILL.md 全文 + 资源目录文件列表（scripts/references/assets）。
- 斜杠命令路径：TUI 输入 `/name` → 将该 skill 全文包装进本次 user 消息。

### 5. TUI（`src/tui/`，Ink）
- `App`：状态机 idle → streaming → awaiting-permission。
- `MessageList`：历史消息 + 流式增量渲染（SDK 流事件聚合）。
- `ToolCallPanel`：工具名 + 入参摘要 + 结果折叠展示。
- `PermissionPrompt`：展示工具与入参（bash 显示命令；fileEditor 显示 path + 变更内容），y/n 键响应，resolve PermissionGate 的 Promise。
- `InputBox`：多行输入；`/` 前缀触发 skill 命令补全列表。

### 6. Config（`src/config.ts`）
- `config.json`：`{ provider: 'bedrock'|'anthropic'|'openai', model, region?, apiKeyEnv?, ... }`。
- `createModelFromConfig()` 映射到 SDK 对应 Model 类。默认 Bedrock，modelId 必须用 cross-region inference profile（`us.` / `global.` 前缀，裸 `anthropic.*` 不可用）；默认 `us.anthropic.claude-sonnet-4-6`，region 兜底链 `AWS_REGION → AWS_DEFAULT_REGION → 'us-west-2'`。
- 注意（spike 实测）：Agent 构造必须传 `printer: false`；token usage 取自 `result.lastMessage.toJSON().metadata.usage`（不在 `result.metrics`）。

## 关键数据流

1. 用户输入 → AgentRuntime.send() → SDK 流事件 → TUI 渲染。
2. 模型发起工具调用 → BeforeToolCallEvent → PermissionGate 判定 → (需要确认) TUI PermissionPrompt → resolve → 放行/拒绝 → 工具结果回流模型。
3. 每轮结束 SessionManager 自动快照 → `--resume` 时恢复。

## 权衡与取舍

- **确认框信息受 vended tool 入参限制**：fileEditor 的 str_replace 入参足以展示"改哪、改成什么"，但不是结构化 diff。接受此限制换取零自建工具；后续可用 hook 内读原文件计算 diff 增强。
- **异步等待用户确认**：已 spike 实测可行（intervention callback 串行 await），风险消除。
- **搜索工具不自建**：模型经 bash 跑 grep/rg；体验足够，省一个模块。
- **多 agent / 子代理**：SDK 有 Graph/Swarm，MVP 明确不做。

## 兼容与演进

- SkillLoader 接口贴 Python `AgentSkills` 语义，官方 TS 支持后替换成本≈删代码。
- provider 全走配置，不散落硬编码。
- `.mcp.json` 与 Claude Code 格式互通，用户可直接复用已有配置。

## 质量检查阶段的两处修正（2026-08-13）

- **Ctrl+C 取消当轮 → 权限队列必须可复用**：`PermissionQueue` 拆为 `denyPending()`（取消当轮用，队列继续可用）与 `close()`（仅退出用，上锁）。取消后复用 `close()` 会让后续所有确认静默拒绝。
- **退出兜底 `process.exit`（决策：接受）**：SDK 缺口——`BedrockModel.stream()` 未传 abortSignal，取消一轮后模型 HTTP socket 泄漏且公开 API 无清理入口。`cli.ts` 在 `await runtime.shutdown()` **之后**装 unref 的 500ms 强退兜底：清理全部先 await 完成、能干净退出的进程不受影响。SDK 补上 abortSignal 支持后此兜底可删（复验方法：`spike/probe-cancel-exit.ts`）。

## 回滚

- 全新代码库（当前 workspace 无业务代码），回滚 = revert commit，无外部状态。
