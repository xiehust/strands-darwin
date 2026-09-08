# 命令与按键参考

[English](reference.md) · **简体中文** · [指南首页](README.zh-CN.md)

## CLI

```bash
darwin                                      # 新建 TUI
darwin --resume                             # 恢复本项目最近会话
darwin --resume <id>                        # 指定会话
darwin --session <id>                       # 指定会话，包括 fork
darwin sessions                             # 可恢复快照
darwin doctor                               # 离线只读诊断，发现问题时退出码 1
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

`darwin --help`（或 `-h`）把下面的语法原文打印到 stdout 并以 0 退出；`darwin --version`（或 `-V`）打印取自 `package.json` 的 `darwin <version>`（包名是 `strands-darwin`，打印的是命令名）。两者都在解析其余参数、加载运行时、配置或模型之前就地回答，不写任何文件；只要 argv 里出现其中一个，它就优先于其他所有参数（help 又优先于 version）。有一项检查比它们更早：如果安装的 `@strands-agents/sdk` 缺少 darwin 固定的补丁（安装时跳过了 `postinstall`/`patch-package`，例如 `npm install --ignore-scripts` 或不受支持的 `pnpm add -g`），任何调用都只在 stderr 打印一条五行的拒绝消息，指明修复方式 `npm install -g strands-darwin`，并以 1 退出（`spike/verify-npm-patch-format.ts`、`spike/verify-npm-package.ts`）。下面这段引自 `src/cli-usage.ts` 的 `CLI_USAGE`，由 `spike/verify-cli-args.ts` 锁定：

```text
Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
       darwin -p <message> [--output-format text|json|stream-json]
         [--continue|--resume [<id>]|--session <id>] [permission flags]
         [--max-model-calls <n>] [--context-offload] [--compact-before]
       darwin sessions
       darwin doctor
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
With -p, piped (non-TTY) stdin is read to EOF and appended to <message> as one delimited block (256 KiB cap).
```

只用于 print 模式的选项：`--context-offload`（进程级强制开启；卸载默认已开启）、正整数 `--max-model-calls <n>`、`--compact-before`、`--output-format text|json|stream-json`。权限覆盖选项：`--permission-mode default|auto|plan|yolo`、`--yolo`。为兼容包管理器传参，位于开头的一个独立 `--` 会忽略。未知或非法参数语法返回 2：stderr 先打印 `error: <message>`，再跟一行提示 `Run \`darwin --help\` for usage.`。

### `darwin doctor`

