# Implement — TUI coding agent MVP

## 执行顺序（每步可独立验证）

### 0. Spike：验证两个技术风险 ⚠️ 先做 ✅ 完成（2026-08-13）
- [x] 初始化项目：pnpm + TypeScript 7 + `@strands-agents/sdk@1.12.0` + ink 7 + react 19 + zod 4。
- [x] Spike A：16/16 断言通过。定案：**用 SDK 原生 `InterventionHandler`（interventions 框架），不用裸 hook 也不用 tool wrapper**；`proceed()`/`deny(文案)`，不要用 `confirm()`。详见 research/spike-results.md。
- [x] Spike B：12/12 断言通过。Bedrock 走 EC2 instance role，modelId 必须用 `us.`/`global.` inference profile；流事件清单已采集；`printer: false` 必须设。
- 验证：`AWS_REGION=us-west-2 pnpm tsx spike/permission-hook.ts && pnpm tsx spike/bedrock-stream.ts`，`pnpm typecheck` 干净。

### 1. Agent 核心（无 TUI，CLI readline 驱动）✅ 完成（2026-08-13）
- [x] `src/config.ts` + `createModelFromConfig()`：bedrock/anthropic/openai 三分支；后两者用**动态 import**（peer deps 未装，静态 import 会崩默认 bedrock 装机）。
- [x] `src/agent/runtime.ts`：Agent 组装（vended bash + fileEditor、SessionManager + LocalFileStorage、SummarizingConversationManager、`printer: false`、`interventions: [gate]`），暴露 `send() → AsyncIterable<AgentStreamEvent>`。
- [x] `src/agent/session.ts`：会话落在项目内 `.strands-tui/`，`last-session.json` 作 `--resume` 指针。
- [x] `--resume` 标志恢复会话。**必须 `await agent.initialize()`**，否则恢复的历史读不到（详见 research/spike-results.md 坑 1）。
- 验证：`pnpm tsx spike/verify-step-1-2.ts` 21/21；`pnpm tsx spike/drive-repl.ts` 11/11（真实 CLI + 跨进程 resume 恢复 6 条历史）。

### 2. PermissionGate ✅ 完成（2026-08-13）
- [x] `src/agent/permission.ts`：`InterventionHandler` 子类 + `(toolName, input)` 策略表；`PermissionBridge` 抽象（readline 实现，步骤 5 换 Ink 只换实现）。
- [x] `PermissionRequest` 带结构化信息：`toolName` / `kind` / `summary` / `details[]` / 原始 `input`；bash 给 Command，fileEditor 给 Path + Operation + Replace/With。
- [x] 拒绝路径：`deny()` 文案明确"用户拒绝，不要重试"；实测文件未被改动、模型改口、loop 不中断。
- 验证：读操作不弹框（实测 3 次 fileEditor 调用只弹 1 次写确认）；写/执行弹框；输 n 后 agent 改口。

### 3. MCP ✅ 完成（2026-08-13）
- [x] `src/mcp/registry.ts`：**比预想薄很多** —— `McpClient.loadServers()` 已原生吃 Claude Code `.mcp.json`（loader 内是 `parsed.mcpServers ?? parsed`）、自动选 transport（stdio / streamable-http / sse）、做 `${VAR}` 插值、支持 disabled/prefix/toolFilters。registry 只负责「文件不存在=无 MCP」+ 全局 `continueOnError: true`。
- [x] 容错：坏 server 连接失败 → `listTools()` 返回 `[]` 而非抛错，启动不受影响（实测配一个不存在的 command，好 server 的 13 个工具照常注册）。
- [x] `disconnectAll()` 接进 `AgentRuntime.shutdown()`，REPL 在 `finally` 调用（stdio server 是子进程，必须回收）。
- 验证：`pnpm tsx spike/verify-mcp.ts` 18/18 —— 真实 `@modelcontextprotocol/server-everything`，模型调用 `get-sum`（注意：不叫 `add`）得到 42；MCP 工具**自动触发权限确认**且 `kind === 'execute'`（classify 的 fail-closed default 分支），拒绝后模型正常改口。
- ⚠️ 踩坑：`pnpm init` 自动写的 `devEngines.packageManager` 会让所有 `npx` 启动的 MCP server 报 `EBADDEVENGINES`（表现为 `Connection closed`，极难反推）。已从 package.json 删除；README 需提醒用户。
- 未实测：Streamable HTTP 连接（配置路径已确认，缺公开 HTTP server）。

