# Spike 结果（2026-08-13，全部实测，非文档推断）

两个 spike 全部通过。`pnpm typecheck` 干净。

| Spike | 脚本 | 结果 |
|---|---|---|
| A 权限拦截 | `spike/permission-hook.ts` | 16 assertions passed / 0 failed |
| B Bedrock 流式 | `spike/bedrock-stream.ts` | 12 assertions passed / 0 failed |

复现：

```bash
AWS_REGION=us-west-2 pnpm tsx spike/permission-hook.ts
AWS_REGION=us-west-2 pnpm tsx spike/bedrock-stream.ts
pnpm typecheck
```

标注约定：下文全部为**实测**结论，除明确写「源码推断」处。

---

## 1. 包与版本

- 包名 `@strands-agents/sdk`（与 research 一致）。**安装 1.12.0**。
- npm `latest` 是 1.13.0，但 pnpm 11 默认 `minimumReleaseAge`（24h）把它挡住了 —— 1.13.0 发布于 2026-08-12T20:42Z，不足 24 小时。
  这是供应链安全默认值，不要用 `minimumReleaseAgeExclude` 绕过；等它自然过期即可升。
- Node v22.19.0，SDK 要求 `>=20.0.0`。
- 其余依赖：`ink@7.1.1`、`react@19.2.8`、`zod@4.4.3`、`@modelcontextprotocol/sdk@1.30.0`；dev：`typescript@7.0.2`、`tsx@4.23.12`。

### tsconfig 注意

TypeScript 7 下必须显式写 `"types": ["node"]`，否则 `console` / `process` / `setTimeout` 全部报未定义。

---

## 2. 真实 import 路径与 API 修正

research 文件里有两处**文档抄录错误**，实测已修正：

| research 里写的 | 实际可用 |
|---|---|
| `agent.hooks.addCallback(Event, cb)` | **`agent.addHook(Event, cb, { order? })`** —— `agent.hooks` 是 `undefined`，直接 TypeError |
| `new BedrockModel({ region, modelId, ... })` | 正确（扁平入参）。SDK d.ts 里另有 `{ modelConfig: {...} }` 的示例是**过期文档**，不要照抄 |

已确认存在于包根 `@strands-agents/sdk` 的导出：

```ts
Agent, BedrockModel, tool, InterventionHandler, InterventionActions,
BeforeToolCallEvent, AfterToolCallEvent, /* 及全部 hook 事件类 */
SessionManager, FileStorage,
SummarizingConversationManager, SlidingWindowConversationManager,
McpClient, Graph, Swarm, HookOrder
type AgentStreamEvent, ToolList, AgentConfig
```

子路径导出（已核对 package.json `exports`）：

```ts
'@strands-agents/sdk/vended-tools/bash'          // { bash, makeBash, makeShell }
'@strands-agents/sdk/vended-tools/file-editor'   // { fileEditor, makeFileEditor }
'@strands-agents/sdk/vended-interventions/hitl'  // { HumanInTheLoop }
'@strands-agents/sdk/models/{bedrock,anthropic,openai,google,vercel}'
```

**vended 工具的实际 tool name**（`allowedTools` / 策略表要用）：`bash`、`fileEditor`。

**已知缺口**：`InterventionAction` 联合类型**没有**从包根导出，且没有 `./interventions` 子路径。
自定义 handler 的返回类型只能从基类推导：

```ts
type InterventionAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>
```

---

## 3. 权限方案定论：用 SDK 原生 intervention 框架，自建 `InterventionHandler` 子类

**不需要回退到 tool wrapper。也不建议用裸 hook。**

### 三条原始问题的实测答案

1. **hook callback 能否 async 且 await 外部 Promise？** 能。
   `HookRegistry.invokeCallbacks` 对每个 callback 做 `await callback(event)`，串行等待。
   实测 hook 内 `await` 一个 250ms 后 resolve 的 Promise，测得实际耗时 ≥200ms，确认真的在等。
2. **能否把工具调用改写为「拒绝结果」而不中断 loop？** 能。
   `event.cancel = '<文本>'` → `ToolExecutor` 把它变成 `status: 'error'` 的 `ToolResultBlock` 回灌给模型，
   随后正常触发 `AfterToolCallEvent`，**不抛异常、不中断 agent loop**。
3. **拒绝后模型能否继续对话？** 能。实测 `stopReason === 'endTurn'`，模型读到拒绝结果后改口向用户解释。

### 但更好的选择：`interventions`

SDK 1.12 自带一套专门做「工具执行前人工干预」的框架，MVP 该直接用它，而不是裸 hook：

- `AgentConfig.interventions?: InterventionHandler[]`
- 继承 `InterventionHandler`，override `beforeToolCall(event)`，返回 `InterventionActions` 之一：
  `proceed()` / `deny(reason)` / `guide(feedback)` / `confirm(prompt, { response })` / `transform(apply)`