一份离线、只读的诊断报告，由会话启动时使用的同一批加载器拼成：`~/.darwin/config.json`（provider、模型、region 或 base URL、所指定的 API key 环境变量是否已设置——从不打印它的值——effort、prompt cache、context offload、trajectory / memory / diagnostics、权限模式）、系统提示词来源、`AGENTS.md` 大小与 32 KiB 预载上限的对比、生效的 MCP 配置文件（哪个被读取、哪个被忽略）及每个已配置的 server——stdio `command` 只在 `PATH` 上查找，`http`/`sse` server 标为 `not connected (doctor never connects)`——各层技能目录的数量与每个被跳过的条目及原因、hook 文件及其方言（native 或 Codex 适配器）、permission-rules 文件、会话存储目录和版本。会让 TUI 拒绝启动的加载器错误（`ConfigError`）在这里变成一行问题：问题行以 `! ` 开头，末尾汇总计数，并决定退出码——没有问题为 0，至少一个为 1。`doctor` 不启动会话、不调用模型、不 spawn 或连接任何 MCP server、不联网、在任何位置都不创建或移动任何东西（连 `~/.darwin` 也不会创建）；它不接受参数（动词之后的任何内容都以用法错误退出 2）。由 `spike/verify-doctor-command.ts` 锁定。

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
| `/context` | 已知/估算的上下文大小（Bedrock 可能使用启发式），随后按当前请求形态估算的分项：系统提示按段（基础提示、项目指令、技能目录、工作上下文）、工具按来源（darwin 内置、各 MCP 服务器）、对话按角色——窗口已知时每行显示 `~N tokens · P%`；计数失败的一项显示 `not reported`；只在你运行该命令时才计数 |
| `/copy` | 把最近一条*已完成*回答的转录文本复制到剪贴板：先通过 OSC 52 写入终端（SSH 下可用），仅在存在显示环境时再调用 `wl-copy`/`xclip`/`pbcopy`；一条通知说明复制的字节数（超出上限时为 `N of M`）和工具失败；带参数会拒绝 |
| `/effort [level]` | 查看或设置会持久化的模型思考强度；缓存尚热时切换前先提示一次 |
| `/exit`、`/quit` | 退出 |
| `/export <path>` | 精确 replay 投影；不覆盖，也不写会话内部 |
| `/help` | 有界本地命令、语法和按键；带参数会拒绝 |
| `/mcp` | 只读服务器状态/工具/配置路径；不重连 |
| `/memory`、`/memory list` | 含来源、证据、校验/过期原因的条目 |
| `/memory show <id|number>` | 查看一个有界条目 |
| `/memory remember <note>` | 添加经过筛查的用户项目备注 |
| `/memory forget <id/number/all>` | 删除/抑制条目并刷新当前 prompt |
| `/mode [mode]` | 查看/设置仅用户可改的当前权限模式；不持久化 |
| `/model [name]` | 列出/切换已配置模型，会话不断开；缓存尚热时切换前先提示一次 |
| `/permissions` | 当前放行规则及来源，随后是已配置的拒绝规则 |
| `/permissions revoke <n/rule/all>` | 同步收紧 gate 和磁盘上的放行规则；拒绝规则不能在此撤销 |
| `/status` | 只读汇总模型/缓存/强度/模式/MCP/skills/hooks/费用/成本/上下文；出现过缓存未命中后，模型行会注明最近一次未命中的可能原因 |
| `/tasks` | 后台任务及其最近三行非空输出；忙碌时也可用；读取不会移动模型的 `output`/`wait` 游标 |
| `/trajectory` | 当前运行的本地记录状态 |
| `/usage` | 当前进程 token 分桶及近似美元成本；未报告不等于零；出现过缓存未命中后，统计次数并注明最近一次的可能原因 |
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
| `Esc` `Esc` | 输入框为空且空闲时（无草稿、无回合、无 `!` 命令、无队列、无权限框），500 ms 内再按一次 `Esc` 打开 `/rewind` 选择器——与输入 `/rewind` 完全相同；此时单按一次 `Esc` 不做任何事 |
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

