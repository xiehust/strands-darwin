# 入门与模型供应商

[English](getting-started.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 环境要求与安装

- Node.js `>=22.0.0`。
- npm，用于下面的全局安装。开发 darwin 本身使用 pnpm（仓库提交的是 pnpm lockfile）。
- 所选供应商的凭证；默认供应商是 AWS。

```bash
npm install -g strands-darwin
darwin --version      # darwin <version>
darwin doctor         # 离线只读诊断；发现问题时退出码 1
```

npm 包名是 `strands-darwin`，命令是 `darwin`。包的 `postinstall` 脚本会运行 `patch-package`，应用 darwin 固定的 Strands SDK 补丁（随包发布为 `dist/patches/@strands-agents+sdk+1.25.0.patch`），所以安装时必须允许脚本运行。如果脚本被跳过——`npm install --ignore-scripts`，或使用了不受支持的安装器——`darwin` 会在任何模型调用之前拒绝启动，只打印一条消息，说明缺失的补丁和修复方式：`npm install -g strands-darwin`。

不支持 `pnpm add -g strands-darwin`：pnpm 默认拦截依赖的构建脚本（`postinstall` 会进入 `ignoredBuilds`），即便加上 `--allow-build`，它的隔离目录布局也会把 SDK 放在包的旁边，而不是 `patch-package` 能找到的位置。

### 检查版本与升级

```bash
darwin update             # 立即查询 npm，只显示已安装版本与最新版本
darwin update --install   # 显式安装查到的更新版本
```

手动检查向官方 npm registry 发起一次请求，超时为 5 秒，不受启动提示的 24 小时缓存或
关闭开关限制。源码版也能检查；不会读取模型配置或启动会话。查询失败时显示错误并以
退出码 1 结束，参数错误为 2；检查成功为 0，无论是否存在更新。

`--install` 仅支持 POSIX 平台的 npm 全局安装。源码检出／链接版以及与 `npm prefix -g`
不匹配的安装会被拒绝，避免覆盖另一份程序。升级会使用用户的 npm 配置，将刚查到的
具体版本安装到同一 prefix，再运行已安装 CLI 的 `--version` 验证成功。不会调用
`sudo`、降级、自动重试或自动回滚。安装超时（10 分钟）或按 Ctrl+C 时，会终止 npm
进程组并提示安装可能不完整。完成后请重启其他 Darwin 会话。源码链接版应更新仓库后
执行 `pnpm build`。原有 SDK 补丁预检仍然有效；缺少补丁的安装需要按拒绝提示中的
手动 npm 命令修复。

### Bash 补全

在自选路径生成文件，检查内容后加载到当前 Bash：

```bash
darwin completion bash > darwin-completion.bash
source ./darwin-completion.bash
```

若需长期使用，把检查过的文件移到固定位置，再手动将 `source /your/chosen/path/darwin-completion.bash` 加入 Bash 启动文件。Darwin 不会安装补全或修改启动文件。升级后重新生成并加载；用 `complete -r darwin` 可移除当前 shell 的注册。

仅支持 Bash。生成的脚本静态补全命令、嵌套子命令、适用选项和固定取值，例如 `--permission-mode plan`、`--output-format stream-json`。提示词、ID、规则、URL、凭证、服务器名、路径和数字不提供候选，也不回退到文件名补全。`-p trajectory` 中的 `trajectory` 始终是提示词。补全过程只使用 Bash 内建能力，不运行 darwin，不探查文件、配置、会话或 MCP 状态。未知上下文不提供候选。它是语法辅助，不校验自由参数的实际有效性；已用选项会保守地省略。仅适用于打印模式的选项即使写在 `-p` 前，执行时也仍需 `-p`。

生成操作在本地完成，不写状态（用户显式的 shell 重定向除外），不启动 runtime、配置加载、会话、hook 或 MCP。SDK 补丁标记检查仍最先执行。`darwin -- completion bash` 等价；缺少 shell、未知 shell 或多余参数返回退出码 2；help/version 的优先级不变。见 [CLI 参考](reference.zh-CN.md#cli)。

### 开发路径：从克隆目录运行

```bash
git clone https://github.com/xiehust/strands-darwin.git
cd strands-darwin
pnpm install          # 通过 pnpm-workspace.yaml 的 patchedDependencies 应用 SDK 补丁
pnpm start            # 直接运行 TypeScript 源码，无需构建
```

`node-pty` 是真实 PTY 测试所需的原生开发依赖。pnpm 只构建工作区白名单中的原生包，`pnpm-workspace.yaml` 已经包含它。若增加其他原生依赖，需要同步扩充白名单。

### 从克隆目录安装全局 `darwin` 命令

若想让 `PATH` 上的 `darwin` 跟随克隆目录，请先构建再全局链接：

```bash
pnpm build            # 输出 dist/：CLI（bin 指向 dist/src/cli.js）、内置 skill 和 dist/patches/
pnpm add --global .
```

全局包链接到当前克隆目录，安装后请保留该目录。修改源码后，重新运行 `pnpm build` 以刷新被链接的 `dist/`。

### 全局命令排障

如果 `darwin` 启动时报 `Error: Cannot find module '.../pnpm/global/v11/<hash>/node_modules/strands-darwin/dist/src/cli.js'`，说明全局 shim 指向了一个已失效的 pnpm store 条目——通常发生在克隆目录被移动、重装被中断，或全局 store 被清理之后。判断特征是：`pnpm build` 成功、`node dist/src/cli.js` 也能跑，但 `darwin` shim 失败。针对当前克隆目录重新注册全局包即可：

```bash
pnpm remove --global strands-darwin   # 若提示 "not found in global packages" 可忽略，shim 已失效
pnpm build
pnpm add --global .
darwin doctor                 # 验证：离线只读诊断，不创建任何文件，发现问题时退出码 1
darwin sessions               # 验证：只读，不产生模型调用
```

会话拒绝启动或某个扩展看起来没有加载时，也应先运行 `darwin doctor`：它用启动时同一批加载器输出配置、MCP、技能、hook 和系统提示词的检查结果，但不启动会话、不调用模型、不连接 MCP，每个问题都以 `!` 标出。

## 当前工作目录就是项目

请从目标仓库中启动 darwin。CLI 的当前工作目录决定全部项目级指令和扩展从哪里读取：

```text
<your repo>/
├── AGENTS.md                    # 可选的常驻项目指令
├── .mcp.json                    # 根目录 MCP 后备配置
├── .agents/                     # 可移植的 agents/commands/skills/hooks
└── .darwin/
    ├── system-prompt.md         # 可选，用来替换基础 prompt
    ├── mcp.json                 # 项目 MCP 配置，优先于 .mcp.json
    ├── agents/                  # 子代理定义
    ├── commands/                # 自定义斜杠命令
    ├── hooks/                   # 直接放置 hook JSON 文件
    └── skills/                  # 每个 skill 一个目录
```

个人设置和生成状态位于 `~/.darwin/`，不会写入目标仓库。详情见[会话与状态](sessions-and-state.zh-CN.md)。

## 迁移本地提示词内容

启动会话前，在目标项目运行 `darwin import --from claude-code`。它只列出来源、目标路径和迁移计划，不改文件，不启动模型、hook、MCP 服务器或会话。Linux 上可用 `darwin import --from claude-code --apply` 复制支持的提示词内容；请先检查所有需手动迁移的项目。此操作不需要供应商凭证，不改 Claude Code 源文件，也不导入聊天、历史或可执行策略。详见[映射、冲突与上限](extensions.zh-CN.md#迁移-claude-code-设置)。无需导入也能继续使用根目录 `CLAUDE.md` 的既有回退机制；`@path` 不会展开。

## 启动与恢复

```bash
pnpm start                          # 新建 TUI 会话
pnpm start --resume                 # 恢复本项目最近会话；没有则新建
pnpm start --resume <id>            # 严格按 id 恢复
pnpm start --session <id>           # 同一套严格会话选择逻辑
pnpm tsx src/cli.ts sessions        # 只读列出可恢复会话
```

不存在或属于其他项目的 ID 会被拒绝，不会偷偷改为最近会话。`--session` 优先于兼容用法中的裸 `--resume`/`--continue`；`--session` 与 `--resume <id>` 同时出现属于参数错误。CLI 接受一个位于参数开头的常见 `--`，因此 `pnpm start -- --yolo` 与 `pnpm start --yolo` 等价。

## 默认模型目录

唯一生效的配置文件是 `~/.darwin/config.json`，项目内的 `.darwin/config.json` 不会读取。没有配置文件时，darwin 默认使用 `global.anthropic.claude-opus-5`，并通过 `/model` 提供以下内置项：

- `claude-sonnet-5`
- `claude-haiku-4.5`
- `claude-fable-5`
- `claude-opus-5`
- 通过 Bedrock Mantle 使用的 `gpt-5.6-sol`

Bedrock Claude 条目不固定 `region`，可由 `AWS_REGION` 选择。Mantle 条目固定为 `us-east-1`，该模型在此区域提供服务。自定义 `models` 数组会完全替换内置目录，不会与其合并。

## Amazon Bedrock

Bedrock 使用标准 AWS 凭证链，依次查找环境变量、共享配置和实例角色。Claude 模型 ID 必须是跨区域推理配置文件。服务会拒绝裸 `anthropic.*` ID；请使用 `us.`、`eu.`、`apac.` 或 `global.` 前缀。

```bash
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[?contains(inferenceProfileId, `anthropic`)].inferenceProfileId'
```

区域取值顺序为 `region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-west-2`。

## 直连 Anthropic

Anthropic 支持已经安装。`apiKeyEnv` 可指定密钥所在的环境变量；未指定时使用 `ANTHROPIC_API_KEY`；两者都没有时 darwin 拒绝启动并同时点名这两个选项。

任何兼容 Anthropic Messages API 的端点（网关、代理、中继）都可通过 `baseUrl` 接入，值必须是 `http:` 或 `https:` URL。未设置时依次回落到 `ANTHROPIC_BASE_URL` 和客户端默认的 `https://api.anthropic.com`。直连 OpenAI 也支持 `baseUrl`；Bedrock 以及 OpenAI 的 AWS 端点开关不可与它同时使用。

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "baseUrl": "https://gateway.example.com",
  "apiKeyEnv": "ANTHROPIC_API_KEY"
}
```

## OpenAI 与 Bedrock Mantle

OpenAI 支持已经安装。直连时默认读取 `OPENAI_API_KEY`，也可用 `apiKeyEnv` 指定变量名。`openaiApi` 默认为 `chat`；要求 Responses API 的模型应设为 `responses`。

当 `provider: "openai"` 且 `bedrockMantle: true` 时，darwin 改用 AWS 凭证和 Bedrock 的 OpenAI 兼容端点。此时必须省略 `apiKeyEnv`，两者不可同时设置。Mantle 模型目录因区域而异，也不同于普通 Bedrock 目录：

```bash
pnpm tsx spike/probe-mantle-catalog.ts us-east-1 us-west-2
```

当 `provider: "openai"` 且 `bedrockRuntime: true` 时，darwin 改走普通 Bedrock runtime 端点的 OpenAI 兼容接口（`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`），同样使用 AWS 凭证。模型名填跨区域推理配置（`global.openai.gpt-6-astra`、`us.openai.gpt-6-astra`）；内置的 `gpt-6-astra` 预置走的就是这条路，价格低于 Mantle 的区域内价。`bedrockRuntime`、`bedrockMantle` 与 `apiKeyEnv` 三者互斥。

## 通过登录 helper 接入 OpenAI 网关

直连 OpenAI 支持 `baseUrl`；未设置时依次使用 `OPENAI_BASE_URL` 和客户端默认地址。
需要动态 bearer token 和身份认证头的网关可以复用 llmar 等已安装的 helper。
先在 Darwin 外完成 `llmar login`；SSH 环境支持 `llmar login --no-browser`。
Darwin 不打开登录浏览器、不注册 OAuth 客户端，也不保存另一份 refresh token。

```json
{
  "provider": "openai",
  "name": "llmar",
  "model": "auto",
  "openaiApi": "responses",
  "baseUrl": "https://your-gateway.example.com/inference/v1",
  "headersCommand": {
    "command": "/home/ubuntu/bin/llmar",
    "args": ["headers"],
    "timeoutMs": 15000,
    "refreshIntervalMs": 240000
  },
  "contextWindowLimit": 1000000,
  "contextWarnRatio": 0.7
}
```

把 URL 和程序路径替换成你的配置。地址填到 `/v1`，不要追加 `/responses`，SDK 会追加资源路径。
多模型数组中，模型字段放进对应条目，`contextWarnRatio` 保留在根级。
上下文窗口是客户端声明，不代表网关保证；`0.7` 只提醒使用 `/compact`，**不会主动压缩**。
Darwin 会发送 `reasoning.effort`（默认 `high`），`auto` 必须支持它以及配置的输出预算。
使用 `auto` 权限模式时，还应配置网关支持的 `classifierModel`；OpenAI 默认分类模型为
`gpt-4o-mini`，不会自动采用主模型的 `auto` 名称。

helper 的约定如下：

- `command` 必须是绝对程序路径，最多 4096 字符，不经过 shell、不展开变量；
  `args` 默认为 `[]`，最多 32 个字符串，每个最多 4096 字符。
- `timeoutMs` 默认 `15000`，整数范围 `1–60000`；`refreshIntervalMs` 默认 `240000`，
  整数范围 `1–3600000`。仅在请求时检查缓存并刷新，没有后台定时器。
- stdout 必须包含 `Authorization: Bearer <token>`，可以再包含 `x-api-key: <token>`，
  每个头一行，名称不区分大小写，支持 LF/CRLF；拒绝其他头和重复名称。
  总输出最多 16 KiB，每个值最多 8192 字符，stderr 不会显示。
  此客户端关闭 SDK 日志；HTTP 错误响应最多 64 KiB，在 SDK 处理前去除当前凭据值。
  抛出的 SSE 错误也会脱敏；helper 失败时保留登录和重启提示，不被 SDK 的连接错误包装遮住。
  成功响应内容和流事件保持原样。
- helper 继承用户环境并带有 `DARWIN` 标记，stdin 关闭，工作目录为程序所在目录，而非项目目录。
  POSIX 上超时或取消会终止进程组；Windows 只终止直接子进程。
- 认证头只存在内存中，不进入模型配置或历史。同一已验证配置创建的模型共享一次正在进行的刷新和成功缓存；
  取消一个请求不影响其他等待者，最后一个等待者取消时会终止 helper。
- helper 失败后停止对该配置再次执行；完成登录或修复后重启 Darwin。刷新失败不使用过期凭据兜底。
  HTTP 401 不会触发刷新或重放，也没有 helper 自己的重试循环。
- 必须明确指定 HTTPS `baseUrl`（本地测试允许回环 HTTP），不能带 URL 用户信息、查询参数或 fragment。
  认证请求不能离开该地址的 origin 和路径前缀，禁止重定向。
  `headersCommand` 与 `apiKeyEnv`、`bedrockMantle`、`bedrockRuntime` 互斥；
  环境中的 `OPENAI_API_KEY` 不会成为认证失败时的替代密钥。

当前 `llmar headers` 把同一 access token 放入两个认证头，需要确认部署接受此约定；
它不等价于另外维护 Codex 的 `gateway_oauth` 登录。不要把 helper 输出或 refresh token 粘贴进提示词。

## 最小配置示例

```json
{
  "provider": "bedrock",
  "model": "global.anthropic.claude-opus-5",
  "permissionMode": "default"
}
```

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "apiKeyEnv": "OPENAI_API_KEY",
  "openaiApi": "responses"
}
```

全部字段和多模型配置见[配置与上下文](configuration.zh-CN.md)。

## 从改名前的版本迁移

旧路径已经停止读取。请把 `config.json` 移到 `~/.darwin/config.json`，把 skills 移到 `.darwin/skills/`。旧 `.strands-tui/` 会话无法恢复，因为快照路径包含已经变更的 agent ID；可直接删除该目录。