- 拿到的是**带类型的 event**，可以读 `event.toolUse.name` 和 `event.toolUse.input` 做策略判断。

选它而非裸 hook 的理由：语义清晰、有 audit trail、`onError`（`'throw' | 'proceed' | 'deny'`，默认 fail-closed）、
以后换成官方能力成本低。

### 关键坑：拒绝要用 `deny()`，不要用 `confirm({ response })`

实测 `confirm()` 被拒时，SDK 写入的是 `event.cancel = 'CONFIRMATION_FAILED: <prompt 原文>'`，
模型只看到「确认失败 + 提示语」，语义模糊（实测模型把它误解成「文件权限不足」）。

`deny(reason)` 写入 `event.cancel = 'DENIED: <你的文案>'`，文案完全可控。
所以正确写法是：**自己 await TUI 拿决定，approve → `proceed()`，deny → `deny(自定义文案)`**：

```ts
class PermissionGate extends InterventionHandler {
  readonly name = 'tui-permission-gate'

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    if (!requiresApproval(event)) return InterventionActions.proceed()
    const ok = await askTui(event.toolUse)          // 桥到 Ink PermissionPrompt
    if (ok) return InterventionActions.proceed()
    return InterventionActions.deny(
      `The user denied permission to run ${event.toolUse.name}. Do not retry it.`,
    )
  }
}
```

### 为什么不能直接用现成的 `HumanInTheLoop`

SDK 有 `HumanInTheLoop`（`vended-interventions/hitl`），支持 `allowedTools` 白名单、
`ask: 'stdio' | (prompt: string) => Promise<JSONValue>` 自定义 UI、`enableTrust`（记住"永久允许"）、
LLM 风险分类器。功能上很接近 PRD R2，但**两个硬伤**导致 MVP 不能直接用：

1. **`allowedTools` 只按工具名匹配**，而 `fileEditor` 是**单一工具名**同时覆盖读写
   （`command: 'view' | 'create' | 'str_replace' | 'insert'`）。按名字无法只放行 `view`。
   PRD R2 要求「读类操作不弹框」，必须看 `toolUse.input.command` —— 只有自建 handler 能做到。
2. **`ask` 回调只收到一个 `prompt: string`**，拿不到结构化的 `toolUse`，
   TUI 无法按 PRD 要求分别渲染「bash 显示命令 / fileEditor 显示 path + 变更内容」。

结论：抄 `HumanInTheLoop` 的思路，写自己的 handler。它的源码（`hitl.js`）是很好的参考，
`enableTrust` 用 `agent.appState` 存 `hitl:trustedTools`，将来做「永久允许」可照抄。

### 给 design.md 的修正建议

- `src/agent/permission.ts` 从「`BeforeToolCallEvent` hook」改为「`InterventionHandler` 子类 + `interventions: [...]`」。
- 策略表按 `(toolName, input)` 判定，不是只按 toolName：
  - `bash`：`mode === 'execute'` 需确认，`mode === 'restart'` 可放行
  - `fileEditor`：`command === 'view'` 放行；`create` / `str_replace` / `insert` 需确认
  - `load_skill`：放行
  - MCP 工具：默认需确认
- design.md 里「hook 内异步等待用户确认是本设计最大技术风险」这句可以删掉 —— 风险已消除，实测可行。

---

## 4. Bedrock

### 可用 modelId（`us-west-2`，本账号实测 `list-inference-profiles`）

必须用 cross-region inference profile 前缀（`us.` 或 `global.`），裸 `anthropic.*` 不可用。
账号内可用的 Claude 型号包括：

```
us.anthropic.claude-haiku-4-5-20251001-v1:0      ← spike 用这个（快/便宜）
us.anthropic.claude-sonnet-4-5-20250929-v1:0
us.anthropic.claude-sonnet-4-6
us.anthropic.claude-opus-4-8
us.anthropic.claude-fable-5
us.anthropic.claude-sonnet-5
us.anthropic.claude-opus-5
（以上均有对应 global.* 版本）
```

- 凭证：EC2 instance role，`aws sts get-caller-identity` 通，无需额外配置。
- region：环境变量 `AWS_REGION` 未设置，实例元数据是 `us-west-2`；代码里按
  `AWS_REGION → AWS_DEFAULT_REGION → 'us-west-2'` 兜底（见 `spike/shared.ts`）。
- 建议默认 model：`us.anthropic.claude-sonnet-4-6`（写代码够强）；spike / 测试用 haiku-4-5。
- 实测延迟（haiku-4-5，短 prompt）：首个 text delta ~850ms，整轮 ~930ms。