### 4. SkillLoader ✅ 完成（2026-08-13）
- [x] **Plugin 评估结论：接口够用，已做成 `Plugin`**（`src/skills/plugin.ts`）。`getTools()` 自动注册 `load_skill`；`initAgent(agent)` 追加 system prompt —— `LocalAgent.systemPrompt` 可写，且 agent 每次模型调用才读它，`initAgent` 早于任何模型调用，故可靠生效。唯一缺陷是没有专门的 prompt 贡献钩子，故为字符串拼接，block 数组形态直接抛错（顺序有 cachePoint 语义，不能瞎追加）。与 Python `AgentSkills` 同为 plugin，将来换官方实现≈删代码。
- [x] `src/skills/loader.ts`：扫描 + frontmatter 解析。**选 gray-matter**（`yaml` 是 SDK 传递依赖，pnpm 严格布局下 require 不到；且真实 SKILL.md 有引号/多行/额外字段，手写解析器会静默解析错）。坏 skill（缺 description / YAML 错 / 重名）记入 `problems` 并跳过；无 SKILL.md 的目录静默忽略。
- [x] system prompt 注入 `<available-skills>`（仅 name+description，渐进披露）；`load_skill` 返回全文 + `scripts`/`references`/`assets` 递归文件列表。无 skill 时不注册工具、不动 prompt。
- [x] `expandSkillCommand()` 斜杠命令展开（供 TUI 用）：不匹配返回 null，`/exit` 等原样放行；保留命令后的文本作为请求；大小写不敏感。
- 验证：`pnpm tsx spike/verify-skills.ts` 41/41（纯单测）；`pnpm tsx spike/verify-skills-live.ts` 10/10 —— (a) 只说「写个 commit message」模型自主调 `load_skill` 并产出 skill 规定的 `type(scope):` 格式；(b) `/commit-message` 手动展开同样合规。
- ⚠️ 踩坑：斜杠命令已内联全文，模型仍会多调一次 `load_skill`（system prompt 让它这么做）。展开消息里加一句「全文已在上方，不要调 load_skill」后消除，已有断言守着。

### 5. TUI（Ink）✅ 完成（2026-08-13）
- [x] `src/tui/App.tsx` 状态机 `idle → streaming → idle`，`awaiting-permission` 由「是否有 pending 确认」推导且优先级最高（agent loop 此刻正卡在那个 await 上）。
- [x] `MessageList`：已完成历史走 Ink `<Static>`（只画一次、不重绘，长对话交给终端 scrollback），下方渲染流式增量。事件映射照 research 清单：`textDelta` 追加、`contentBlockEvent`(textBlock) 收口为权威文本、`toolResultEvent`/`afterToolCallEvent` 折叠展示。
- [x] `reasoningContentDelta` **不进正文**，只置 thinking 态显示暗色 `thinking…`（推理与答复是两种语域，混排会被读成串台）。
- [x] `ToolCallPanel`：进行中 spinner + `classify()` 的 summary；完成态 `✓/⊘/✗` + 结果折叠前 4 行。摘要**复用 permission.ts 的 `classify()`**，未另写一套。
- [x] `PermissionPrompt`：渲染 `PermissionRequest` 的 summary + 每个 details label 块，y/n/esc 响应；确认期间输入框被整体替换（非「禁用一个可见输入框」）。`PermissionQueue`（React 之外的小对象 + `useSyncExternalStore`）实现 `PermissionBridge`，取代 readline 桥。
- [x] `InputBox`：`/` 前缀显示 skill 补全列表，↑/↓ 选择、tab/enter 补全，接 `expandSkillCommand`。**单行输入**（已知限制，见下）。
- [x] bin 入口：`package.json` 加 `bin.strands-tui` + `scripts.start`（`tsx src/cli.ts`），`--resume` 透传；`dev-repl.ts` 保留为调试入口（`pnpm dev-repl`）并在文件头注明已被 TUI 取代。
- [x] Ctrl+C 决策：`render(..., { exitOnCtrlC: false })` 自己处理 —— streaming 中第一次取消当轮（`agent.cancel()` + 拒掉排队确认）并保留会话，2 秒内再按退出；idle 时按直接退出；Ctrl+D 总是退出。理由：误按一次不该丢整段对话。
- 验证：`pnpm tsx spike/verify-tui.ts` **26/26**（node-pty 真实 pty 驱动真实 TUI，全程约 20s）。approve 路径：流式文本出现 → `fileEditor view` 不弹框 → 写操作弹框且含 Path/With → 按 y 后**文件真被改**（`n * 2`）→ `/exit` 干净退出；deny 路径：按 n 后文件未动、显示 ⊘、模型改口；补全路径：输 `/` 出现列表含 `/commit-message`，改成不匹配前缀后列表消失，idle 时 ctrl+c 退出。
- 已知限制：**单行输入**。Ink 把 Enter 作为按键事件而非换行，多行要另设提交键 + 自己做折行与光标管理，MVP 不划算。
- ⚠️ 踩坑（详见 research/spike-results.md 坑 7/8）：(1) 一次到达的输入块含控制字符会被整块丢弃 —— **真实影响粘贴**，已改为「换行处提交、其余剥离控制字符」；(2) Ink 每帧重绘，无锚点 `waitFor` 会立刻命中旧帧，导致「在写入落盘前读文件」和「流式中发 /exit 被正确忽略→测试挂死」两个假象，驱动器已加 `mark()` / `waitUntil()`，且「回到 idle」必须用 `working…` 提示消失判定（`you>` 在忙时也会画）。

