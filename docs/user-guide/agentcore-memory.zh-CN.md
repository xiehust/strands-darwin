# 可选的 AgentCore Memory

[English](agentcore-memory.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 与本地记忆的关系

AgentCore Memory **默认关闭**。原有项目本地记忆工具 `memory_recall`、`memory_save`、`/memory` 及其验证、保留规则不变，不迁移本地记忆，也不回填历史。模型供应商与此功能独立，不会切换模型或另开代理循环。

启用后，主代理可通过权限检查检索项目 episode 和 reflection；宿主按配置检索用户偏好。上传需要单独开启，而且只支持手动预览、明确发送。云端偏好只是未经信任的上下文数据，不高于当前请求、项目约束或权限策略。

## 引导配置

在 TUI 输入 `/setup-agentcore-memory`。Darwin 会先完整加载[随包配置指南](../../src/skills/builtin/setup-agentcore-memory/SKILL.md)，通过普通权限检查只读查看现有 `~/.darwin/config.json`。如果记忆已启用且配置有效，再运行离线 `darwin doctor`、仅本地的 `darwin cloud-memory status`，以及使用已保存设置、通过 SDK 有界实时检索的 `darwin cloud-memory preferences`。空记录也算读取成功；结果仅汇报成功及数量，不展示或采纳偏好内容。即使 `preferences: false`，本次显式健康读取也仅用于检查，不启用偏好。上传关闭、显式项目范围和被忽略的旧设置都保持原样。

已配置且基本检查通过就无需重复设置：报告区域、actor、上传模式和本地/只读检查结果后停止，不再询问 actor 或默认值，不修改配置或资源，也无需重启。这不证明提取、写入/删除权限或策略拓扑正确。doctor 中无关的警告单独报告，不作为重置记忆的理由。读取被拒、配置不可读/无效或检查失败/未验证时，标记受阻或待修复，请求针对性确认并保留已有 actor 和资源，不当作配置缺失。只有确实缺失或明确禁用后的配置分支才询问 actor 和建议默认值；禁用不代表允许启用。明确要求重新配置时，先保留原配置的健康结果，再确认具体修改；参数和 yolo 模式不代表修改授权。

需要配置或资源修复时，优先复用你拥有且兼容的资源；否则建议独立的 DarwinMemory，说明区域、费用和保留期，在明确确认后才创建或修改配置。工具安装、IAM 扩权、上传、删除和基础设施导入不会隐式执行。默认建议采用自动项目隔离、有限的启动偏好读取和手动上传候选暂存，不自动发送；现有值会展示并保留，修改需要确认。

这是通过普通权限工具执行的模型引导流程，不是确定性的配置向导，也不是新沙箱。展开本身不修改配置或云资源。内置指南不能被项目或全局扩展覆盖，缺失或损坏会拒绝启动；激活失败会将原始提示、图片及后续排队的用户输入恢复到编辑器，放在新草稿之前，不自动发送。忙碌时排队到下一回合，trajectory 保留原始斜杠文本。指南随安装包分发，不依赖目标项目或仓库 docs，也是 namespace、资源请求和配置 JSON 的唯一模板来源。

TUI、开发 REPL、文本及结构化无头模式使用相同的展开路径。`darwin -p "/setup-agentcore-memory"` 也会加载指南。现有配置健康且无需修改时可以不提问直接结束；配置/修复需要输入时返回问题和待确认状态，不读取 stdin 或猜测。提问回合成功不表示配置完成。只有确认修改配置后才需要重启，当前 runtime 不会自动刷新工具列表。

## 资源准备与配置

资源配置与运行时数据客户端分离。无论手动配置还是授权 Darwin 执行，都使用随包指南中的精确 episodic、reflection 和用户偏好模板。

AWS 将 `{memoryStrategyId}` 替换为对应策略的 ID。资源的 `namespaceKeys` 必须声明小写自定义键 `projectid`；上传时通过 `extractionConfig.namespaceVariables.projectid` 提供小写值。缺少变量时，CreateEvent 仍可能成功，但不会提取长期记忆；应监控 AWS 提取日志和 `NamespaceResolutionFailure`。不要配置更宽的 reflection 命名空间：客户端检查返回记录的标签，无法撤销服务端已发生的跨用户汇总。IAM 应限制资源及操作：检索需要 `RetrieveMemoryRecords`、`GetMemoryRecord`，上传才需要 `CreateEvent`，明确删除才需要 `DeleteMemoryRecord`。原始事件 TTL 与长期记录保留是两回事。

运行时使用官方 `@aws-sdk/client-bedrock-agentcore` **3.1127.0**（要求 Node >=20，符合 Darwin 的 Node 支持范围），已包含 CreateEvent 的 `extractionConfig.namespaceVariables`。不需要 AWS CLI 可执行文件，也不启动能力检查子进程。凭证由标准 SDK 凭证链解析，支持环境变量、profile、容器凭证和实例角色，并遵守 `AWS_EC2_METADATA_DISABLED`。Darwin 不修改凭证，也不从凭证推断 actor。AgentCore region 由配置固定；`ignoreConfiguredEndpointUrls: true` 忽略环境变量和共享配置中的服务 endpoint URL，不修改进程环境。凭证服务使用独立的 SDK handler，不经过单次记忆请求的取消/JSON 检查。本地 STS XML 和签名测试覆盖标准 `role_arn`/`source_profile` AssumeRole 链；嵌套凭证客户端也忽略服务 endpoint 覆盖配置，并限制为一次尝试。凭证服务的 region 仍按标准 profile/SSO 配置选择。这不会禁用容器凭证 URI、实例元数据、SSO 或用户配置的 credential process；它们仍属于可信的用户凭证配置，不是模型输入。Get/Delete 同时发送固定的偏好 namespace，供 IAM condition 授权使用；本地范围校验不变。

**旧配置迁移：**确认后只移除 `agentCoreMemory.cliPath`。旧值若为最长 1024 字符的绝对路径，仍通过格式校验，但被忽略并显示有限的迁移提示，不执行或展示路径内容。保留 region、资源/策略 ID、actor、自动项目身份（省略 `projectId`）、`preferences: true` 以及原有的 `upload: manual` 选择。运行时不会自动重写配置、批准记录、命名空间或 outbox；新增未知字段仍报错。**部分旧偏好批准需要重新查看确认：**CLI 的 metadata 时间戳 `2026-01-01T00:00:00+00:00` 会变成 SDK ISO 格式 `2026-01-01T00:00:00.000Z`。Metadata 字节参与证据哈希，所以即使仅格式变化，该偏好也不会应用。本地批准检查后，状态会提示哈希变化，要求先 `/cloud-memory inspect <record-id>`，再确认显示的新哈希。旧批准不会被静默改写；字节一致的批准继续有效。

可选的 [`agentcore` 基础设施 CLI](../architecture/agentcore-cli-memory-plan.md) 是独立生命周期工具，不是运行时依赖。保留现有资源：已验证的 CLI schema 会丢弃 `namespaceKeys`，import 会过滤含 `{memoryStrategyId}` 的模板。必须另行证明迁移无损并取得授权后，才能导入或部署资源。

[随包指南的配置章节](../../src/skills/builtin/setup-agentcore-memory/SKILL.md#4-apply-only-the-approved-configuration)提供唯一的根级 `agentCoreMemory` JSON 模板。只将确认的字段合并到私有 `~/.darwin/config.json`，保留全部无关设置，权限设为 `0600`，不写入凭证或提交到仓库。现有 `trajectory: false` 与手动上传冲突，须先询问用户。

示例 ID 是占位符。`actorId` 是用户配置的稳定、不含身份信息的用户 ID，跨项目共用，不使用邮箱或 AWS 身份。`projectId` 独立于用户；省略时由规范化项目键计算 SHA-256。显式指定相同项目 ID，可让不同检出目录共享项目经验。Actor/strategy ID 使用字母、数字、`_`、`-`，最长 128 字符；项目 ID 必须小写且不超过 64 字符，与服务端 namespace value 上限一致。Region 必填，未知字段和路径穿越式字符串会被拒绝。`timeoutMs` 范围 100–15000，默认 5000；启用对象内的 `preferences` 默认 true；`upload` 仅支持 `off`（默认）或 `manual`，后者要求启用 trajectory。省略整个对象或设为 `false`，就不会创建云控制器、工具、网络请求或云状态。

AWS 说明：[命名空间](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html)、[episodic strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)、[CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-create-event.html)。

## 检索与偏好确认

主模型获得 `episodic_recall({intent, limit?})` 和 `reflection_recall({useCase, limit?})`。查询 1–300 字符，limit 为 1–5，默认 3；疑似秘密内容会被拒绝。Intent 描述任务目标，useCase 描述适用情境与约束，不发送原始日志。两者使用 `RetrieveMemoryRecords.searchCriteria.searchQuery` 和配置的 strategy ID，属于外部网络调用，不是静态安全的本地记忆读取。普通 hooks、plan 模式和 deny 规则先于 SDK 请求生效，子代理没有这两个工具。偏好启动检索则是宿主行为：启用 `preferences` 就明确授权了这项有限检索，包括 plan 模式。

`namespacePath` 是层级查询。Darwin 先验证所有返回记录的 namespace、strategy 和有限 metadata 是否属于配置的 actor/project/resource；错误范围导致整体拒绝。同一项目下混入 reflection 查询的 episode 则明确省略，并报告遗漏和不足条数，不为凑数扩大检索范围，不虚构服务端类型过滤器。Episode/reflection XML 转成有序树，保留证据、结果评价与操作顺序。属性、DTD、处理指令、未知实体、格式错误和超限 XML 都被拒绝。Reflection 的 confidence 表示估计的适用价值，不是正确概率；服务端格式变化可能导致保守拒绝。

假设云记录写着“用户明确要求简短回答”，这仍是模型生成的说法，不是用户证据，不会自动生效。请使用：

```text
/cloud-memory preferences
/cloud-memory inspect <record-id>
/cloud-memory confirm <record-id> <显示的哈希> global
/cloud-memory forget <record-id>
/cloud-memory delete <record-id> cloud
```

Inspect 显示完整、有限长度的偏好和哈希；confirm 表示你亲自将可见内容采纳为长期、**跨项目的沟通或协作偏好**。不要确认推测、一次性要求、项目限制或权限指令。批准绑定 region、资源、actor、strategy、namespace、record ID 和内容；内容变化必须重新查看并确认。没有虚构 citation 或 proof 字段。每个 runtime 首次模型请求前只检索一次，缓存最多五条候选。后续请求（包括 compact）只重读本地批准和撤销，不重复联网。`preferences` 显式刷新缓存，`inspect` 更新对应记录。云端修改在刷新或新会话时发现，不宣称服务端即时推送；PreCompact 拒绝发生在任何云检索之前。检索或证据不可用时不应用记录。支持并原样保留紧凑或多行的 `{context, preference, categories}` JSON 对象或有限数组，`language` 可省略：[AWS 提取使用数组，合并后存储单个对象](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-user-prompt.html)。批准哈希绑定原始字节；生成的 context 不是用户原话证据。查看与批准使用独立文件，并发 inspect 不会恢复已撤销的批准。

Forget 立即撤销本地批准，其他活动项目下次调用前也会重新检查；它不删除历史回复或云数据。Delete 是独立、明确、先验证范围的远程删除操作；源事件可能再次生成记录，但新记录仍未获批准。纠正偏好时，先 forget，再查看云端改正后的内容并确认新哈希。

## 预览并发送新回合

设置 `upload: "manual"` 后正常工作。只有新近结束、已持久化的 trajectory 回合进入候选队列，流式事件路径不等待 AWS。失败、取消、不完整的结果如实保留；`endTurn` 不代表任务成功。此时尚未发送：

```text
/cloud-memory pending
/cloud-memory preview <token>
/cloud-memory send <token> <preview-hash>
```

Preview 展示准确的 CreateEvent 请求体、范围、源 session/turn/顺序、遗漏说明和哈希。请检查隐私内容。白名单投影很保守，**但不是保密保证**：只保留有限的用户原始目标（`USER`）、工具操作及结果（`TOOL`）、源回合/结果/遗漏说明（`OTHER`）、工具名及极少数参数（`pnpm test|typecheck|build`、`git status --short`、fileEditor 操作名）、结果状态和数值退出码。不包含工具自由文本、文件和 diff、日志、敏感路径内容、系统/技能文本、推理、图像、二进制、子代理私有对话或任何记忆检索结果。助手文本全部省略，即使 preferences 关闭且未用工具，也可能复述私有图像、shell 报告、自定义命令展开或记忆。此举会丢失解释，但绝不把助手文本冒充用户原话。短小的用户目标也可能保密，仍须人工预览。不想上传时用 `/cloud-memory discard <token>` 明确丢弃并解除后续回合的顺序阻塞；只是不执行 send 会保留阻塞。没有后台自动发送器。

Send 必须对应已预览且未变化的字节。事件保留 Darwin session ID、回合顺序及稳定幂等 token；同一 session 的较早候选尚未接受时，后续回合不能越过它。最多三次明确请求的尝试，不自动重试。重启不重发已接受的事件。响应丢失时，AWS 可能已经接受，但本地仍显示 pending；重试复用完全相同的 token 和请求体。“AWS event accepted”绝不表示“episode 已生成”。提取和反思是异步的，不完整 episode 可能暂时不出现。

无界面 `darwin cloud-memory` 仅支持只读的 `status`、`preferences`、`inspect`、`pending`、`preview`；inspect/preview 不写入批准或预览凭据。失败、错误用法及取消返回非零退出码，关闭功能后的 status 可返回零。首版不提供无界面修改（开发 REPL 也不支持）；只有用户亲自提交的 TUI `/cloud-memory` 才能 confirm、forget、delete、send、discard、clear-accepted。哈希只绑定字节，不证明人类授权。这关闭了模型通过宽泛 bash allow-rule 调用管理 CLI 自我授权的入口，但不是 shell 沙箱：明确批准的任意 shell、伪终端驱动、直接 AWS CLI 或用户身份下的代码/文件访问仍可越过该命令边界。`/cloud-memory`、`/status`、启动及回合结束通知显示启用或降级状态，不增加实时框架行。忙碌时命令被拒绝，不进入提示队列。

## 边界、生命周期与验证

传输使用四个官方 AWS SDK Command，不使用 shell、可执行文件、stdin 或临时请求文件。输入仍最多 **32,000 个 UTF-8 字节**。通过公开的 HTTP-handler 扩展，在收集和解析前限制成功响应体为 **256 KiB**、错误响应体为 **8 KiB**；成功 JSON 在 SDK 反序列化前还要通过有限深度、节点数检查。SDK Date 转成 ISO 字符串，仅移除顶层 SDK `$metadata`，不移除记忆 metadata。未知响应字段会被拒绝，不让 SDK 静默丢弃字段后绕过验证。唯一例外是 RetrieveMemoryRecords 顶层的 `searchType` 提示字段，固定版本 SDK 尚未建模：必须是非空、不含控制字符且最多 64 个 UTF-16 码元的字符串，在记录校验前省略。其他操作和嵌套字段均不豁免，记录及 XML 校验保持严格。

`maxAttempts: 1` 将重试权留给手动 outbox。一个总时限覆盖凭证解析、签名、连接和响应读取。即使凭证提供器仍在等待，取消或超时也会返回；HTTP handler 的最终检查阻止迟到的凭证结果再发送请求。已发出的效果不能撤销。取消按控制器隔离，退出时销毁该 SDK 客户端及连接。服务诊断、凭证和请求 ID 不输出，可显示有限的 HTTP 状态。传输不创建或清理任何文件；原有持久 outbox 和状态文件仍为权限私有的明文，并非加密或安全擦除。

每次最多五条记录，每条最多 12,000 字符；XML 最多 500 个 token、16 层；不翻页下载历史。最多保存 64 条偏好的独立查看/批准文件，每次应用五条、每条最多 4,000 字符的已验证 JSON。每个项目/配置绑定的 outbox 最多 32 回合，每回合 24 个步骤，最多八个排队本地任务；trajectory 只读末尾 1 MiB，状态文件上限 64 KiB，目录最多 256 项。满额或降级会说明遗漏，不静默删除或淘汰；`/cloud-memory clear-accepted` 明确清除已接受的请求体、尝试和预览文件，释放 32 回合容量。discard/cleanup 先保存幂等回执或丢弃标记，禁止这些 token 再上传；回执账本最多 256 条，不自动淘汰，满后拒绝清理，需用户在 Darwin 外归档管理。未丢弃的 pending 仍保持顺序。send/discard/cleanup 用跨进程独占锁拒绝越过进行中的操作；崩溃遗留的 `active.json`（偏好状态有限写入也使用此锁）必须人工检查所有者后恢复，不自动抢锁。新状态先私有写入并 sync，再原子发布且不覆盖已有文件；中断的 `.tmp` 不计为事件或尝试，但占目录容量，后续运行不静默删除。旧版损坏的最终文件须人工检查，不猜测顺序。OTHER-only 旧请求体可预览、丢弃，但不能上传或自动转换。清理中断会明确报告，用户可重复命令，按回执或丢弃标记完成清理。

偏好批准在 `~/.darwin/agentcore/<binding>/`；outbox 在 `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`，均视为敏感用户策略路径，文件权限私有且拒绝符号链接。关闭功能不访问这些状态。`/clear`、`/rewind` 建立新控制器、刷新偏好，保留持久 outbox，不撤销 AWS 效果。取消按管理操作独立生效，即使刚结束磁盘等待，也不再发布新状态或发送 SDK 请求；Esc 后的新命令仍可使用。已发出的操作不会被撤销，已收到的 AWS 确认仍保留。云控制器退出时取消并等待管理及本地投影任务，最多两秒；超时明确报告尚未完成的文件 I/O，取消的修改仍被禁止，锁可能到 I/O 返回后才释放。send/compact 在本地偏好准备完成后、调用模型前再次检查取消，不重新检索缓存；若进程在投影落盘前崩溃，该候选可能遗漏，不补扫历史。原始事件 TTL 或删除**不会**删除长期记录。

离线验证：`pnpm tsx spike/verify-agentcore-memory.ts` 使用真实文件、SDK Command/序列化/签名、loopback HTTP、runtime/权限门和独立 Darwin CLI 进程。测试凭证及私有 HOME 隔离 AWS 和真实用户配置。覆盖 profile/容器凭证、endpoint 覆盖排除、输入/响应上限、凭证等待取消、磁盘发布取消窗口、明确偏好采纳和手动 outbox 回执。这些本地测试不证明真实 IAM 或提取。修复 `searchType` 兼容问题后，Host 已通过构建后的 Darwin SDK 路径检索现有资源：偏好、episode、reflection 均成功返回空结果。这验证了当前实例角色凭证下的读取连通性，不代表已验证提取、非空记录、上传/删除权限或所有凭证来源。

`pnpm tsx spike/verify-agentcore-memory-live.ts` 默认跳过；只有 `AGENTCORE_DISPOSABLE_CONFIG` 指向明确的一次性测试资源配置，且 `AGENTCORE_ALLOW_SYNTHETIC_UPLOAD=yes`，actor 以 `synthetic-` 开头，才上传另行授权的合成事件。不创建或删除资源，清理由所有者负责；它检验传输接受，不保证提取时机。实现 worker 未调用真实服务或上传合成事件；上述 Host 单独执行的只读观察不证明提取成功。