### 流事件清单（TUI 渲染依据，实测采集）

`agent.stream()` 产出 `AgentStreamEvent` 联合类型，用 `event.type` 判别。实测出现的**外层**事件：

| `event.type` | 用途 |
|---|---|
| `beforeInvocationEvent` / `afterInvocationEvent` | 一轮请求的起止 |
| `beforeModelCallEvent` / `afterModelCallEvent` | 每次模型调用（多轮工具会出现多次） |
| `modelStreamUpdateEvent` | **流式增量**，占绝大多数（一轮 20+ 条），内层见下 |
| `contentBlockEvent` | 一个 content block 组装完成（text / toolUse / reasoning） |
| `modelMessageEvent` | 模型一条完整消息 + `stopReason` |
| `messageAddedEvent` | 消息进入历史（user / assistant / toolResult 都会触发） |
| `beforeToolsEvent` / `afterToolsEvent` | 一批工具执行的起止 |
| `beforeToolCallEvent` / `afterToolCallEvent` | 单个工具调用起止；权限拦截点 |
| `toolResultEvent` | 工具结果（`ToolResultBlock`） |
| `agentResultEvent` | 流的最后一条，含 `AgentResult` |
| `interruptEvent` | 未实测（MVP 用 inline ask，不走 interrupt/resume 路径） |

`modelStreamUpdateEvent.event.type`（内层 `ModelStreamEvent`）：

| 内层 `type` | 说明 |
|---|---|
| `modelMessageStartEvent` | 消息开始 |
| `modelContentBlockStartEvent` | block 开始（toolUse 的名字在这里） |
| `modelContentBlockDeltaEvent` | **增量**；`.delta.type` 为 `textDelta` / `toolUseInputDelta` / `reasoningContentDelta` / `citationsDelta` |
| `modelContentBlockStopEvent` | block 结束 |
| `modelMessageStopEvent` | 消息结束 |
| `modelMetadataEvent` | usage / metrics |

**TUI 取流式文本的最小写法**：

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'modelStreamUpdateEvent'
      && event.event.type === 'modelContentBlockDeltaEvent'
      && event.event.delta.type === 'textDelta') {
    append(event.event.delta.text)
  }
}
```

### 两个实现细节

1. **`printer: false` 必须设**。`AgentConfig.printer` 默认开启，SDK 会自己往 stdout 打
   `🔧 Tool #1: xxx` / `⏳` / 流式文本，会和 Ink 抢终端。spike 里已确认关掉后 stdout 干净。
2. **token usage 不在 `result.metrics`**（`AgentMetrics` 是 telemetry meter，没有 `usage` 字段，实测取到 `null`）。
   实际位置：`result.lastMessage.toJSON().metadata.usage` → `{ inputTokens, outputTokens, totalTokens }`。

---

## 5. 后续验证记录

### 仍未验证（留给步骤 6 / 最终验收）

- `SummarizingConversationManager` 实际压缩行为（已确认挂载，未触发真实压缩）
- MCP **Streamable HTTP** 传输：配置路径已确认（SDK 按 `url` 自动选 transport，也支持显式
  `transport: 'sse' | 'streamable-http'`），但没有可用的公开 HTTP server 做实测，
  只实测了 stdio。属于**配置已验证 / 连接未实测**。
- PRD 验收标准 1 的完整端到端（真实 git 仓库里修一个真 bug）留给 team-lead 做最终验收。
  已实测的是 /tmp 下的等价流程（读→改→确认→落盘）。

---

### 步骤 1 + 2 实测记录（2026-08-13）

