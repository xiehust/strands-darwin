# 会话与状态

[English](sessions-and-state.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 快照存储与恢复

每轮结束后，会话会快照到 `~/.darwin/sessions/<project-key>/`；`last-session.json` 指向裸 `--resume` 应恢复的最近会话。状态按规范化后的仓库路径隔离，其他工作树的会话不会混入候选列表。

```bash
darwin sessions
darwin --resume <id>
darwin --session <id>
```

`darwin sessions` 完全只读、离线运行，只列出可恢复的快照，并按最近活动排序。每行包含 ID、距今时间、第一条已记录的用户提示词、可选的显示标签、`(last)` 标记，以及当另一个仍在运行的 darwin 正持有该会话时的 `(open in pid N)`（持有者在另一台机器上时为 `(open on <host> in pid N)`）。轨迹关闭时显示 `(not recorded)`；损坏或不可用的条目会跳过并给出数量。列出会话不会写文件，也不会移动最近会话指针——过期的租约也不会被列表接管。无效或属于其他项目的 ID 会被拒绝，不会回退。指定恢复的会话只有在完成新回合后，才会成为裸 `--resume` 的目标。TUI 退出时会在终端回滚区留下一行纯文本，指向退出时仍在使用的会话——`session <id> · resume: darwin --resume <id>`——但仅当该会话有内容可恢复时才打印（从未发送过提示词的会话以及所有 `-p` 运行都不打印）；这一行在租约释放之后写出，不触碰任何文件。

### 不离开 TUI 查看已保存会话

`/sessions` 不接受参数，在空闲或回合忙碌时都只打印一条本地只读的历史通知。
它与 CLI 共用保存会话的读取逻辑，列出不变的 ID、快照活动距今时间、第一条已记录
提示词、可选标签、`(last)` 和有效租约标记。不发送或排队提示词，不切换运行时、
连接 MCP、改配置或写快照、轨迹、指针、租约、标签。范围仅限当前项目，与
`/list-agents` 的跨项目存活进程列表不同。

TUI 在快照及状态目录中合计最多枚举 200 个目录条目，另读一个条目判断是否超限；
重复及非会话条目也计入扫描上限。最多显示 20 行可恢复会话。缺少快照的会话计入
跳过数量；提示词记录缺失或损坏时显示 `(not recorded)`，标签缺失或格式错误时
视为未命名。扫描省略与显示省略分别说明。扫描超限时只按**已检查条目中的活动时间**
排序，不声称全局最新；`darwin sessions` 仍保留完整列表。每个单元格清除终端控制
字符，最多 100 个码点，截断用 `…` 标明，包括旧 ID 和租约主机名。另行启动
`darwin --resume <id>` 按不变的 ID 恢复；没有选择器、按标签恢复、删除或进程内切换。

### 会话显示标签

在 TUI 中输入 `/rename <label>`，可以为当前父会话设置仅用于显示的标签；忙碌时也能立即处理。标签去掉首尾空白后，必须是非空单行原文，最多 80 个 Unicode 码点；控制字符、行分隔符或超长输入会被拒绝，不写文件。裸 `/rename` 只显示用法，不生成标题。`/status`、`/sessions` 和 `darwin sessions` 会在原有 ID 旁显示带引号的标签；列表仍保留活动排序、距今时间、第一条提示词和租约标记。标签可以重名。恢复仍然**只接受 ID**，没有名称参数、按标签查找或当前进程内切换会话的功能。

标签存放在与 `lease.json` 和轨迹并列的 `label.json` 中，属于有界（1 KiB）的用户所有状态，不进入 SDK 对话、快照或轨迹记录。保存完全本地且原子完成；重定向、特殊文件或不安全的用户状态路径会被拒绝。标签缺失或损坏时只读为未命名，不修复。同 ID 恢复保留标签；`/clear` 和 `/rewind` 的后继会话不继承标签，旧会话标签原样保留。重命名不发送或排队模型提示词，不改指针、策略或租约，也不增加实时界面行。

### 每个会话同时只能在一个进程中打开

一个会话同一时间只能由一个 darwin 进程打开：两个进程同时使用同一个会话，会各自覆盖快照、各自追加轨迹，最后写入者获胜。选定会话时——新建、`--resume`、`--session`、`/clear` 或 `/rewind` 的后继——darwin 以独占创建方式写入 `~/.darwin/sessions/<project-key>/<session-id>/lease.json`（`{ pid, hostname, startedAt }`），与轨迹文件并列，绝不写入项目目录。租约的 hostname 与本机一致且 pid 仍存在时（属于其他用户的 pid 也算存活）为*有效*；来自其他主机的租约无法检查 pid，自 `startedAt` 起 24 小时内视为有效。其余情况均为*过期*。

- `darwin --resume <id>` / `darwin --session <id>` 遇到有效租约时会被一行拒绝——`Session "<id>" is open in pid N since <time>; close it or start a new session.`——退出码 1，绝不回退到别的会话。无头模式的 `-p --resume <id>` / `--session <id>` 以同样方式在 stderr 上拒绝。
- 裸 `darwin --resume`（以及 `-p --continue`）遇到有效租约时会启动一个**新**会话，并用一条启动通知说明原因（`session <id> is open in pid N since <time>; started a fresh session instead`；无头模式为一行 `lease:` stderr）。这次拒绝不会移动指针；新会话与任何会话一样，只有在完成一个回合后才会接管指针。
- 过期租约（pid 已死，或其他主机的租约超过 24 小时界限）会被接管——文件被重写——并用一条通知说明它原本属于谁（`took over a stale lease left by pid N (started <time>)`）。崩溃、被 kill、或 500 ms 强制退出留下的正是这种租约；过期租约永远不会挡住任何人，也不存在解锁文件或开关。
- 会话结束时释放租约：退出时，以及 `/clear`、`/rewind` 时为退役的前任释放（后继在自己的新 ID 上持有自己的租约）。释放只在文件仍指向本进程时才删除它。

TUI 恢复时，会在输入框出现前从该会话的原始轨迹中显示一份有长度上限的只读摘要，只包含最近一个完整的用户请求和助手答复。轨迹缺失、关闭、损坏或内容被省略都会明说；接管过期租约也会在同一标题处说明。此过程不创建模型消息、不调用模型、不改文件，也不移动指针。新会话和无头模式不受影响。

`/clear` 通过同一个工厂创建后继 runtime，继承当前权限模式，退役旧 runtime，并重建会话级状态。新会话完成回合之前，不会改动磁盘上的指针。runtime 的 `AGENT_ID` 参与快照路径计算，修改它会让旧快照失去入口。

### 本机会话协作

在两个终端运行 Darwin。先输入 `/collaborate list`，从可通信端点的地址中复制**完整 endpoint UUID**：

```text
/collaborate send <endpoint-uuid> 请检查解析器，并回复发现的问题。
```

规范项目根路径相同（解析后的真实路径，不是显示名称、PID 或会话 ID）的会话自动双向协作，
无需另行允许接收。主模型可以调用 `peer_discover {}`、`peer_send {target, text}` 回复。
仅查看列表不会启动工作。发现时先排除无效注册、缺失或不安全的 socket 路径，再使用实时挑战预算，
因此这类崩溃残留不会挡住有界扫描内后面的存活会话。列表会报告省略项和未挑战候选，不删除残留文件。
请自行协调文件修改；这不是文件锁或任务调度器。

跨项目首次发送**不会入队**。拒绝信息和 `/collaborate pending` 会显示两个完整项目路径、
十分钟内有效的请求 ID，以及持久化说明。核对后，由用户亲自执行：

```text
/collaborate confirm <pending-id> --persist
/collaborate relations
/collaborate revoke <pair-id>
/collaborate off
/collaborate on
```

一次确认把对称项目关系保存在 `~/.darwin/collaboration/policy.json`；双方换 PID、换会话、
重启后仍有效，反向通信也不再确认。确认后需明确重新发送。撤销会清除该项目对的待确认请求，
阻止已排队及后续消息；off 对当前 HOME 持久生效，并使全部旧队列失效。
on 在当前 TUI 发布新端点。Esc 取消后，用 `/collaborate on` 重新启用；旧地址不能指向新会话。
用户或 peer 回合最终失败时，会在回到空闲前丢弃已排队的 peer 并提示，这些消息不会重放，也不会自动再跑；
监听端点保持原地址，之后的发现和发送不用 `/collaborate on`。
Esc 取消、off、clear/rewind 和退出仍会退役端点；持久项目授权不变。
精确匹配的流中断仍先完成原有的一次续接，收件箱保留到续接结束。

独立 CLI `darwin collaborate` 使用相同子命令（去掉斜杠），可在另一个 TUI 等待工具审批时确认。
不要用 `-p "/collaborate confirm …"`，那是发给模型的文本，不是用户控制通道。
Headless/yolo 不会批准未知项目关系。CLI send 只发送一次，不等待回复；持续对话请使用两个 TUI。
无头会话只在正常运行期间接收，主回合结束后关闭入口，最多处理已接收的八条消息，然后退出，
不会变成常驻守护进程。stream-json 标明 peer 回合；最终 JSON 保留用户结果，另附有界 `peerTurns`
结果及来源；纯文本也单独标明 peer 回复。peer 失败后停止处理并丢弃剩余收件箱；已开始的 `peerTurns` 项
明确记录失败和有界错误，stream-json 另有带来源的 `turn.failed`。所有格式都保留已完成的用户回复，
但整个运行仍以退出码 1 失败。只入队而未开始的消息不会被算作已处理结果。

接收端只得到字面文本和来源项目、会话、端点，不得到发送者文件或历史。`/`、`!`、`@`、
仿造角色或标签的内容都不展开为命令。消息只在空闲、用户与任务队列清空、权限审批结束后进入普通回合。
接收端权限检查不变；发送者处于 plan 时，只读限制会沿回复链传递，不能请另一个宽权限会话代写。
默认情况下，本地操作被拒绝后会暂停发送，必须由用户明确恢复；`trustPeers` 只解除这条发送暂停规则。
Peer 文本不能批准权限、修改策略/config/AGENTS，不能作为用户记忆引文或云端授权。
Peer 回合中的记忆保存即使在 yolo 也会拒绝。Shell 操作始终走普通的模式/规则/分类器/确认流程，
不会仅因来自 peer 而直接拒绝；非 plan 下，普通获准的文件修改仍可进行。

`Queued` 仅表示接收入队，**不表示已处理**。文本最多 4096 个 UTF-8 字节，完整编码帧还必须小于等于
16 KiB；消息须在发出后 60 秒内送达，入队后（每端点队列八条、每分钟接收十六条）一直保留到
五分钟的回复链过期。如果过期前没有回合取走它，接收端丢弃消息并通知原发送方，发送方 darwin
会自动重发同一段原文（最多三次，每次显示 `resent k/3`）；三次重发都过期后，发送方模型会收到
一个通知回合，说明消息始终未被处理（该回合不能再 `peer_send`）。
模型用 `peer_send` 发送通知格式的文本会被拒绝。
自动回复链有效五分钟、最多四跳、每端点每链最多接收两次、每 peer 回合最多发送一次。
用户新回合可发送四次并开始新链。触及上限需用户恢复，模型不能伪造新链或自动重试。
clear、rewind、取消、关闭都会丢弃待处理消息并退役旧端点。没有持久收件箱、处理回执，
也不保证崩溃后的 exactly-once；丢失确认时应先检查接收端，不能盲目重发。

目前仅支持 POSIX Unix socket，socket 路径最多 103 字节。HOME 与 `.darwin` 须由当前用户拥有，
不能是软链接，也不能允许组或其他用户写入；协作目录须为 0700，文件/socket 为 0600。
不安全或损坏状态会关闭协作并提示，不影响 Darwin 其他功能。崩溃后遗留的 `policy.lock`
须由用户检查后处理，Darwin 不抢占锁；不要通过放宽权限或复制凭证解决问题。
只有租约的旧版会话不能接收。通信仅面向**同一 OS 用户**，**不是防御恶意同 UID 任意代码的隔离边界**；
正常模型调用仍会把消息交给所配置的供应商。本地通道没有远程监听，也不向云端传输；跨机协作是下文单独、需要主动开启的 hub。
详见[协议与存储参考](reference.zh-CN.md#本地协作)和[架构说明](../architecture/local-collaboration.md)。

### 跨机协作（协作 hub）

先把 hub 部署到你自己的 AWS 账号（见 [hub/README.md](../../hub/README.md)），再用该账号生成的一次性令牌注册每台机器：

```bash
cd hub && pnpm mint-token --note laptop          # 在持有部署凭据的机器上
darwin collaborate hub enroll <HubUrl> <token> --name laptop   # 在要注册的机器上
```

`enroll` 仅限 CLI，令牌不会进入任何会话。注册之后，只要项目有网络 git `origin`，这台机器上的会话就会自动上线 hub；
规范化后的远端（`github.com/owner/repo`，去掉凭据）就是其他机器看到的项目身份。`peer_discover` 在 `hub`
字段下列出 hub 上的 endpoint，`peer_send` 向它们发送消息，文本、上限和"已入队、未处理"的回执语义与本地 peer 完全相同。

**已注册且处于 active 状态的节点之间直接协作，不需要确认。** 取而代之的保护是：每个节点的公钥在首次见到时钉住，
公钥变化一律拒收；有新节点注册时，所有在线会话都会看到通知；`darwin collaborate hub block <node>` 在本机屏蔽某个节点，
不管 hub 怎么说都拒收，并清掉它已排队的消息；`pnpm revoke-node` 在所有地方切断一个节点；peer 消息始终只是 peer 输入，
Shell 操作与本地 peer 一样走接收端的普通权限检查，deny 规则和 plan 发送者的只读限制仍生效。
任何能注册 hub 节点的人都能请求 shell 操作：非安全调用在 `default` 下询问用户，`yolo` 下执行。
来自 peer 的策略/配置/AGENTS 修改和记忆写入即使在 yolo 模式下仍会被拒绝。
消息文本会经过你的 AWS 账号（不存储、不记录日志，但没有端到端加密）。

```text
darwin collaborate hub status     # 注册状态、指纹、本会话的 hub 状态
darwin collaborate hub nodes      # 已钉住的节点及指纹
darwin collaborate hub publish off|on   # 让本项目退出（或重新加入）hub
darwin collaborate hub block <node> | unblock <node>
darwin collaborate hub leave      # 删除本机身份（运维侧吊销需另行执行）
```

除 `enroll` 外，同样的子命令在 TUI 里以 `/collaborate hub …` 形式可用。节点连续三次被拒后会暂停重连并给出原因
（已吊销或时钟偏差）；执行 `/collaborate on` 恢复。

### 查看本机会话进程

同时在几个终端运行 Darwin 时，可以在 TUI 输入 `/list-agents`，或直接运行：

```bash
darwin list-agents
```

它跨项目读取当前 HOME 下已有的 `~/.darwin/sessions/<project-key>/<session-id>/lease.json`，尚未保存快照的会话也能列出。每行显示 PID、会话 ID、项目 **key**、`startedAt`（取得租约的时间），以及 PID 与执行列表命令的进程相同时的 `(current process)` 标记。项目 key 不能还原工作目录。独立 CLI 自身不取得租约，因此通常没有当前进程标记。两种命令都不接受参数；CLI 无需供应商配置，不调用模型、不联网，报告结果（包括空列表或不可读状态）返回 0，用法错误返回 2。TUI 空闲或忙碌时都能使用，只在历史区显示一条通知，不启动模型回合，也不把命令加入提示词队列。

范围是**当前 HOME 中、当前用户拥有的本机有效会话租约**，不是所有 OS 进程。旧版或未登记租约的进程、其他用户/HOME/主机、普通 OS 子进程，以及进程内的 SDK 子代理均不在跟踪范围内。存活判断复用租约的信号 0 探测（`EPERM` 也算存活），**不构成进程身份认证**；扫描期间进程可能退出、租约可能变化。`/agents` 仍列出本 runtime 的子代理派发；`darwin sessions` 仍只列出当前项目可恢复的快照。

扫描**优先检查当前规范化项目**：TUI 使用 runtime 的项目根目录，独立 CLI 使用工作目录。TUI 还会优先检查该项目中的当前会话 ID，因此大量历史项目或会话不会把当前有效租约挤出报告；独立 CLI 没有可优先处理的当前会话 ID。其余项目和会话按文件系统枚举顺序检查。

总上限仍为 128 个项目条目、合计 2,048 个会话条目、32 行有效租约。优先身份即使缺失或不安全也占一个名额，枚举再次遇到时跳过，不重复读取租约或计数。达到扫描上限时额外查看一个条目以判断是否还有遗漏。每份租约最多读 4,096 字节，再加一个溢出检测字节。显示仍按项目 key、会话 ID 排序，这个显示顺序不决定检查顺序。跳过的条目和未显示的有效租约给出数量；未扫描的剩余条目标明数量未知。存储缺失或不可读会明确说明，不冒充完整空列表。死亡、其他主机、格式错误、过大、PID 无效、符号链接及不安全条目均被排除；OS 提供用户 ID 时还会检查文件和目录的归属。显示字段转为可打印 ASCII，每个字段最多 255 字符。

列表不读取提示词、轨迹、快照或配置，不改动任何状态，过期租约也不清理。它不轮询、不启动或取消进程、不开 socket，**不提供通信能力**。脚本和无头检查请使用独立 CLI，不要用 `-p "/list-agents"`；本功能没有新增无头斜杠命令派发。

### Rewind 与 tangent

`/rewind`（或在空闲且为空的输入框上连按两次 `Esc`）列出本会话已完成提示词的检查点——每条模型跑完了回合的纯文本提示词（无论是回答了它，还是以拒绝类停止原因拒绝了它）在运行前都会留下一个不可变的 SDK 快照，每个会话最多 100 个——接受其中一个，就把对话分支到一个恢复到该边界的新后继会话；所选提示词回到编辑器但不发送，来源会话仍留在磁盘上、可恢复且逐字节不变。失败或被取消的回合不留检查点。被拒绝的提示词是有意列出的：被拒绝的回复会留在对话里，可能让接下来的提示词以同样方式失败，所以拒绝提示会指向这里——回退到那条提示词，就能在改写之前把被拒绝的那次交换移除。只有对话会移动：工作区文件、shell 与 `!` 的效果、hooks、MCP 写入、子代理、后台任务和已学习记忆都不会回滚，提示里会明说。

`/tangent` 是同一条路径上的书签，专为"先问点旁边的事，再回来"这一常见场景。裸 `/tangent` 先武装；你接下来发送的那条提示词开始它，该提示词的检查点就是返回点（标题栏显示 `tangent since prompt N`，N 是该提示词在本会话已编目提示词中的序号，`/status` 多出一行 `tangent`）。再输入 `/tangent`（或 `/tangent end`）即返回：同样的后继会话、同样的省略说明，外加 `returned from tangent — N prompt(s) discarded`，其中 N 统计自武装以来已编目的提示词，含返回点那一条——在 tangent 内发送了 A、B、C 三条后显示 `3 prompts discarded`。不会把任何内容放回编辑器：你要的是返回，不是重发。只有一层，不命名，没有选择器（选择器就是 `/rewind`；进行中再 `/tangent start` 会被拒绝）。如果武装后的第一条提示词无法编目——附带了图片、是后台任务唤醒、回合失败或被取消、检查点容量已满——tangent 会立即结束并说明原因。在那之前输入 `/tangent end` 只是解除武装。tangent 与权限模式一样是 TUI 当前会话状态：不持久化、不记录，`/clear` 或接受一次 `/rewind` 会以 `tangent ended by …` 结束它，恢复的会话里不存在，无头模式和 dev REPL 中不可用。

## 只追加轨迹

默认开启时，每轮都会向以下 JSONL 文件追加记录：

```text
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

内容包括本次运行的模型/模式（由 `/rewind` 分支出的会话，其运行记录还会写明来源会话和快照 id；`replay` 在该运行的标题行打印为 `rewound from <session> snapshot <id>`，恢复摘要也会重复这一句）、模型调用前持久化的用户输入、助手内容块、带上限的工具输入/结果、权限门每判定一次工具调用就写入的一条 `permissionDecision`（由哪一级裁定——`safe`、`allow-rule`、`classifier`、`yolo`、`user-approved`、`user-denied`、`deny-rule`、`plan-denied`、`write-scope-denied`、`restart-limit-denied`——当时生效的模式、是否向你发起了确认、匹配或授予的规则、子代理发起时的子代理标签，以及该调用的 `toolUseId`；绝不含工具输入，因为该调用自己的记录已经保存了它）、shell 命令记录、每次成功的 `/model` 切换写入的一条 `modelChanged`（切换前后的 provider/model，以及新模型实际生效的思考强度；运行记录仍写进程启动时的模型，切换失败则什么都不记录），以及 `turnEnded` 中的结束/失败/取消状态、耗时、费用和未保存事件数。失败会保留错误类、消息和被包装的供应商错误类。子代理的对话和事件不会写入（唯一例外是子代理的权限判定，会带上其派发标签）。权限记录只写日志：模型和屏幕看到的内容完全不变。

限制为：字符串最多 8,000 个 Unicode code point；单条记录最多 64 KiB；单会话文件最多 64 MiB。每次截断都会明确记录。思考内容只记录是否存在，不保存正文。已写入字节永不重写；中断只会留下有效前缀，读取器会报告末尾半行。记录失败时会放行主流程，并只提示一次。设置 `trajectory: false` 可完全关闭。

初始 `userInput` 在模型调用前有一个有界、失败时放行的落盘屏障；超时或写入错误不会替换供应商调用，也不会改变原错误。

交互界面的 `Ctrl+S` [草稿暂存](using-darwin.zh-CN.md#草稿暂存)只属于当前输入框，不是会话快照或轨迹记录。取回并正常提交之前，暂存内容不会进入恢复记录、回放、导出、历史回看或记忆。切换 `/model` 和执行 `/compact` 会保留它；成功清空会话、通过 rewind/tangent 创建后继会话或退出时，会丢弃并提示。

## 离线轨迹命令

```bash
darwin trajectory list
darwin trajectory search "npm install"
darwin trajectory search "flaky test" --session <id>
darwin trajectory replay <id>
darwin trajectory replay <id> --turn 3 --json
darwin trajectory fork <id>
```

这些命令不调用模型、不访问网络，也不重新执行工具。`replay` 会重建用户提示、助手回复、工具状态/结果预览、失败信息、费用，每次成功的 `/compact`——一行 `context compacted: 12 → 5 messages` 提示（只有消息数和可选的压缩前估算值，绝不含摘要或 focus 文本；其后的第一次模型调用显示 `context: reset by compaction`，而不是 SDK 过时的估算），每次成功的 `/model` 切换——按对话顺序出现的一行 `model changed: openai/<model> → bedrock/<model> · thinking effort high` 提示（运行标题行仍写该运行启动时的模型），以及每一次向你发起确认或拒绝调用的权限判定——紧挨在被判定的工具行之前的一行提示：`permission · bash · denied by deny rule bash:git push --force*`、`permission · fileEditor · approved by user (rule granted fileEditor:src/**)`，子代理的调用则如 `permission · bash · denied by user · explorer#d1`；静默放行（`safe`、`allow-rule`、`classifier`、`yolo`）不打印任何内容，因此没有确认也没有拒绝的会话重放结果与以前完全一致；不会还原 token 时序、思考内容、已截断字节或终端颜色。轨迹中包含失败回合并不代表读取失败，正常返回 0。搜索可按工具名、判定结果或规则找到权限判定。可读记录中没有搜索结果时输出 `no matches` 并返回 0；会话根本没有轨迹时返回 1。

`fork` 会把快照、卸载文件和轨迹前缀复制到新 ID，源文件与最近会话指针保持不变：

```bash
NEW=$(darwin trajectory fork session-20260816-101112)
darwin --session "$NEW"
darwin -p "carry on" --session "$NEW"
```

`/trajectory` 在本地报告当前运行的文件、记录数/字节数、截断和问题。`/export <path>` 精确写出 `formatReplay(replayRead(...))`，拒绝覆盖已有文件，也拒绝写入 `~/.darwin/sessions/` 内部；没有轨迹时只提示无内容可导出。`/copy` 则把最近一条已完成回答的文本（与导出内容相同的纯文本）通过 OSC 52 放到剪贴板，不触碰轨迹。

## 用量与费用

`turnEnded.spend` 会标记 provider/model，并分别记录 `input`、`output`、`cacheRead`、`cacheWrite`。供应商未报告的字段保持缺失，展示为 `-`，合计时显示 `(+N unreported)`，绝不冒充零。只有实测为零才记录 `0`。切换过模型的会话会拆分合计，不会混用价目；旧记录显示 unknown。

```text
turn 3 spend: input=412 output=1350 cacheRead=130961 cacheWrite=398 · bedrock/global.anthropic.claude-opus-5
session spend: input=412 output=1350 cacheRead=130961(+1 unreported) cacheWrite=398(+1 unreported) over 2 turn(s)
session cost: ≥ $0.0415 (cacheRead partly reported, cacheWrite partly reported; base rates, LiteLLM)
```

`trajectory list` 与 `trajectory replay` 也会离线为记录计价，单价来自实时会话填充的同一个 `~/.darwin/model-prices.json`——每个模型按各自缓存的单价计算。`list` 在每行会话后追加一段 `cost: …`；`replay` 在 `session spend:` 下方打印 `session cost:`，若不止一个模型参与，还在每个模型的 token 行后给出该模型自己的金额。缓存不认识的模型视为*未计价*：合计变成指明该模型的下限（`≥ $3.1250 (2 models; no price for us.made-up.model; …)`），绝不算作 0，也绝不省略；只有部分轮次报告的分桶按已报告部分计价并标注 `partly reported`；没有记录 spend 的轮次同样让合计成为下限（`N turn(s) unknown`）。没有缓存文件时显示 `cost: unknown (price unavailable)`。读取记录绝不会下载或写入价格；`/export` 完全不含成本行——导出的文稿只取决于记录本身。

这些数字来自 SDK 对回合的归因，不是账单。`/compact` 和溢出处理中的摘要调用绕过 meter，因此不会计入 `/usage` 或轨迹费用。回合编号在同一份轨迹文件内唯一：恢复运行会从文件中已有的最大 `turn` 继续编号，因此 `--turn N` 只选中一个回合（在此之前写下的记录仍可能包含多个 `turn 1`）；合计按实际结束记录统计。

### 成本

`/status` 与 `/usage` 按 LiteLLM 基础单价为本次运行的分桶计价，**每个模型用各自的单价**——`cost  ≈ $0.0123 (base rates, LiteLLM)`；headless 运行则在 `usage:` 之后以一条 stderr 记录写出同样的数字：

```text
usage: input=412 output=1350 cacheRead=130961 cacheWrite=398
cost: total=0.0415 input=0.0008 output=0.0135 cacheRead=0.0262 cacheWrite=0.0010 model=global.anthropic.claude-sonnet-5 pricing=global.anthropic.claude-sonnet-5
```

这只是估算：仅用基础档单价（不含长上下文或 1 小时缓存价目），摘要调用因为 meter 不计而不计入。`/model` 切换后，每个模型的 token 按该模型自己的单价计价：该行会标出模型数（`≈ $4.6250 (2 models; base rates, LiteLLM)`），`/usage` 在其下方为每个模型各加一行，混合中若有模型没有价格，数字就变成指明该模型的下限（`≥ $3.1250 (2 models; no price for <id>; …)`）；此时 headless 写出 `model=2-models pricing=mixed`。未报告的分桶绝不按 0 计价——TUI 显示下限（`≥ $0.0030 (cacheRead not reported, cacheWrite not reported; …)`），headless 则把该分桶和 `total` 都写成 `-`。`pricing=` 给出单价所用的 LiteLLM key，或 `none`（LiteLLM 没有该模型）/ `unavailable`（价目表尚未获取——离线，或后台下载还没完成）。子代理使用父级当前模型，按其单价计价。

单价来自 `~/.darwin/model-prices.json`，其中只保存每个模型 id 解析后的映射，不保存整张表。已经缓存的价格不会自动刷新；“无价格”结果（`litellmKey: null`）在 24 小时后过期，时间戳无效或在未来也视为过期。启动或 `/model` 时，缺失或已过期的无价格条目可触发后台获取，每个进程对同一 id 最多请求一次，并发调用共享请求。成功查询后仍无匹配价格，就重新开始 24 小时有效期；请求失败则原样保留旧条目，下一个进程可以重试。没有定时轮询，`/status`、`/usage` 和轨迹读取也不会刷新缓存。因此，上游新收录的模型不再需要手动删除缓存才能恢复计价。`DARWIN_MODEL_PRICES_FETCH=off` 关闭所有下载，包括过期条目的刷新。

## 项目记忆

轨迹可用时，记忆默认开启并存于工作树外：

```text
~/.darwin/projects/<project-key>/memory/
├── state.json       # 严格、带版本的权威状态
└── index.md         # 可选的人类可读投影
```

只有父 agent 能调用 `memory_recall` 和 `memory_save`，子 agent 不会获得这两个工具。Recall 在当前已校验条目上做有界、本地、确定性的词法排序，结果明确标为可能出错的数据而非指令或策略；它不调用网络、向量、embedding 或隐藏模型，也不会把完整归档常驻注入每次 prompt。

Save 走普通写权限。项目事实必须提供一条精确的当前项目相对源码行；明确用户偏好和非敏感账户身份必须引用当前用户输入中的精确文本。保存先暂存，只有同一回合以成功且轨迹已落盘的 `endTurn` 结束后才会持久化。失败、取消、部分输出、轨迹退化或落盘接受前 `/clear` 都会丢弃暂存。生成事实仍受 `memoryHorizonDays`（默认 28 天；`0` 只关闭时间过期）控制，并在 recall 时重新校验。

本地管理和审计命令为：

```text
/memory
/memory show <id|number>
/memory edit <id|number> <fact>
/memory remember <note>
/memory forget <id|number|all>
```

`remember` 会原子拒绝疑似密钥、prompt 边界标记、dump 和超长备注。`edit` 用同一套筛查就地纠正一个条目：备注直接重写；生成事实保留 key、类别、标题和证据锚点，记录编辑人和时间，抑制错误的前身 id，并且此后模型对该 key 的保存不再覆盖它（要改就再 edit 或 forget）。`forget` 会抑制生成 ID，防止完全相同的已忘记事实重新出现。不可读、伪造、项目不符或通过符号链接逃逸的 store 会被拒绝；校验/提交问题只产生提示。记忆不会重写轨迹、快照、指针、配置或仓库文件。

## 诊断日志

设置 `{ "diagnostics": true }` 后，SDK 的 `debug`/`info`/`warn`/`error` 与 darwin 通知会追加到：

```text
~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log
```

它默认关闭，因为供应商 payload 可能引用会话内容。字段未设置时，不做格式化，也不会创建文件。日志适合 `tail -f`，可用来查看限流、cache point 放置、token 统计降级和 MCP 重命名。

限制为：每行 8,000 个 Unicode code point；每会话 8 MiB；待写队列 1 MiB。达到文件上限时会写入一条结束说明；输入过快时丢弃并统计诊断行，不会丢 stream event 或阻塞代理。写入失败只提示一次。日志不会自动删除。SDK warning 会出现两次，一次来自 SDK，一次来自 darwin 通知。SDK logger 是进程级的，因此会包含子代理诊断；轨迹仍不包含子代理事件。

## 其他状态路径

```text
~/.darwin/config.json                                  全局模型/会话配置
~/.darwin/sessions/<project-key>/                      快照、轨迹、诊断、任务、卸载结果
~/.darwin/projects/<project-key>/permission-rules.json 项目放行与拒绝规则
~/.darwin/projects/<project-key>/memory/                项目记忆
```

卸载结果和后台日志需要在恢复后继续解析引用，因此会一直保留。当前没有会话垃圾回收，请自行删除已经结束的会话目录。旧版项目侧规则/会话可能作为迁移源读取，并在首次写入或恢复时复制到用户状态；仓库文件不会改动。
