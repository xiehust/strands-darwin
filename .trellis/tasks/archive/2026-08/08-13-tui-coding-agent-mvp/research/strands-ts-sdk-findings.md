# Strands TypeScript SDK 调研结论（2026-08-13，来源：Context7 官方文档）

包名：`@strands-agents/sdk`（文档库 ID：`/strands-agents/sdk-typescript`，网站文档：`/websites/strandsagents`）

## 可直接复用（不要自建）

### 模型 Provider
- 支持：Bedrock（默认）、Anthropic、OpenAI（chat + responses）、Google Gemini、Vercel AI SDK。
- `new BedrockModel({ region, modelId, maxTokens, temperature })`
- `new OpenAIModel({ api: 'chat' })`（自动读 `OPENAI_API_KEY`），import 自 `@strands-agents/sdk/models/openai`

### MCP
- `McpClient` + 官方 `@modelcontextprotocol/sdk` 的传输层：
  - stdio：`new McpClient({ transport: new StdioClientTransport({ command, args }) })`
  - HTTP：`new StreamableHTTPClientTransport(new URL(...), { requestInit: { headers } })`（支持 Bearer 认证）
- McpClient 直接放进 `Agent({ tools: [...] })` 即自动发现/注册工具；懒连接；结束时 `disconnect()`；支持 `Symbol.dispose`。

### Vended tools（`@strands-agents/sdk/vended-tools/*`）
- `bash`：入参 `{ mode: 'execute', command, timeout? }` 或 `{ mode: 'restart' }`；返回 `{ output, error }`；抛 `BashTimeoutError` / `BashSessionError`。
- `fileEditor`、`notebook`、HTTP request 工具。

### Session / Context
- `new SessionManager({ sessionId, storage: { snapshot: new FileStorage() } })` → `Agent({ sessionManager })` 自动快照持久化。
- `SummarizingConversationManager`（TS 已确认存在）：config `{ model?, summaryRatio?, preserveRecentMessages?, summarizationSystemPrompt? }`。
- 另有 `SlidingWindowConversationManager`。

### Hooks
- `agent.hooks.addCallback(BeforeToolCallEvent, (event) => { event.toolUse = {...event.toolUse, input: {...}} })`
- 可改写工具入参/切换工具；权限拦截挂这里。⚠️ 待 spike 验证：callback 是否可 async await 外部确认、能否注入"拒绝结果"。

### 自定义工具
- `tool({ name, description, inputSchema: z.object({...}), callback })`（zod 校验、类型安全）。

### Multi-agent（MVP 不用）
- Graph / Swarm；`Agent` 可 `asTool()`；tools 数组接受嵌套并自动展平。

## 缺口（必须自建）

### Skills
- 官方文档明确："Skills are not yet available in TypeScript SDK"。
- Python 版语义（对齐目标）：`AgentSkills(skills=[目录|父目录|Skill(name, description, instructions)])` 作为 plugin；SKILL.md = YAML frontmatter + markdown 正文；支持 scripts/references/assets 资源目录，激活时向 agent 提供文件列表；渐进披露（启动只注入 name+description）。

## 决策记录
- provider 默认 Bedrock，走配置抽象。
- 工具全用 vended（bash + fileEditor），搜索靠 bash 跑 grep/rg。
- 权限：BeforeToolCallEvent hook；回退方案 = 包装 vended tool callback。
- `.mcp.json` 沿用 Claude Code 格式。
