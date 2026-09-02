# 命令与按键参考

[English](reference.md) · **简体中文** · [指南首页](README.zh-CN.md)

## CLI

```bash
darwin                                      # 新建 TUI
darwin --resume                             # 恢复本项目最近会话
darwin --resume <id>                        # 指定会话
darwin --session <id>                       # 指定会话，包括 fork
darwin sessions                             # 可恢复快照
darwin -p "prompt"                          # 单次文本模式
darwin -p "prompt" --continue               # 跟随最近指针
darwin -p "prompt" --output-format json
darwin -p "prompt" --output-format stream-json
darwin trajectory list
darwin trajectory search "text" [--session <id>]
darwin trajectory replay <id> [--turn N] [--json]
darwin trajectory fork <id>
darwin --help                               # 用法语法，退出码 0
darwin --version                            # darwin <version>，退出码 0
```

`darwin --help`（或 `-h`）把下面的语法原文打印到 stdout 并以 0 退出；`darwin --version`（或 `-V`）打印取自 `package.json` 的 `darwin <version>`。两者都在解析其余参数、加载运行时、配置或模型之前就地回答，不写任何文件；只要 argv 里出现其中一个，它就优先于其他所有参数（help 又优先于 version）。下面这段引自 `src/cli-usage.ts` 的 `CLI_USAGE`，由 `spike/verify-cli-args.ts` 锁定：

```text
Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
       darwin -p <message> [--output-format text|json|stream-json]
         [--continue|--resume [<id>]|--session <id>] [permission flags]
         [--max-model-calls <n>] [--context-offload] [--compact-before]
       darwin sessions
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
With -p, piped (non-TTY) stdin is read to EOF and appended to <message> as one delimited block (256 KiB cap).
```

只用于 print 模式的选项：`--context-offload`（进程级强制开启；卸载默认已开启）、正整数 `--max-model-calls <n>`、`--compact-before`、`--output-format text|json|stream-json`。权限覆盖选项：`--permission-mode default|auto|plan|yolo`、`--yolo`。为兼容包管理器传参，位于开头的一个独立 `--` 会忽略。未知或非法参数语法返回 2：stderr 先打印 `error: <message>`，再跟一行提示 `Run \`darwin --help\` for usage.`。

### `-p` 与管道 stdin

`git diff | darwin -p "review this change"` 会把两者一起发送。当 `-p` 运行时 stdin 不是终端，darwin 会把它读到 EOF，然后作为**恰好一个**带定界符的块追加到消息之后——先是消息本身，再一个空行，然后是：

```text
--- piped stdin (<N> bytes) ---
<管道文本，原样>
--- end of piped stdin ---
```

`<N>` 是原始字节数；只有在文本末尾没有换行时才会在结尾定界符前补一个换行。拼接后的文本就是唯一的一条用户输入：模型收到的是它，会话轨迹的 `userInput` 记录的是它（仍受既有的 8,000 码点字段上限约束），`darwin trajectory replay` 显示的也是它。`json` / `stream-json` 信封不会新增任何字段——它们本来就不回显 prompt。

规则与限制：

- 终端 stdin、`/dev/null`、立即 EOF 或只有空白的输入不会追加任何内容——这次运行与没有管道时逐字节相同，也不会打印任何提示。交互式 TUI 从不以这种方式读取 stdin。
- 上限：**256 KiB**（262,144 字节）。更大的输入会在任何会话或模型工作之前被拒绝，形式为用法错误（`error: piped standard input exceeds the 262144-byte cap for -p; …`，随后是 `--help` 提示行，退出码 2）。darwin 绝不会悄悄截断这个块；请少传一些（`head -c`、过滤器）或改为在消息里写出文件路径。
- 输入必须是不含 NUL 字节的 UTF-8 文本；二进制输入会以同样方式被拒绝。字节永远不会以 base64 发送。
- 注意事项（与 `cat` 相同）：父进程若一直握着管道却不写入，`-p` 会一直等待 EOF。无意提供输入时请从 `/dev/null` 重定向（或像 developer skill 的后台 `bash start` 任务那样以 `stdio: 'ignore'` 启动）。

## 斜杠命令与内置 skill 入口

`/` 补全会把以下命令与项目 skills、自定义命令一起列出。