验证脚本（均实测通过）：

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts   # 21/21，直接驱动 AgentRuntime
AWS_REGION=us-west-2 pnpm tsx spike/drive-repl.ts        # 11/11，驱动真实 CLI
```

#### 坑 1：`Agent` 构造函数不做初始化，必须显式 `await agent.initialize()`

`SessionManager` 的恢复逻辑挂在 `InitializedEvent` 上，而该事件在 `Agent.initialize()` 里才派发；
构造函数**不**调用它，SDK 把初始化推迟到第一次 invoke。

后果：`new Agent({ sessionManager })` 之后立刻读 `agent.messages` 是**空的**，
即使磁盘上有快照。实测第一次就踩了：`--resume` 报 `restored: 0 messages`，
但接着提问却能答对（因为 `stream()` 内部会 initialize）—— 也就是功能对、可观测状态错。

修法：`AgentRuntime.create()` 里 `await agent.initialize()`。同一个调用也负责注册 MCP 工具，
所以步骤 3 加 MCP 后同样依赖它。

#### 坑 2：`sessionId` 有字符白名单，ISO 时间戳直接报错

SDK `session/validation.js`：id 只允许**小写字母、数字、连字符、下划线**。
`new Date().toISOString()` 里的 `T` 和 `:` 都会被拒：

```
Error: Identifier 'session-2026-08-13T08-57-42' can only contain
lowercase letters, numbers, hyphens, and underscores
```

现在生成 `session-20260813-091148` 形式。

#### 坑 3：`FileStorage` 已废弃，改用 `LocalFileStorage`

`FileStorage`（`@strands-agents/sdk` 根导出）的 d.ts 标了 `@deprecated`，
建议换成 `@strands-agents/sdk/storage` 的 `LocalFileStorage`（统一 `Storage` 接口）。
本项目已用后者。`SessionManagerConfig.storage` 两种都收（`Storage` 或 legacy `{ snapshot }`）。

#### 坑 4：管道喂 stdin 无法驱动 readline REPL

把答案预先 `printf | node repl.ts` 灌进去**不可行**：readline 在没有 pending question 时
会把到达的 line 事件丢弃，缓冲的 `y` 全部丢失，权限确认一律走到默认 deny；
且 stdin EOF 会在 agent 初始化期间就触发 `close`，第一个 `rl.question` 直接抛
`ERR_USE_AFTER_CLOSE`。

两个应对（都已落地）：
- REPL 侧：readline 接口**懒创建**（第一次提问时才建），并把 EOF 当作干净退出；
  确认提示读不到输入时**返回 deny**（不能默默放行）。
- 测试侧：`spike/drive-repl.ts` 改为**看到提示符才写回答**（监听 stdout 匹配
  `you> ` / `allow? [y/N]`），这样 question 已经 pending，输入不会被丢。

#### session 文件布局（实测）

放在**项目内** `.strands-tui/`（不是 `~/`）。理由：coding agent 的会话天然属于某个仓库，
放在仓库旁边让 `--resume` 自动按项目隔离，省掉 cwd→home 目录 slug 的映射，也便于查看/删除；
代价是需要一条 `.gitignore`。

```
<projectRoot>/.strands-tui/
├── last-session.json                    # { sessionId, updatedAt } —— --resume 的指针
└── sessions/session/<sessionId>/scopes/agent/<agentId>/snapshots/
    └── snapshot_latest.json
```

- `sessions/` 下多出一层 `session/` 是 SDK 用统一 `Storage` 时自己加的 namespace。
- **`<agentId>` 在路径里**：`AgentConfig.id` 默认 `'agent'`（稳定常量，不是随机值），
  但本项目显式设成 `'strands-darwin'`。**改这个 id 会让旧快照找不到**，等于丢历史。
- 一轮 40K 左右（`saveLatestOn: 'invocation'`，每轮结束覆盖写）。
- 指针文件在每轮**结束后**才写，未用过的 session 不会顶掉上一个有用的。

#### 其他

- `SummarizingConversationManager` 挂载确认方式：`agent._conversationManager.name ===
  'strands:summarizing-conversation-manager'`（私有字段，仅测试断言用，业务代码不依赖）。
- vended `bash` 是**持久** bash 进程，但实测不会阻止 Node 进程正常退出。
- `anthropic` / `openai` provider 的 model 模块依赖未安装的 peer deps
  （`@anthropic-ai/sdk`、`openai`），静态 import 会让默认 bedrock 装机直接崩。
  `createModelFromConfig()` 用**动态 import** + 缺包时给出 `pnpm add <包>` 提示。
- 端到端耗时参考（sonnet-4-6）：单轮改一个文件 + 跑一条命令约 30–60s；
  `verify-step-1-2.ts` 四个场景跑完约 9 分钟，跑它要给足超时。

---

### 步骤 3 + 4 实测记录（2026-08-13）

验证脚本（均实测通过）：

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts          # 18/18，真实 stdio MCP server
pnpm tsx spike/verify-skills.ts                            # 41/41，纯单测（无模型调用）
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts  # 10/10，两条触发路径走真实 REPL
```

#### MCP：SDK 已经把活干完了，registry 只剩两件事

design.md 原本假设要手写 transport 构造。实测 `McpClient.loadServers()` 已覆盖全部：

- **直接吃 Claude Code 的 `.mcp.json`**：loader 里是 `parsed.mcpServers ?? parsed`，
  包裹形式和裸 map 都行，不需要我们解包。
- 按字段自动选 transport（`command` → stdio，`url` → streamable-http），
  也支持显式 `transport: 'stdio' | 'sse' | 'streamable-http'`。
- `${VAR}` / `${env:VAR}` 插值（command、args、env、cwd、url、headers 全支持）。
- 每 server 支持 `disabled`、`prefix`、`toolFilters`、`auth`（OAuth m2m）、`cwd`。
- `~/` 开头的配置路径会展开成 home 目录。

