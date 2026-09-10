# 使用 darwin

[English](using-darwin.md) · **简体中文** · [指南首页](README.zh-CN.md)

可选云记忆使用 `/cloud-memory`，无模型管理使用 `darwin cloud-memory`；与本地 `/memory` 独立。配置资源、确认偏好或授权上传前，请阅读 [AgentCore Memory 指南](agentcore-memory.zh-CN.md)。


## TUI 工作方式

启动界面会显示模型、会话、缓存、思考强度、权限模式、已加载的项目指令和扩展，并提示本地帮助。助手回复的 Markdown 样式只影响显示：去掉 ANSI 后，文字仍逐字保留，replay/export 继续输出纯文本。文件修改 diff 来自模型提交的工具参数，不会重新读取磁盘；已经写入历史的 diff 保持完整，实时权限框和工具面板才会受尺寸限制。

`/init` 用来写标题区报告为已加载（或缺失）的项目指令。它是一条 prompt，不是生成器：一个普通回合请模型检查仓库——构建、测试和类型检查命令、目录布局、代码约定，以及已有的 `CLAUDE.md`、`.cursorrules`、`.cursor/rules/` 或 `.github/copilot-instructions.md`——然后在项目根目录创建 `AGENTS.md`，或就地改进已加载的 `AGENTS.md`，并保持在 32 KiB 上限之下留足余量。已加载的 `CLAUDE.md` 会被迁入新的 `AGENTS.md`，自身保持不动。文件通过普通文件编辑器写入，因此这次写入与其他编辑一样在当前权限模式下审批；`/init <focus>` 会把 focus 原样追加到 prompt 末尾。和其他会产生回合的输入一样，回合进行中它会进入队列。

`/copy` 把最近一条*已完成*回答的转录文本放到剪贴板，内容与 `/export` 写出的纯文本完全一致。它先通过终端发出一条 OSC 52 序列（因此 SSH 下也可用），仅在存在显示环境时才运行 `wl-copy`/`xclip`/`pbcopy`；超出上限的回答会报告 `copied N of M bytes`，不会被悄悄截断。回合进行中复制的是上一条回答；尚无回答时会明确提示，而不是报错。

回合执行期间，原有 `working…`/`thinking…` 行会显示耗时和供应商已报告的 token 消耗。未报告的指标直接省略，不会冒充零。`Ctrl+B` 可展开或收起工具详情，不影响正在编辑的输入。

## 输入编辑与补全

`Ctrl+K`/`Ctrl+U` 剪切到可见行尾／行首；`Ctrl+W`、`Alt+Backspace` 和 `Alt+D`/`Alt+Delete` 剪切光标前／后的词。`Ctrl+Y` 把最近剪下的原文插入当前光标处，不会拆开字素；移动光标或继续输入后，仍可重复插入。这只是当前草稿的一个暂存槽，不读写系统剪贴板，也不调用模型。每次非空剪切替换槽内文本；未删掉内容的剪切和普通 Backspace/Delete 都不改变它。`Ctrl+_`（或 `Ctrl+-`）仍恢复破坏性编辑前的整个草稿快照，而不是只恢复剪下的文本；`Ctrl+Y` 不增加撤销步骤。

暂存槽最多容纳 65,536 个 Unicode 码点。超限剪切仍会删除文本且可以撤销，但会清空暂存槽并提示，不会插入旧内容或截断内容。提交（包括排队和本地命令）、取回队列／取消后返还队列、接受历史回看／搜索结果、暂存／取回草稿、`/clear` 和 `/rewind` 都会随撤销记录一起清空它；取消搜索则保留。权限框和上下文压缩优先接管按键，`Ctrl+Y` 不会批准权限，也不会在这些状态下修改草稿。