- `/status` 只读已有 accessor，不产生任何修改；未知指标显示为 `not reported`；名称列表用 `… N more` 控制长度。其 `hooks` 行按策略顺序列出当前生效的 hook 源文件（项目内显示相对路径，家目录下用 `~`；没有任何 hook 时显示 `none`），启动时有旧式 hook 输入被遮蔽则追加 `· N shadowed`。
- `/status` 与 `/usage` 的 `cost` 行是 Σ token 分桶 × LiteLLM 基础单价，**每个模型按各自单价**（`/model` 切换后该行标出模型数——`≈ … (2 models; …)`——`/usage` 并为每个模型各加一行），始终标注 `≈ … (base rates, LiteLLM)`；某个分桶未报告时显示为下限（`≥ $x.xxxx (cacheWrite not reported; …)`），绝不冒充零，混合中没有价格的模型同样使其成为下限（`≥ … (2 models; no price for <id>; …)`）；`unknown (no price for <model>)` / `unknown (price unavailable)` 说明没有数字的原因。读取它不会触发下载或写入。`trajectory list` 在每行会话后追加同样的 `cost: …` 子句，`trajectory replay` 打印 `session cost:` 及每个模型的金额，全部离线读取同一文件计价——绝不下载、绝不写入；`/export` 不含成本行。单价缓存在 `~/.darwin/model-prices.json`，每个模型 id 只在启动时（以及 `/model` 切到新 id 时）后台从 LiteLLM 公开价目表获取一次；环境变量 `DARWIN_MODEL_PRICES_FETCH=off` 可让 darwin 完全不联网，只使用文件里已有的价格。
- `/help` 只写一条有界历史通知，在忙碌队列判断前处理，不调用模型/工具/网络，也不改配置或会话。
- `/mcp` 不探测、不重连；工具名只来自已经注册的状态。
- `/context` 及阈值提醒只是建议。已知比例跨过阈值后，回合结束时只提醒一次 `/compact`；只有确认比例下降后才重新触发；未知估算保持安静。
- Prompt 缓存未命中的提示同样只是建议，且仅限 Claude（OpenAI 由服务端自动缓存，darwin 没有放置 cache point，因此不做推断）。一次完成的模型调用若在前一次调用有缓存读取的情况下，从缓存读到的 token 少于本次请求总量的 20%，即视为未命中；darwin 只用已掌握的事实给出一个可能原因，按以下优先级取其一：`model switched`、`effort changed`（仅当实际发送的强度确实变了）、`compacted`（仅当 `/compact` 确实缩短了历史）、`idle past cache TTL (5m|1h)`、`first request of a resumed session`，否则 `unknown`。本会话出现过未命中后，`/usage` 顶部区块增加 `cache misses  N`，上一回合区块增加 `last miss  <cause>`，`/status` 的模型行追加 ` · last miss: <cause>`；从未出现时两份报告与以往逐字节一致。`/rewind`、文件编辑、权限模式切换和加载 skill 不会使缓存失效，也永远不会被归咎。计数器未报告、新会话预期冷启动的首次调用、缓存关闭时均保持安静。在缓存尚热（上次调用有缓存读取且距今不足 TTL）时执行 `/model <target>` 或改变实际发送强度的 `/effort <level>`，会先打印一条通知说明代价然后照常切换：`cache is warm (<age> ago, <N> tokens read last call): switching model|effort re-reads the conversation uncached`。没有确认对话框，不自动压缩，不新增实时行；不记录也不持久化。
- `/compact` 不会自动执行。SDK conversation manager 在溢出时仍可能按 `summaryRatio` 和 `preserveRecentMessages` 做摘要。
- 忙碌行（`working…` 提示行与 `thinking…` 行）以一个追加短语显示模型重试等待：` · throttled, retry 3/6 in 12s`——`3/6` 是即将发起的那次尝试，剩余秒数向上取整、最低 `0s`，供应商的原因文本绝不上行，也不会新增任何一行；没有等待时这些行逐字节不变。子代理自己的等待表现为实时行/心跳上的阶段 `waiting on model, retry 3/6`。因重试次数用尽而失败的回合显示 `turn failed after N attempts: <消息>`；在等待中被取消的回合显示 `cancelled during retry wait (attempt N/M): <消息>`。无头模式对应：文本模式在 stderr 写 `model throttled, retry 3/6 in 12s — <原因>`（每次等待一行），失败时在原样不变的 `error:` 行前多一行 `notice: <标题>`；`stream-json` 每次等待发出一条新增的 `model.retrying` 事件（`attempt`、`maxAttempts`、`waitMs`、`reason` ≤ 240 码点），`subagent.progress` 可能带 `phase: "waiting-on-model"` 及 `attempt`/`maxAttempts`，或在子代理因模型流中断而进行那一次继续时带 `phase: "continuing-after-stream-interruption"`（文本模式显示 `continuing after stream interruption`）；终态记录中 turn 阶段的 `errors[]` 条目新增可选的 `retry` 对象（`{ kind: "exhausted", attempts }` 或 `{ kind: "cancelled", attempt, maxAttempts }`），`name`/`message`/`cause` 仍是供应商原文。轨迹记录、`/export` 与 replay 均不变。
- `/export` 与离线 replay 使用完全相同的 formatter。
- `/copy` 复制的正是转录中显示、`/export` 写出的纯文本回答；回合进行中复制的是上一条已完成回答，尚无回答时（或刚 `/clear`/`/rewind` 之后）提示 `nothing to copy`。它不调用模型，也不写入任何记录。SSH 下需要终端接受 OSC 52 剪贴板写入（tmux 需 `set-clipboard on`）。
- 终端窗口/标签页标题（`terminalTitle`，默认 `true`）为 `darwin · <项目目录名> · <状态>`，状态为 `idle`/`working`/`waiting for approval`，有提示词排队时再加 ` · N queued`（权限提示优先于进行中的回合，回合优先于空闲；排队数跟在当前状态之后）——一条 OSC 2 序列（`ESC ] 2 ; <标题> BEL`）直接写到 stdout，仅在 stdout 是 TTY 且组合后的标题发生变化时写入（只在状态转换时，绝不按时钟刷新），整体上限 80 个码点，项目目录名中的控制字符会被剥除；每条退出路径（`/exit`、`/quit`、Ctrl+C、Ctrl+D）恢复一次为项目目录名，`/clear` 保持同一项目、直接延续；`-p` 从不写标题。