所以 `src/mcp/registry.ts` 只需要：**文件不存在时返回空**，以及给所有 server 加
`continueOnError: true`。

**容错机制（实测）**：`continueOnError: true` 时连接失败 → client 进入 `'failed'` 状态 →
`listTools()` 返回 `[]`（不抛）。所以 `Agent.initialize()` 不会因为坏 server 失败。
实测配一个 `command: 'this-command-does-not-exist-anywhere'` 的 server，
启动照常完成，好 server 的 13 个工具全部注册。

#### 坑 5：我们自己的 `devEngines` 会让所有 npx 启动的 MCP server 挂掉

`pnpm init` 自动写进 package.json 的：

```json
"devEngines": { "packageManager": { "name": "pnpm", "version": "^11.21.0", "onFail": "download" } }
```

MCP stdio server 默认以 `process.cwd()` 启动（我们没传 `cwd`），
`npx` 会向上找 package.json，看到 `devEngines.packageManager` 要求 pnpm，
而 npx 自己是 npm，于是直接拒绝运行：

```
npm error code EBADDEVENGINES
npm error EBADDEVENGINES Invalid name "pnpm" does not match "npm" for "packageManager"
```

表现是 `MCP error -32000: Connection closed`，非常难从错误信息反推原因。
**已从 package.json 删掉 `devEngines`**（`engines.node` 保留）。
删掉后 13 个工具立刻正常发现。

这不只是本仓库的问题：任何在自己项目里写了 `devEngines` 的用户，
配 `npx` 类 MCP server 都会踩到。README（步骤 6）应提一句。

#### MCP 其他实测点

- `server-everything` 这个版本的加法工具叫 **`get-sum`**，不叫 `add`（文档/旧例子里是 `add`）。
- MCP 工具**自动走权限确认**：`classify()` 的 default 分支把未知工具判为 `execute`，
  实测 `get-sum` 弹框，`kind === 'execute'`，拒绝后模型正常改口。fail-closed 生效。
- 关闭时偶发一条无害警告：`client=<everything>, error=<Error: Not connected> |
  failed to refresh tools after toolsChanged notification` —— disconnect 与
  server 的 toolsChanged 通知竞争，不影响退出。
- 必须显式 `disconnect()`：stdio server 是 spawn 出来的子进程，
  已接到 `AgentRuntime.shutdown()` 并在 REPL 的 `finally` 里调用。

#### Skills：`Plugin` 接口够用，做成了 Plugin

评估结论（读 `plugins/plugin.d.ts`，实测验证）：**够用，已按 Plugin 实现**。
`Plugin` 提供的两个钩子正好对应需求：

- `getTools(): Tool[]` —— PluginRegistry 自动注册，runtime 不需要知道 skills 会贡献工具。
- `initAgent(agent)` —— `LocalAgent.systemPrompt` 是可写的 `string | SystemContentBlock[]`，
  且 agent 在**每次模型调用时**才读 `this.systemPrompt`（agent.js:1412），
  而 `initAgent` 在 `agent.initialize()` 期间跑（早于任何模型调用），所以在这里追加可靠生效。

唯一缺的是「专门的 prompt 贡献钩子」，所以注入是字符串拼接，并且只处理 `string` 形态；
遇到 block 数组形态直接抛错（block 数组带 cachePoint / guardContent，顺序有语义，不能瞎追加）。

这也和 Python SDK 把 `AgentSkills` 做成 plugin 一致，将来换官方实现接近「删代码」。

#### frontmatter 解析器选择：gray-matter

`yaml` 是 SDK 的**传递依赖**，pnpm 严格布局下我们的代码 require 不到（`MODULE_NOT_FOUND`）。
选 `gray-matter@4.0.3`（直接依赖）而不是手写解析：真实 SKILL.md 会用引号、
多行 description、以及我们不建模的额外字段，五行的手写解析器会静默解析错，
而 loader 的职责就是对作者的格式宽容。

#### 坑 6：斜杠命令内联全文后，模型还会多调一次 load_skill

`/commit-message` 已经把 SKILL.md 全文塞进消息了，但模型仍然额外调一次 `load_skill` ——
因为 system prompt 里写着「用某个 skill 前先调 load_skill 读全文」，它照做了。
浪费一次往返和一份 token。

修法：展开消息里显式加一句
`The full instructions for the "<name>" skill are included above — do not call load_skill for it.`
实测加了之后不再多调（`verify-skills-live.ts` 里有对应断言守着）。

#### Skills 其他实测点

- 两条触发路径都实测通过：
  (a) 只说「写个 commit message」，模型自己从 system prompt 的
  `<available-skills>` 认出来并调 `load_skill`，产出符合 skill 里规定的
  `type(scope): subject` 格式；
  (b) `/commit-message <要求>` 手动展开，同样符合格式。