- `/` 会列出内置命令、skills 和自定义命令。菜单有行数上限，并始终围绕当前选中项显示，同时写明上下省略了多少项。
- `@` 异步扫描工作区，只插入路径文本。它不会打开文件或把内容塞进上下文；`.git`、`node_modules`、逃逸到仓库外的符号链接和超大扫描都会排除或截断。
- 菜单打开时，`Up`/`Down` 只操作菜单。没有菜单时，`Up` 依次尝试取回最早的排队消息、回看本项目轨迹中的已发送提示词，或在多行输入中移动。
- 回看功能只读取已发送的 `userInput`，按新到旧排列，合并相邻重复项，并排除超过 4,000 个 Unicode code point 的内容。没有轨迹只表示没有历史，不算错误。
- `Escape` 会关闭当前 `/` 或 `@` 补全菜单，但不改动草稿和光标；继续编辑查询后，补全会重新出现。回看历史时，`Escape` 只结束本次回看，当前提示词仍留在编辑器中。
- 在空闲且为空的输入框上，500 ms 内连按两次 `Escape` 会打开与 `/rewind` 相同的选择器（只回退对话，从某个已完成的提示词处分支；文件永不回滚）。有草稿、回合正在进行、有排队消息或有待处理权限时，第二次 `Escape` 只是普通的 `Escape`。
- `/tangent` 为一次旁支提问给对话加书签：下一条提示词开始 tangent，再输入 `/tangent` 就沿同一条 rewind 路径回到它之前的状态（只有一层、没有选择器、不把任何内容放回编辑器；会说明 `N prompt(s) discarded`）。详见[会话与状态](sessions-and-state.zh-CN.md#rewind-与-tangent)。
- `Ctrl+J` 或行尾 `\` + `Enter` 插入换行；粘贴多行文字不会意外发送。

## 草稿暂存

`Ctrl+S` 可暂存一份未提交草稿，原样保留文字、光标位置（包括软换行边界归属）和可选附图。输入框为空时再按一次，会取回草稿并清空暂存位。如果两边都有文字或图片，则提示拒绝，不覆盖、不交换；两边都为空时不做任何事。超过 65,536 个 Unicode 码点的草稿会原样留在输入框中，不截断。暂存期间，原有提示行显示 `stash: Ctrl+S`。

期间可以提交其他问题、取回队列、回看历史、切换 `/model` 或执行 `/compact`，暂存草稿不受影响。成功执行 `/clear`、`/rewind` 或通过 `/tangent` 返回新分支会丢弃暂存草稿并提示；退出也会丢弃。仅开启或取消 tangent 不会丢弃。暂存和取回都会清空撤销记录及最近剪切内容，重置历史回看和补全选择，但保留草稿原有光标。空闲或忙碌时，只要输入框拥有键盘，就能使用；权限框、压缩、历史搜索和 rewind 搜索期间无效。TUI 使用现有 raw 模式接收 Ctrl+S，不会开启终端流控。

暂存草稿不会自动发送或排队，不写入磁盘，也不进入模型上下文、轨迹、提示历史或长期记忆。需要先取回，再正常提交，才会发送和记录。附图仍限一张，范围包括暂存位、输入框、队列和当前调用；暂存了图片后，`Ctrl+O` 不能再附加另一张。存在冲突时拒绝取回，不丢弃任何一方；暂存或取回之前尚未完成的剪贴板读取也不会在稍后把图片附到新草稿上。

## 忙碌时排队

回合执行期间提交普通提示词或 `!` 命令，会把它放入下一回合队列。队列显示在输入框上方；当前回合结束后，每次只通过正常 `submit()` 流程发送一条。内容不会注入正在进行的流，也只在真正发送时写入记录。

光标位于草稿首行时按 `Up`，可把队列中的消息取回编辑器。取消或失败会把正在出队的内容原样退回；权限框未处理时队列保持等待。`/clear` 会丢弃队列。忙碌时输入 `/clear`、`/compact`、`/model`、`/exit` 或 `/quit` 会直接拒绝，不会排队。

队列还有第二种行：**后台任务唤醒**。`bash start` 启动的任务结束时，一行 `queued · [task bg-xxxxxxxx succeeded] <command>` 进入队列（忙碌提示以 ` · 1 task wake` 计数），并像提示词一样出队——作为一个普通回合告知模型任务已结束，附带退出状态和输出尾部，模型无需再轮询 `wait`。它不属于你编辑：`Up` 取回和取消退回只把用户输入放回编辑器，唤醒条目留在队列中；`/clear` 会丢弃它们。若模型已在某个已完成回合中通过 `wait`/`status` 看到任务结束，则不会再发唤醒。在 `~/.darwin/config.json` 中设置 `backgroundTaskWake: false` 可只保留完成通知。

同一种行也承载**委派唤醒**。当模型以 `_background_execution: true` 运行 `subagent` 或 `workflow` 时，回合在收到确认后立即结束，子代理运行期间你可以继续提问（它的行留在工具面板中）。子代理在会话空闲时结束，则一行 `queued · [delegation xxxxxxxx succeeded] subagent general#…: <task>` 作为一个普通回合出队：通知只点名这次委派，Strands SDK 会把子代理的报告作为 `strands_background_task_result` 工具结果附在同一请求里——darwin 从不复制它。若子代理在另一个回合运行期间结束，SDK 直接在那个回合里交付报告，不再发唤醒。只要还有后台委派在跟踪中，`/clear` 与 `/rewind` 会被拒绝，并提示任务 id 和两条出路：`/agents cancel <id>`，或等待完成唤醒。`/exit` 仍会取消子代理。`backgroundTaskWake: false` 也会关闭这一行为：此时委派会阻塞回合直到子代理结束，与无头模式相同。


只有精确匹配 `ModelError: Stream ended without completing a message` 的流中断，才会自动创建一次可见的后续继续回合。失败回合仍完整保留；重试走正常编排，不会塞进 SDK 循环内部。

模型调用被限流时（供应商返回 429，包括 Bedrock 在任何流事件之前抛出的 `Too many requests`），会在同一回合内按 SDK 默认节奏重试：最多 6 次尝试，指数退避，基数 4 秒，上限 240 秒，带抖动。等待由 darwin 自己掌管：期间按 `Esc` / `Ctrl+C` 立即生效，回合以该次尝试的错误结束，不会再发起任何模型调用。若每次尝试都被限流，回合以最后一次供应商错误失败。其他模型错误不会重试。

等待期间，忙碌行会就地说明——`working… · 12s · ↑1.2k ↓318 tokens · throttled, retry 3/6 in 12s`——其中 `3/6` 是即将发起的那次尝试，剩余秒数随该行原有的刷新节拍倒数；不会多出一行，供应商的错误文本也不会出现在那里。处于同样状态的子代理会在其实时工具行和心跳上显示 `waiting on model, retry 3/6`。因预算用尽而结束的回合显示 `turn failed after 6 attempts: <供应商消息>`；在等待中被你用 `Esc` / `Ctrl+C` 打断的回合显示 `cancelled during retry wait (attempt 3/6): <供应商消息>`，而不是笼统的 `turn failed:`。`-p` 文本模式下，同一次等待在 stderr 上是一行 `model throttled, retry 3/6 in 12s — <原因>`，失败时会在原样不变的 `error:` 行之前多一行 `notice:`；`--output-format stream-json` 每次等待发出一条 `model.retrying` 事件，失败记录新增一个 `retry` 对象（见[参考](reference.zh-CN.md#报告命令约定)）。

## 用户 shell 命令

输入以 `!` 开头的内容，会运行一个由用户主动授权的 `bash -c` 进程组；包括 `plan` 在内的所有权限模式都可使用：

```text
!git status --short
!pnpm test
```

这是你亲自输入的命令，因此不经过模型权限门，也不复用 runtime 的持久 shell。输出会实时显示在工具面板，并压缩成一份有上限的报告，写入历史、`shellCommand` 轨迹记录，以及下一次模型提示词之前的上下文。它不是 `userInput`，所以不会出现在提示词回看中。超时、取消和关闭都会对整个进程组执行 TERM，再执行 KILL。replay 使用同一套报告归约逻辑。

## 无头文本模式

`-p`/`--print` 不启动 TUI，也不读取 stdin，只执行一个回合：

```bash
darwin -p "reply with ok" >reply.txt 2>progress.log
darwin -p "continue that work" --continue
darwin -p "continue this exact conversation" --session session-20260814-160833123
```

成功时，stdout 只含完整回复和结尾一个换行。工具进度与拒绝信息以有长度上限的单行写入 stderr。每个已启动的运行都会输出稳定的会话行：

```text
session: session-20260814-160833123
```

严格选择会话时，ID 只能含小写字母、数字、连字符或下划线，并且必须对应已有快照。`--continue` 仅用于无头模式，跟随最近会话指针；指针不存在时新建会话。

在 `permission-mode:` 之后，如果配置的思考强度无法按原样生效，会写出一行 `thinking: <problem>`——例如 `thinking: provider "openai" has no xhigh reasoning effort — using high`，或者模型根本不支持 adaptive thinking——与交互模式头部显示的是同一句话；按原样生效的运行不会写这一行。

退出前，文本模式会写出锚定的 `usage:` token 记录（`input`/`output`/`cacheRead`/`cacheWrite`，未报告为 `-`），有子代理时再写 `usage-children:`/`usage-total:`，然后写一条 `cost:` 记录，按模型的 LiteLLM 基础单价为父级分桶计价（`total=… … model=<id> pricing=<litellmKey|unavailable|none>`，未知一律为 `-`，见 [会话与状态 § 成本](./sessions-and-state.zh-CN.md#成本)），最后在观察到模型调用时写 `model-calls:`。

无头模式无法弹出审批框。静态安全调用和已保存的放行规则仍能执行；其余调用到达默认 bridge 后会立即拒绝。只有确认自动化场景适合时，才使用 `--permission-mode auto`、`--permission-mode yolo` 或 `--yolo`。工具被拒绝不一定导致进程失败，模型可以处理拒绝后正常结束。只有回合、快照、最近会话指针和严格清理全部成功，进程才返回成功。SIGINT 属于取消，状态码非零。

以下有界自动化选项只可与 `-p/--print` 一起使用：

```bash
darwin -p "run the complete task"
darwin -p "force offload on despite config opt-out" --context-offload
darwin -p "bounded task" --max-model-calls 200
darwin -p "continue" --session <id> --compact-before
```

`--max-model-calls` 到达正整数上限后，会拒绝下一次供应商请求。超大结果卸载默认开启；`--context-offload` 是兼容的进程级强制开启覆盖项，可覆盖持久的 `contextOffload: false` 退出配置。`--compact-before` 先摘要恢复的历史；若摘要无法持久化，本次目标回合不会开始。

## 结构化输出

```bash
darwin -p "reply with ok" --output-format json
darwin -p "inspect the project" --output-format stream-json
```

`json` 输出一个带版本的结果文档，失败和取消也包含在内。`stream-json` 每个物理行输出一个 JSON 对象，覆盖 session/run/turn 生命周期、完整助手消息、权限拒绝、工具开始/完成、诊断，以及唯一的终态 `result`。

每条有效记录都包含 `schemaVersion: 1`、从 1 开始且在当前进程递增的 `sequence`、ISO `timestamp`，以及请求或解析后的 `sessionId`。只有启动解析前失败时，`sessionId` 才可能是 `null`。参数解析成功后，结构化模式的 stderr 为空；CLI 参数错误仍写 stderr，并返回 2。

终态 `outcome` 只有 `success`、`failure`、`cancelled`。只有 runtime 严格关闭且最近会话指针落盘后，才会输出成功。`errors` 按顺序保存回合、清理和持久化错误；`warnings` 保存观察器或 SDK 降级。`usage` 的 `input`、`output`、`cacheRead`、`cacheWrite` 互斥计量；字段缺失表示未报告，实测为零才写 `0`。

`run.started` 还带有实际生效的思考计划 `thinking: { enabled, requested, effective?, problem? }`——`effective` 是真正发送的级别（思考关闭时缺失），`problem` 只在它与 `requested` 不同、或配置了级别但思考被禁用时出现——这样自动化框架可以断言运行实际使用的强度，而不是相信自己的配置。同一个 `problem` 也会以 `source: "thinking"` 出现在终态记录的 `warnings` 里。

V1 流式输出的是经过最终脱敏的完整助手文本，不是 token delta。公开格式采用字段白名单，不含思考文本/签名、被 guardrail 替换的内容、原始工具输入/结果、trace、内部 metrics 或实时 invocation 对象。受限字段会标注截断；长回复拆成带序号的多条记录，但成功终态结果仍保持完整。`SIGKILL` 与 stdout 断管（`EPIPE`）无法保证写出终态记录。`--output-format` 只能出现一次且只用于 print 模式；它不会额外启动 daemon、server、SDK API 或 checkpoint。

## 后台 bash 任务

供模型调用的 `bash` 工具有以下模式：

| 模式 | 输入 | 行为 |
|---|---|---|
| `execute` | `command`，可选 `timeout` | 串行使用持久前台 shell |
| `restart` | — | 重建前台 shell |
| `start` | `command` | 启动会话所属进程组，返回 task ID/PID/log |
| `list` | — | 按启动顺序列出当前 runtime 的全部任务 |
| `status` | `taskId` | 命令、状态、耗时、退出信息、日志、字节数 |
| `output` | `taskId` | 从共享游标读取下一段完整 UTF-8，最多 64 KiB，允许补齐末尾字符 |
| `wait` | `taskId`、`waitMs`，可选 `wakeOnOutput` | 默认等待 1–30,000 ms；终态聚合等待最长 1,800,000 ms（三十分钟） |
| `stop` | `taskId` | 对整个进程组执行 TERM→KILL |

状态值为 `running`、`succeeded`、`failed`、`stopped`。`wakeOnOutput: false` 会聚合输出，直到终态、取消、关闭或超时；省略或设为 true 时，有输出即可唤醒。若终态聚合等待超时后任务仍在运行，结果会如实告知模型其运行环境的行为：在 TUI 中且 `backgroundTaskWake` 开启（默认）时，模型可以结束回合，会话空闲后会跟进一个 `<task-notification>` 回合；在 `-p` 无头运行、dev REPL、子代理中或该键关闭时，后台完成不会自动恢复代理，后续工作依赖完成时必须在结束回合前再次等待。所有读取操作共享同一个游标；等待不会自动继续回合。

`/tasks` 是本地命令，流式输出期间也能使用，不会调用模型。每个任务行下方会显示最近最多三行非空输出（去掉 ANSI、末尾截断），直接从日志文件尾部读取，不经过共享游标——因此查看 `/tasks` 不会改变模型下一次 `output`/`wait` 的返回；尚无输出的任务会如实标注。重复成功轮询会保持紧凑；显式输出和失败仍会留在历史中。stdout/stderr 合并日志保存在 `~/.darwin/sessions/<project-key>/<session-id>/background/<task-id>.log`，不会自动清理。

Task ID 和游标只在当前进程有效。恢复会话可以看到旧日志，但无法重新控制旧任务。主代理和子代理共享任务表。runtime 关闭时会回收所有登记的进程组；`SIGKILL` 或机器故障无法保证清理。`start` 受 bash 权限和放行规则约束；生命周期查询、`stop` 和 `restart` 属于安全操作。