### 6. 收尾 ✅ 完成（2026-08-13）
- [x] README.md：定位、安装（Node >= 20 / pnpm / node-pty 原生编译说明）、`pnpm start [--resume]`、按键表、`config.json` 全字段表 + provider 切换 + Bedrock inference profile 与 `list-inference-profiles` 命令、权限策略表（含 fail-closed 说明）、`.mcp.json`（Claude Code 格式即用 + **devEngines/EBADDEVENGINES 坑**单独 callout）、`skills/` 目录与 SKILL.md 格式 + 两条触发路径、会话与 `--resume`（含 `.strands-tui/` 与 agentId 警告）、已知限制、开发与验证脚本清单。
- [x] 修复退出挂死 bug（详见下方「退出挂死」一节）。
- [x] 逐条核对 PRD Acceptance Criteria（下表）。

#### 全量验证脚本结果（2026-08-13，修复后重跑）

| 脚本 | 断言 | 说明 |
|---|---|---|
| `spike/verify-config.ts` | 25/25 | 纯配置，无模型调用 |
| `spike/verify-skills.ts` | 41/41 | 纯文件系统/解析，无模型调用 |
| `spike/verify-step-1-2.ts` | 21/21 | agent 核心 / 权限 / resume |
| `spike/verify-mcp.ts` | 18/18 | 真实 stdio MCP server |
| `spike/verify-skills-live.ts` | 10/10 | 两条 skill 触发路径 |
| `spike/verify-tui.ts` | 29/29 | 真实 pty 驱动真实 TUI（含新增 bashExit 场景） |
| `spike/acceptance-e2e.ts` | 10/10 | 真实 git 仓库 读→改→跑测试自证 |
| `pnpm typecheck` | clean | |

#### PRD Acceptance Criteria 核对