- 容错：缺 description / YAML 语法错 / 重名 → 记进 `problems` 并跳过，好 skill 照常加载；
  没有 SKILL.md 的目录**静默忽略**（不算 problem，否则 skills/ 下放别的文件夹会一直报警）；
  `skills/` 目录整个不存在也不算 problem。
- `name` 缺省时回退用目录名。
- 没有任何 skill 时**不注册 `load_skill` 工具**、也不动 system prompt ——
  否则等于邀请模型去调一个必然报错的工具。
- 资源目录（`scripts` / `references` / `assets`）递归列文件，路径相对 skill 目录，
  连同全文一起返回给模型（skill 正文经常让模型去跑 `scripts/xxx.py`）。

---

### 步骤 5 实测记录（2026-08-13）

验证脚本：

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts              # 全部场景
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve      # 单个场景
```

#### Ink 7 + React 19 实测要点

- `useInput((input, key) => ...)`：第一个参数是**输入字符串**，第二个是 `Key` 对象。
  `Key` 里 `return` / `tab` / `upArrow` / `backspace` / `ctrl` / `escape` 等都是 boolean。
- `render(node, { exitOnCtrlC: false })` —— 必须关掉，否则 Ink 自己吞掉 Ctrl+C 直接退出，
  无法实现「第一次取消当轮、第二次退出」。
- `patchConsole` 默认 true（Ink 会接管 console.*），但渲染路径里仍然不要 `console.log`。
- `<Static items={[...]}>` 用来放已完成的历史：只画一次、不重绘，长对话不卡，
  且交给终端自己的 scrollback。注意传进去的数组必须是 append-only。
- `concurrent` 默认 false，本项目没开（并发渲染会改变 render 时机，MVP 不需要）。
- `exactOptionalPropertyTypes: true` 下**不能给 `<Text color={undefined}>`**，
  必须给确定值（改成 `selected ? 'cyan' : 'gray'`）。

#### 坑 7：一次到达的输入块含控制字符，会被整块丢掉（真实影响粘贴）

最早的实现把 `typed` 整体做控制字符检查，命中就 return。
但 pty（以及**真实的粘贴操作**）会把 `/exit\r` 这样一整块一次性送进来，
于是整块被丢弃 —— 表现为 TUI 完全不响应 `/exit`，测试一直挂到超时。

修法：先找 `\r` / `\n`，把换行前的部分当文本、换行本身当提交；
其余情况只**剥掉**控制字符而不是丢弃整块。

#### 坑 8（测试侧，很容易骗过自己）：Ink 每帧重绘，无锚点的 waitFor 会立刻返回

Ink 不是追加输出，而是反复重画整屏，所以累积缓冲里 `you>` 出现过无数次。
`waitFor('you>')` 在动作发生**之前**就已经匹配成功 →

1. 在编辑落盘前就去读文件 → 断言「文件已修改」假失败；
2. 在模型还在流式输出时就发 `/exit` → 此时输入被正确忽略 → TUI 永不退出 → 整个测试挂死。

两个症状看起来是产品 bug，其实都是测试的错。修法：驱动器加 `mark()`，
`waitFor(pattern, { from: mark })` 只在标记之后的输出里匹配。
等待「写操作完成」也要用 `✓ fileEditor str_replace` 而不是 `str_replace` ——
后者在权限确认框的文本里就有。

#### 状态机与交互决策（记录备查）

- 状态：`idle → streaming → idle`，`awaiting-permission` 从 streaming 进入。
  实现上 `awaiting-permission` 由「是否有 pending 确认」推导，优先级高于 streaming
  （因为 agent loop 此刻就是卡在这个 await 上）。
- **Ctrl+C**：streaming 中第一次 = 取消当轮（`agent.cancel()` + 拒掉排队的确认）并保留会话；
  2 秒内再按 = 退出；idle 时按 = 直接退出。Ctrl+D 总是退出。
  理由：误按一次不该让人丢掉整段对话，未完成的回答比丢会话便宜。
- **reasoningContentDelta**：不进正文，只把状态置为 thinking 并显示暗色 `thinking…`。
  推理文本和答复是两种语域，混排会被读成乱码/串台。
- **多行输入**：不做，单行。Ink 把 Enter 作为按键事件而非换行，
  支持多行要另设提交键 + 自己做折行与光标管理，MVP 不值得。已记为已知限制。
- **权限确认期间**输入框整体被确认框替换（不是禁用一个可见输入框），
  y/n/esc 由 App 的 useInput 直接消费。

#### 其他

- `PermissionQueue` 是 React 之外的小对象（`bridge` 给 runtime、组件用
  `useSyncExternalStore` 订阅）：因为 bridge 必须在任何组件挂载**之前**就交给
  `AgentRuntime.create()`。退出时 `close()` 把排队中的确认全部拒掉，
  避免 agent loop 卡在没人会回答的 await 上。
- 事件→视图的映射抽成纯函数 `turnReducer`（`src/tui/turn-state.ts`），
  不依赖终端，方便在 SDK 事件形状变化时单测。
- 工具调用摘要复用 `permission.ts` 的 `classify()`，确认框/进行中/已完成三处描述一致。
- node-pty 需要原生编译，pnpm 默认不跑 build script，要在
  `pnpm-workspace.yaml` 的 `allowBuilds` 里显式允许（`node-pty: true`）。
- `dev-repl.ts` 保留为调试入口（`pnpm dev-repl`）：怀疑是渲染问题时，
  用它跑同一个 AgentRuntime，能复现就说明问题在 agent 层而不是 Ink。

---

### 步骤 6 / 最终验收实测记录（2026-08-13）

#### 坑 9（最严重的一个，真实用户会踩）：vended bash 的常驻 shell 会让进程永不退出

**现象**：任何用过 `bash` 工具的会话，`/exit` 之后进程挂死。

**根因**：vended `bash` 按 agent 维持一个常驻 shell 子进程（`spawn('bash')`，stdio 全是管道）。
SDK 自己是有清理的：

```js
process.on('beforeExit', () => { cleanupAllSessions() })  // vended-tools/bash/bash.js
```

注释里写着「beforeExit fires when event loop is empty but process is still alive —
this is our chance to clean up bash processes before they prevent exit」。
但这是个死循环逻辑：`beforeExit` **只在事件循环已经空了**才触发，
而让循环非空的恰恰就是那些 stdio 管道。所以这个 handler 永远跑不到。
（`process.on('exit')` 同理 —— 进程根本走不到 exit。SIGINT/SIGTERM 的清理是有效的，
所以 Ctrl+C 杀掉能退，正常 `/exit` 不能。）

**修法**（用公开 API，不碰私有 `activeSessions`）：

```ts
// runtime.shutdown()
const bashTool = this.agent.tool['bash']
await bashTool?.invoke({ mode: 'restart' }, { recordDirectToolCall: false })
```

`mode: 'restart'` 的实现是「`stop()` 掉现有 session + 新建一个 BashSession 但**不 start**」
（`start()` 才 spawn 并注册进 activeSessions）。所以调完之后：活着的 shell 被 kill，
新 session 只是个对象、没有进程、没有 handle → 循环能空 → 进程正常退出。

配套细节：
- direct tool call（`agent.tool.x.invoke`）**不触发 `BeforeToolCallEvent`**，
  所以退出时不会弹权限框（顺带说：即便触发了也没事，策略表把 `bash restart` 判为 read）。
- `recordDirectToolCall: false` → 不写进对话历史。
- 和 MCP 的 `disconnectAll()` 一起放 `Promise.allSettled`，任一失败不影响另一个。
- **没有**用 `process.exit()` 兜底。不需要，而且那会跳过 MCP 的正常 disconnect。

**为什么前面五步都没抓到**：`verify-tui.ts` 原有场景全都在 prompt 里写了
「Do not run any shell commands」（为了让用例聚焦文件编辑、跑得快），
所以常驻 shell 从未被启动过。是 team-lead 写真实验收（要求模型自己跑 `node test.js`）才暴露。

**教训 + 回归防护**：新增 `verify-tui.ts` 的 `bashExit` 场景，
跑一条 `echo` → 批准 → `/exit`，30 秒内必须退出。
已用「临时去掉修复」验证过它真的会失败（`TUI did not exit within 30s after using bash`），
加回修复后 4–7 秒退出。**测试里为了跑得快而回避某类工具，就等于不测那条路径。**

#### 坑 10（测试侧）：固定尾窗口取信息会被长内容挤掉

`acceptance-e2e.ts` 原本从 `screen.slice(-400)` 里匹配 `permission required (\w+)` 取 kind。
但确认框的 details 可能很长（比如 `create` 带整个文件正文），
把框头部挤出这个 400 字符窗口 → 每个 kind 都读成 `unknown`。
改为对整屏 `matchAll` 取**最后一次**命中。
同类教训见坑 8：只要 Ink 在重绘 + 内容长度不可控，就不要用固定尾窗口做提取。

#### 最终全量结果

```
verify-config.ts       25/25   （纯配置，无模型调用）
verify-skills.ts       41/41   （纯文件系统/解析，无模型调用）
verify-step-1-2.ts     21/21
verify-mcp.ts          18/18
verify-skills-live.ts  10/10
verify-tui.ts          29/29   （含新增 bashExit）
acceptance-e2e.ts      10/10
pnpm typecheck         clean
```

AC 逐条核对见 implement.md 第 6 步。两处如实标注为「未 live 实测」：
MCP Streamable HTTP 连接（无公开 server）、Anthropic/OpenAI 真实推理（无 API key）；
两者的**配置路径**都有断言覆盖。

---

### 最终质量检查实测记录（2026-08-13，check agent）

全部为实测，两个新 bug 都做了「去掉修复即失败」验证。

#### 坑 11：Ctrl+C 取消当轮会**永久**废掉权限确认

`PermissionQueue.close()` 把 `closed = true` 之后再也不放开，而 `App.handleInterrupt`
原本调的就是 `close()`。后果：**按过一次 Ctrl+C 的会话，后续所有写/执行工具调用一律静默拒绝**
（`bridge` 里 `if (this.closed) resolve(false)`，确认框根本不出现）。

实测症状（去掉修复复现）：取消一轮后再让它改文件，屏幕上没有任何确认框，
agent 直接说 "The edit was denied. ... Would you like me to try again?" ——
用户从没看到过框，也没拒绝过任何东西。第二轮的 `permission required` 等待 240s 超时。

修法：拆成两个方法。`denyPending()` 只把排队中的确认拒掉、队列继续可用（Ctrl+C 用它）；
`close()` = `closed = true` + `denyPending()`（只有退出时用，见 cli.ts 的 finally）。

回归防护：`verify-tui.ts` 新增 `cancelThenContinue` 场景。

#### 坑 12：取消当轮会漏掉 model 的 HTTP socket，`/exit` 之后进程永不退出

和坑 9 同类但**另一个 handle**。`spike/probe-cancel-exit.ts`（无 Ink、无 pty，可复现）实测：

| 场景 | shutdown 后 `process.getActiveResourcesInfo()` | 是否退出 |
|---|---|---|
| 一轮正常跑完 | `["FSReqPromise"]` | 立即退出 |
| 中途 `agent.cancel()` | `["PipeWrap","PipeWrap","TCPSocketWrap"]` | **永不退出** |

根因在 SDK：`BedrockModel.stream()` 里 `await this._client.send(command)` **没有传 abortSignal**，
agent 取消时直接弃掉 `response.stream` 这个 async iterator，没人 destroy 那条连接。
`_client` 是 private，`StreamOptions` 也没有 signal 字段 —— **公开 API 拿不到清理入口**。

修法（`src/cli.ts`）：在 `await runtime.shutdown()` **之后**装一个 unref 的 500ms 兜底
`process.exit`。这与「不要用 process.exit 跳过 MCP disconnect」的原决定不冲突：
清理已经 await 完了，能干净退出的进程会先自己退出（unref 定时器不会拖住 loop）。
更彻底的修法要么反射私有 `_client.destroy()`，要么等 SDK 支持 abortSignal —— 留给 team-lead 决策。

#### 坑 13（测试侧）：Ink 一帧分多个 chunk 到达，「看最新一帧」的断言会读到半张屏

坑 8 加的 `mark()` 只解决了「匹配到旧帧」，没解决「匹配到**没画完**的新帧」。两个实测症状：
1. `waitForIdle` 的 `lastIndexOf('you>') > lastIndexOf('working…')` 在 chunk 边界正好落在
   输入行与 `working…` 提示之间时**误判为 idle** → 流式中发 `/exit` → 被正确忽略 → 30s 超时。
2. completion 场景 `waitFor('skills (')` 一命中就断言，而 `❯ /commit-message` 那一行在**下一个
   chunk** 才到 → `FAIL the skill is listed as a command`（日志里那行出现在下一帧开头可证）。

修法：driver 的 `waitUntil/waitFor` 加 `settleMs`（命中后隔一段时间复查，期间有新输出就重新计时），
`waitForIdle` 与 acceptance 的 idle 判定用 `settleMs: 400`；断言「某行存在」改为先 `waitFor` 那一行。
另加 `exitedWithin(ms)`：**退不出去本身就是 bug，不该让整个 suite 挂死**（原来 `exited()` 无超时，
坑 12 第一次就是把 suite 挂了 10 分钟才被发现）。

#### 复查后全量结果

```
verify-config.ts       31/31   （+6：数值区间、apiKeyEnv 真实生效）
verify-mcp-config.ts   11/11   （新增：.mcp.json 错误路径，无 server/模型）
verify-skills.ts       41/41
verify-step-1-2.ts     21/21   （改为 withRuntime，每个场景都 shutdown）
verify-mcp.ts          18/18
verify-skills-live.ts  10/10
verify-tui.ts          34/34   （+cancelThenContinue；连跑两遍均 34/34）
acceptance-e2e.ts      10/10
pnpm typecheck         clean
```