## 敏感路径读取

读取目标解析后落入固定敏感集合时永不静默：`~/.ssh/`、`~/.aws/`、`~/.gnupg/` 之下的任何内容；`~/.netrc`、`~/.kube/config`、`~/.docker/config.json`、`/etc/shadow`；任何名为 `.env` / `.env.*` 的文件；darwin 自身的配置、hook 和权限规则文件。判定目标是 `fileEditor view` 的 `path`，以及 `cat`、`head`、`tail`、`grep`、`rg`、`find`、`ls`、`wc` 的每个非选项参数（`~`、`$HOME`、`${HOME}`、相对路径和 `..` 形式都会解析）。权限框显示 `reads a sensitive path: <path>`；在 `default`、`auto`（绝不会为它咨询分类器）以及——对 `fileEditor view` 而言——`plan` 中都会询问，无头模式下拒绝，且没有任何放行规则能覆盖它，也不会提供规则选项。仅对 `grep` 和 `rg`，从凭据位置的上级目录（`~`、`/home/<user>`、`/`、`/etc`、`~/.kube`、`~/.docker`）开始的搜索同样计入，显示为 `reads a sensitive path: <arg> (searches above <location>)`；`.env*` 不在这条上级目录规则之内。其余读取仍然静态安全。由 `spike/verify-permission-modes.ts` 锁定。

## 文件编辑

`fileEditor str_replace` 要求 `old_str` 在文件中只出现一次；出现多次时会拒绝并列出行号。传入
`replace_all: true` 可在一次写入中替换所有不重叠的匹配——结果会给出替换数量和（编辑前的）行号，并只显示第一处替换附近的一段代码。权限框和完成行仍只显示一对
`old_str`→`new_str`，另加一行 `Replace all: every occurrence` / `replace_all: every occurrence`
说明作用范围（来自输入，绝不读取文件）。其他命令会忽略该字段。

## 网络访问工具（仅主代理）

两者都是普通的受权限管控工具：`default` 模式会询问，`plan` 模式直接拒绝，也可以用放行规则覆盖或用拒绝规则禁止。子代理和 workflow 节点都拿不到它们。

| 工具 | 返回什么 |
|---|---|
| `http_request` | SDK 自带工具：任意方法、请求头和请求体；原始响应体，不设上限 |
| `web_fetch` | 仅 GET，`Accept` 优先请求 markdown；`http://` 自动升级为 `https://`；同主机重定向会跟随，跨主机重定向只报告不跟随；HTML 转成可读文本（**有损**投影——脚本、样式、导航、布局和属性都会丢弃），markdown/纯文本原样保留，二进制响应体拒绝并说明类型和长度；正文上限 40 000 个码点（`maxChars` 只能调低），截断时明确标注 `[truncated: N of M code points]`；下载最多读取 4 MiB |

## 后台委派（仅主代理）