| 命令 | 行为 |
|---|---|
| `/agents` | 当前运行的有界派发列表；只有元数据 |
| `/clear` | 创建后继会话；继承当前模式；丢弃队列 |
| `/compact [focus]` | 摘要较旧对话；由用户主动触发。可选的 focus 文本（去除首尾空白后不超过 400 个码点，超出则提示拒绝且不执行）会作为一个固定小节追加到 SDK 默认摘要提示之后，要求摘要保留其所述内容；不带 focus 时摘要请求与以往完全一致 |
| `/context` | 已知/估算的上下文大小；Bedrock 可能使用启发式 |
| `/effort [level]` | 查看或设置会持久化的模型思考强度 |
| `/exit`、`/quit` | 退出 |
| `/export <path>` | 精确 replay 投影；不覆盖，也不写会话内部 |
| `/help` | 有界本地命令、语法和按键；带参数会拒绝 |
| `/mcp` | 只读服务器状态/工具/配置路径；不重连 |
| `/memory`、`/memory list` | 含来源、证据、校验/过期原因的条目 |
| `/memory show <id|number>` | 查看一个有界条目 |
| `/memory remember <note>` | 添加经过筛查的用户项目备注 |
| `/memory forget <id/number/all>` | 删除/抑制条目并刷新当前 prompt |
| `/mode [mode]` | 查看/设置仅用户可改的当前权限模式；不持久化 |
| `/model [name]` | 列出/切换已配置模型，会话不断开 |
| `/permissions` | 当前放行规则及来源 |
| `/permissions revoke <n/rule/all>` | 同步收紧 gate 和磁盘规则 |
| `/status` | 只读汇总模型/缓存/强度/模式/MCP/skills/费用/上下文 |
| `/tasks` | 后台任务；忙碌时也可用 |
| `/trajectory` | 当前运行的本地记录状态 |
| `/usage` | 当前进程 token 分桶；未报告不等于零 |
| `/workflow <task>` | 请模型把任务编排为一次 `workflow` DAG 调用；不带参数时打印用法 |
| `/skill-name [request]` | 显式加载并发送一个 skill |
| `/developer <requirement>` | 监督一个完整、可持续的无头 worker |
| `/self-evolution-research` | 内置 skill：待办/研究/评分/受监督迭代循环 |
| `/self-reflection [session id]` | 内置 skill：基于轨迹复盘，达标建议进入 backlog |

`/help`、`/mcp`、`/permissions`、`/status`、`/tasks`、`/trajectory`、`/usage`、记忆管理等报告命令读取本地状态，不会把报告发送给模型；只有文档明确说明会更新当前 prompt 的变更命令例外。忙碌时 `/clear`、`/compact`、`/model`、`/exit`、`/quit` 会拒绝，普通输入进入队列。

## 输入语法

| 语法 | 行为 |
|---|---|
| `/prefix` | 补全内置/自定义命令和 skill |
| `@path` | 补全工作区路径；只插入文本，不插入文件内容 |
| `!command` | 用户授权的单次本地 shell 命令 |
| 普通文本 | 模型提示词；忙碌时排队 |

## 按键

| 按键 | 行为 |
|---|---|
| `Enter` | 有选中补全项时接受，否则发送或排队 |
| `Ctrl+J`、行尾 `\` + `Enter` | 插入换行；多行粘贴保留全部行 |
| `Tab` | 接受选中的补全项 |
| `Up` / `Down` | 先操作菜单，再取回队列、回看历史或移动多行光标 |
| `Escape` | 关闭当前补全菜单或结束历史回看；保留草稿和光标（权限框中仍表示拒绝） |
| `Home` / `End`、`Ctrl+A` / `Ctrl+E` | 移到可见行开头/结尾 |
| `Ctrl+K` / `Ctrl+U` | 删除到行尾/行首 |
| `Ctrl+W` | 删除前一个词 |
| `Alt`/`Ctrl` + `Left` / `Right`、`Alt+B` / `Alt+F` | 按词移动光标 |
| `Alt+Backspace` / `Alt+D` | 删除光标前／后的一个词 |
| `Ctrl+_`（或 `Ctrl+-`） | 撤销最近一次 `Ctrl+K`/`Ctrl+U`、`Ctrl+W` 或 `Alt` 系列删词 |
| `y` / `n` / `Esc` | 回答权限框；Esc 表示拒绝 |
| `a` / `A` | 权限框中的窄规则/整工具永久放行 |
| `Ctrl+B` | 收起/展开工具详情 |
| `Ctrl+C` | 忙碌时取消；2 秒内再按一次退出；空闲时直接退出 |
| `Ctrl+D` | 退出 |

权限框和压缩界面激活时拥有键盘与粘贴输入。补全菜单对方向键的优先级高于历史回看和光标移动。队列取回又优先于提示词回看。

## 报告命令约定

- `/status` 只读已有 accessor，不产生任何修改；未知指标显示为 `not reported`；名称列表用 `… N more` 控制长度。
- `/help` 只写一条有界历史通知，在忙碌队列判断前处理，不调用模型/工具/网络，也不改配置或会话。
- `/mcp` 不探测、不重连；工具名只来自已经注册的状态。
- `/context` 及阈值提醒只是建议。已知比例跨过阈值后，回合结束时只提醒一次 `/compact`；只有确认比例下降后才重新触发；未知估算保持安静。
- `/compact` 不会自动执行。SDK conversation manager 在溢出时仍可能按 `summaryRatio` 和 `preserveRecentMessages` 做摘要。
- `/export` 与离线 replay 使用完全相同的 formatter。

## 网络访问工具（仅主代理）

两者都是普通的受权限管控工具：`default` 模式会询问，`plan` 模式直接拒绝，也可以用放行规则覆盖。子代理和 workflow 节点都拿不到它们。

| 工具 | 返回什么 |
|---|---|
| `http_request` | SDK 自带工具：任意方法、请求头和请求体；原始响应体，不设上限 |
| `web_fetch` | 仅 GET，`Accept` 优先请求 markdown；`http://` 自动升级为 `https://`；同主机重定向会跟随，跨主机重定向只报告不跟随；HTML 转成可读文本（**有损**投影——脚本、样式、导航、布局和属性都会丢弃），markdown/纯文本原样保留，二进制响应体拒绝并说明类型和长度；正文上限 40 000 个码点（`maxChars` 只能调低），截断时明确标注 `[truncated: N of M code points]`；下载最多读取 4 MiB |
