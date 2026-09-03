# 入门与模型供应商

[English](getting-started.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 环境要求与安装

- Node.js `>=20.3.0`。
- pnpm。npm 也能安装依赖，但本仓库提交的是 pnpm lockfile。
- 所选供应商的凭证；默认供应商是 AWS。

```bash
git clone https://github.com/xiehust/strands-darwin.git
cd strands-darwin
pnpm install
pnpm start
```

`node-pty` 是真实 PTY 测试所需的原生开发依赖。pnpm 只构建工作区白名单中的原生包，`pnpm-workspace.yaml` 已经包含它。若增加其他原生依赖，需要同步扩充白名单。

### 全局 `darwin` 命令

`pnpm start` 直接运行 TypeScript 源码，无需构建。若想让 `darwin` 可执行文件进入 `PATH`，请先构建再全局安装：

```bash
pnpm build            # 产物写入 dist/；bin 指向 dist/src/cli.js
pnpm add --global .
```

全局包链接到当前克隆目录，安装后请保留该目录。修改源码后，重新运行 `pnpm build` 以刷新被链接的 `dist/`。

### 全局命令排障

如果 `darwin` 启动时报 `Error: Cannot find module '.../pnpm/global/v11/<hash>/node_modules/darwin/dist/src/cli.js'`，说明全局 shim 指向了一个已失效的 pnpm store 条目——通常发生在克隆目录被移动、重装被中断，或全局 store 被清理之后。判断特征是：`pnpm build` 成功、`node dist/src/cli.js` 也能跑，但 `darwin` shim 失败。针对当前克隆目录重新注册全局包即可：

```bash
pnpm remove --global darwin   # 若提示 "not found in global packages" 可忽略，shim 已失效
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

任何兼容 Anthropic Messages API 的端点（网关、代理、中继）都可通过 `baseUrl` 接入，值必须是 `http:` 或 `https:` URL。未设置时依次回落到 `ANTHROPIC_BASE_URL` 和客户端默认的 `https://api.anthropic.com`。其他 provider 设置 `baseUrl` 会被拒绝。

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