| # | 标准 | 结果 | 证据 |
|---|---|---|---|
| AC1 | 真实 git 仓库里对话完成一次真实代码修改（读→改→跑命令验证），全程流式可见 | ✅ **通过** | `acceptance-e2e.ts` 10/10：真实 `git init` 仓库，模型自行决定顺序（实测 execute→execute→write→execute），改完自己跑 `node test.js` 得到 PASS；`git diff --stat` 显示 `greet.js \| 2 +-`；独立复跑 `node test.js` 也 PASS；断言含「assistant streamed text during the turn」 |
| AC2 | 写/bash 前弹确认框；拒绝后 agent 收到拒绝结果并继续对话；读类不弹框 | ✅ **通过** | `verify-tui.ts` approve/deny/bashExit 场景（确认框含 Path/With、`fileEditor view` 不弹框、按 n 后文件未动 + 显示 ⊘ + 模型改口）；`verify-step-1-2.ts` Criterion 1/2（3 次 fileEditor 调用只弹 1 次写确认）；策略表按 `(toolName, input)` 判定 |
| AC3 | `.mcp.json` 配 stdio server 后能发现并调用其工具；Streamable HTTP 同样可配 | ⚠️ **stdio 通过 / HTTP 配置已确认但未 live 实测** | stdio：`verify-mcp.ts` 18/18，真实 `@modelcontextprotocol/server-everything`，发现 13 个工具，调用 `get-sum` 得 42，且**自动触发权限确认**（kind=execute）。HTTP：SDK loader 按 `url` 自动选 streamable-http、也支持显式 `transport`，配置路径已读源码确认，但**无可用公开 HTTP MCP server，未做真实连接**。如实记录，未声称通过 |
| AC4 | 放入含 SKILL.md 的 skill 后：(a) 模型自主 `load_skill`；(b) `/skill-name` 手动加载 | ✅ **通过** | `verify-skills-live.ts` 10/10：(a) 只说「写个 commit message」→ 模型自主调 `load_skill` 并产出 skill 规定的 `type(scope):` 格式；(b) `/commit-message` 手动展开同样合规且不再多调 load_skill。另 `verify-skills.ts` 41/41 覆盖扫描/容错/渐进披露/展开边界 |
| AC5 | 退出后 `--resume` 重启，上次对话上下文恢复 | ✅ **通过** | `verify-step-1-2.ts` Criterion 3：跨两个独立 runtime，session id 一致、`resumed=true`、恢复 2 条历史、追问答对随机 token；`drive-repl.ts` 另在**跨进程**真实 CLI 上验证过（恢复 6 条历史后答对「刚改的哪个文件」） |
| AC6 | provider 从 Bedrock 切到其他只改配置文件，不改代码 | ✅ **通过（构造路径）** | `verify-config.ts` 25/25：三个 provider 均能从 config.json 选中；bedrock 默认配置能真正构造出 model；anthropic/openai 走到 provider 构造后因**未安装 peer dep** 报 ConfigError 并给出 `pnpm add <包>` —— 证明切换是纯配置、代码零改动。**未做**：真实 Anthropic/OpenAI 推理（无 API key） |

#### 退出挂死 bug（team-lead 验收时发现，已修）

- 现象：**用过 bash 工具**的会话，`/exit` 后进程永不退出。
- 根因：vended `bash` 维持每个 agent 一个常驻 shell 子进程，其 stdio 管道是活跃 handle。
  SDK 自己注册了 `process.on('beforeExit', cleanupAllSessions)`，但 `beforeExit` **只在事件循环空了才触发** ——
  而正是那些管道让循环非空，于是该清理永远跑不到。`runtime.shutdown()` 当时只回收了 MCP。
- 修复：`shutdown()` 里通过**公开 API** 直接调用 bash 工具的 `restart` 模式：
  `agent.tool['bash'].invoke({ mode: 'restart' }, { recordDirectToolCall: false })`。
  `restart` 会 `stop()` 掉在跑的 shell，并只**懒创建**新 session（不 spawn 进程），因此不再有 handle 拖住循环。
  direct tool call 不触发 `BeforeToolCallEvent`，所以退出时不会弹权限框；`recordDirectToolCall: false` 保证不污染历史。
  与 MCP 清理一起放进 `Promise.allSettled`，任一失败不阻塞另一个。**没有**用 `process.exit()` 兜底 —— 不需要。
- 回归防护：`verify-tui.ts` 新增 `bashExit` 场景（跑一条 `echo`、批准、然后 `/exit`，30s 内必须退出）。
  已实测**去掉修复即失败**（`TUI did not exit within 30s after using bash`），加回即通过（4–7s 退出）。
- 为什么之前没抓到：verify-tui 原有用例都写了「Do not run any shell commands」，从未启动过常驻 shell。
- 顺手修 `acceptance-e2e.ts`：kind 提取原本只在末尾 400 字符窗口里匹配，长 details（大文件正文）会把确认框头部挤出窗口 → 全部读成 `unknown`；改为对整屏 `matchAll` 取最后一次命中。

## 验证命令

```bash
pnpm typecheck && pnpm test   # test = verify-config + verify-skills（无模型调用）
pnpm start                    # TUI 手动端到端
pnpm start --resume           # 会话恢复
```

模型相关的验证脚本要单独跑（见下表与 README「Development」）。
**没有配 linter**（无 eslint 依赖 / 无 `pnpm lint`）：静态门禁只有 `pnpm typecheck`。
原先这里写的 `pnpm lint && pnpm test` 是不存在的 script，`test` 已补上，`lint` 按未配置如实记录。

## Review gates

- 步骤 0 结束：若 Spike A 失败，回规划改 design.md（权限拦截方案换成 tool wrapper），再继续。
- 步骤 2 结束：权限模型演示给用户确认交互形态。
- 步骤 5 结束：端到端 demo 后再进收尾。

## 回滚点

- 每步一个 commit；任一步失败 revert 该步 commit 即可，无外部状态。