Strands SDK 的 `backgroundTasks` 插件只为 `subagent` 与 `workflow` 附加可选的 `_background_execution`
标志；其他工具一律前台执行。带标志的调用与前台调用经过完全相同的权限检查，立即返回带任务 id 的确认。
报告在哪里交付取决于运行时：在交互式 TUI 中（`backgroundTaskWake` 开启时），发起委派的回合在确认后即结束，
子代理继续运行，你可以继续提问；报告在下一个实际运行的回合中到达——SDK 会在该回合的模型调用之前把它作为
`strands_background_task_result` 工具调用/结果对附上，而当会话空闲时，由一条**委派唤醒**（见下文）启动
那个回合；在无头模式或 `backgroundTaskWake: false` 下，SDK 在同一次调用内等待，报告在父代理同一回合的下一次
模型调用之前交付。子代理看不到该标志，也没有下面这个工具。只要还有后台委派在跟踪中，`/clear` 与 `/rewind`
会被拒绝，并以一条通知点名任务和两条出路（`/agents cancel <id>`，或等待完成唤醒）；`/exit` 仍会取消子代理。

| 工具 | 权限 |
|---|---|
| `strands_manage_background_task` | `mode: list` / `get` 为读取；`mode: cancel` 是默认关闭的 `execute`（`default` 模式下询问，`plan` 模式下拒绝）；`/agents cancel <id>` 仍是仅用户可用的取消路径 |

## 后台任务唤醒（仅交互式 TUI、仅主代理）

`bash start` 启动的后台任务进入终态（`succeeded`、`failed`、`stopped`）时，转录区照旧显示完成通知；
在 `backgroundTaskWake` 开启（默认）的情况下，还会有一条唤醒条目进入提示词队列。它和排队的提示词一样
在空闲时出队，经由普通 `submit()` 成为一个普通回合（hooks、权限门、轨迹屏障和 `TurnComplete` 都照常触发），
交给模型的是一段有界文本：

```
<task-notification task="bg-…" state="succeeded" exitCode="0" signal="" elapsed="12s">
A background bash job you started with `bash start` finished successfully. …
command: …
output tail (last N line(s); `bash output` with taskId "bg-…" reads the full log from your cursor):
…
</task-notification>
```

已结束的后台委派使用同一种条目，标记为 `[delegation <id8> state]`，用委派标签（`subagent general#…: <task>`）
代替任务命令，文本只点名工具、任务 id、状态和耗时，并指向 SDK 附在同一请求里的 `strands_background_task_result`
结果对——报告本身绝不重复：

```
<task-notification task="<uuid>" tool="subagent" state="succeeded" elapsed="1m 2s">
A background subagent delegation you dispatched with _background_execution: true finished. …
delegation: subagent general#…: <task>
Its report is in this turn's strands_background_task_result tool result for task "<uuid>" — read it there; it is not repeated here.
…
</task-notification>
```

- 每个任务恰好一次唤醒，只来自终态快照——绝不因输出活动触发，也不会在回合结束时重复触发。
  若模型已在某个*已完成*回合中通过 `bash wait`/`status`/`stop`/`list` 的结果拿到该任务的终态，则不再唤醒。
- 忙碌时它像提示词一样留在队列中（只在下一回合发送，绝不注入正在进行的流）；权限框打开期间入队的唤醒，
  会在权限决定之后、当前回合结束时发送。
- 队列行显示为 `queued · [task bg-xxxxxxxx succeeded] <command>`，忙碌提示以 ` · N task wake(s)` 单独计数，
  与 ` · N queued` 分开。`Up` 取回和取消退回只把用户输入放回编辑器，唤醒条目留在队列中。自身回合被取消或
  失败的唤醒不会重发（一条 `not delivered` 通知说明任务）。`/clear` 会丢弃待发的唤醒。
- 记录类型 `taskNotification`（字段 `taskId`、`command`、`state`、`exitCode`、`signal`、`text`；委派唤醒
  另带 `source: "delegation"`，以委派标签作为 `command`，退出元数据为 `null`）在
  `trajectory.jsonl` 中代替 `userInput` 行开启该回合，因此提示词回看和 `Ctrl+R` 永不提供它；`trajectory search`
  仍能搜到，`trajectory replay` / `/export` 以与实时会话相同的 `task wake · …` / `delegation wake · …` 通知行打印。
- 无头驱动没有队列，永不唤醒；子代理永不入队。无头运行会把后台委派保留在它唯一的回合内（SDK 在运行结束前等待子代理）。
