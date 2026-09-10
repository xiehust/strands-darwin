# 可选的 AgentCore Memory

[English](agentcore-memory.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 与本地记忆的关系

AgentCore Memory **默认关闭**。原有项目本地记忆工具 `memory_recall`、`memory_save`、`/memory` 及其验证、保留规则不变，不迁移本地记忆，也不回填历史。模型供应商与此功能独立，不会切换模型或另开代理循环。

启用后，主代理可通过权限检查检索项目 episode 和 reflection；宿主按配置检索用户偏好。上传需要单独开启，而且只支持手动预览、明确发送。云端偏好只是未经信任的上下文数据，不高于当前请求、项目约束或权限策略。

## 资源准备与配置

请在 **Darwin 之外**准备一个已有 Memory 资源，包含一个 episodic strategy 和一个 user preference strategy。Darwin 不创建或修改资源、策略。命名空间模板必须为：

- Episode：`/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/sessions/{sessionId}/`
- Reflection：`/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/`
- 用户偏好：`/users/{actorId}/strategy/{memoryStrategyId}/preferences/`

AWS 将 `{memoryStrategyId}` 替换为对应策略的 ID。资源的 `namespaceKeys` 必须声明小写自定义键 `projectid`；上传时通过 `extractionConfig.namespaceVariables.projectid` 提供小写值。缺少变量时，CreateEvent 仍可能成功，但不会提取长期记忆；应监控 AWS 提取日志和 `NamespaceResolutionFailure`。不要配置更宽的 reflection 命名空间：客户端检查返回记录的标签，无法撤销服务端已发生的跨用户汇总。IAM 应限制资源及操作：检索需要 `RetrieveMemoryRecords`、`GetMemoryRecord`，上传才需要 `CreateEvent`，明确删除才需要 `DeleteMemoryRecord`。原始事件 TTL 与长期记录保留是两回事。

运行要求：POSIX 系统和支持 Memory 的 AWS CLI v2。默认路径为 `/usr/local/bin/aws`，其他位置需设置绝对路径 `cliPath`。**CLI 2.36.21 缺少 CreateEvent 的 `extractionConfig`，不能上传此功能的事件。** Darwin 发送前在本地检查 `create-event --generate-cli-skeleton input`，不兼容就拒绝。应安装 skeleton 包含 `extractionConfig.namespaceVariables` 的版本；文档不猜测最低版本号。AWS 凭证由用户配置，Darwin 不修改凭证，也不从凭证推断用户身份；适配器忽略 AWS endpoint 覆盖配置。

在 `~/.darwin/config.json` 根级添加以下对象，保留原有模型配置：

```json
{
  "agentCoreMemory": {
    "enabled": true,
    "region": "us-west-2",
    "memoryId": "YourMemory-0123456789",
    "episodicStrategyId": "YourEpisodes-0123456789",
    "preferenceStrategyId": "YourPreferences-0123456789",
    "actorId": "opaque-user-42",
    "projectId": "my-project",
    "cliPath": "/usr/local/bin/aws",
    "timeoutMs": 5000,
    "preferences": true,
    "upload": "off"
  }
}
```

示例 ID 是占位符。`actorId` 是用户配置的稳定、不含身份信息的用户 ID，跨项目共用，不使用邮箱或 AWS 身份。`projectId` 独立于用户；省略时由规范化项目键计算 SHA-256。显式指定相同项目 ID，可让不同检出目录共享项目经验。Actor/strategy ID 使用字母、数字、`_`、`-`，最长 128 字符；项目 ID 必须小写。Region 必填，未知字段和路径穿越式字符串会被拒绝。`timeoutMs` 范围 100–15000，默认 5000；启用对象内的 `preferences` 默认 true；`upload` 仅支持 `off`（默认）或 `manual`，后者要求启用 trajectory。省略整个对象或设为 `false`，就不会创建云控制器、工具、网络请求或云状态。

AWS 说明：[命名空间](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html)、[episodic strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)、[CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-create-event.html)。

## 检索与偏好确认

主模型获得 `episodic_recall({intent, limit?})` 和 `reflection_recall({useCase, limit?})`。查询 1–300 字符，limit 为 1–5，默认 3；疑似秘密内容会被拒绝。Intent 描述任务目标，useCase 描述适用情境与约束，不发送原始日志。两者使用 `RetrieveMemoryRecords.searchCriteria.searchQuery` 和配置的 strategy ID，属于外部网络调用，不是静态安全的本地记忆读取。普通 hooks、plan 模式和 deny 规则先于 CLI 生效，子代理没有这两个工具。偏好启动检索则是宿主行为：启用 `preferences` 就明确授权了这项有限检索，包括 plan 模式。

AWS 文档对 namespace 的精确匹配、层级匹配描述不一致。Darwin 使用 `namespacePath`，再检查每一条返回记录的所有 namespace、strategy 和有限 metadata；混入错误范围就整体拒绝，不虚构服务端类型过滤器。Episode/reflection XML 转成有序树，保留证据、结果评价与操作顺序。属性、DTD、处理指令、未知实体、格式错误和超限 XML 都被拒绝。Reflection 的 confidence 表示估计的适用价值，不是正确概率；服务端格式变化可能导致保守拒绝。

假设云记录写着“用户明确要求简短回答”，这仍是模型生成的说法，不是用户证据，不会自动生效。请使用：

```text
/cloud-memory preferences
/cloud-memory inspect <record-id>
/cloud-memory confirm <record-id> <显示的哈希> global
/cloud-memory forget <record-id>
/cloud-memory delete <record-id> cloud
```

Inspect 显示完整、有限长度的偏好和哈希；confirm 表示你亲自将可见内容采纳为长期、**跨项目的沟通或协作偏好**。不要确认推测、一次性要求、项目限制或权限指令。批准绑定 region、资源、actor、strategy、namespace、record ID 和内容；内容变化必须重新查看并确认。没有虚构 citation 或 proof 字段。首次及后续每次调用前，宿主只进行一次有限的一般偏好检索，最多应用五条哈希匹配的批准，放在标明不可信的上下文块中。检索或证据不可用时不应用任何记录。

Forget 立即撤销本地批准，其他活动项目下次调用前也会重新检查；它不删除历史回复或云数据。Delete 是独立、明确、先验证范围的远程删除操作；源事件可能再次生成记录，但新记录仍未获批准。纠正偏好时，先 forget，再查看云端改正后的内容并确认新哈希。

## 预览并发送新回合

设置 `upload: "manual"` 后正常工作。只有新近结束、已持久化的 trajectory 回合进入候选队列，流式事件路径不等待 AWS。失败、取消、不完整的结果如实保留；`endTurn` 不代表任务成功。此时尚未发送：

```text
/cloud-memory pending
/cloud-memory preview <token>
/cloud-memory send <token> <preview-hash>
```

Preview 展示准确的 CreateEvent 请求体、范围、源 session/turn/顺序、遗漏说明和哈希。请检查隐私内容。白名单投影很保守，**但不是保密保证**：只保留有限的纯文本用户目标、尚未接触工具或记忆数据时的公开助手陈述、工具名及极少数参数（`pnpm test|typecheck|build`、`git status --short`、fileEditor 操作名）、结果状态和数值退出码。不包含工具自由文本、文件和 diff、日志、敏感路径内容、系统/技能文本、推理、图像、二进制、子代理私有对话或任何记忆检索结果。会话一旦接触工具或偏好/记忆，后续助手文本全部省略，以免复述内容再次上传。短小的用户目标也可能保密，所以必须人工预览；不想发送就不执行 send，没有后台自动发送器。

Send 必须对应已预览且未变化的字节。事件保留 Darwin session ID、回合顺序及稳定幂等 token；同一 session 的较早候选尚未接受时，后续回合不能越过它。最多三次明确请求的尝试，不自动重试。重启不重发已接受的事件。响应丢失时，AWS 可能已经接受，但本地仍显示 pending；重试复用完全相同的 token 和请求体。“AWS event accepted”绝不表示“episode 已生成”。提取和反思是异步的，不完整 episode 可能暂时不出现。

无界面管理使用 `darwin cloud-memory <参数>`，不会调用模型。`/cloud-memory`、`/status`、启动及回合结束通知显示启用或降级状态，不增加实时框架行。忙碌时命令被拒绝，不进入提示队列。

## 边界、生命周期与验证

传输不使用 shell，JSON 走 stdin 而非 argv；单次 CLI 请求不自动重试；输入 32 KB、stdout 256 KiB、诊断 8 KiB；总时限和进程组取消受控，不输出服务端诊断中的潜在凭证。每次最多五条记录，每条最多 12,000 字符；XML 最多 500 个 token、16 层；不翻页下载历史。最多保存 64 条本地偏好批准，每次应用五条、每条 1,000 字符。每个项目/配置绑定的 outbox 最多 32 回合，每回合 24 个步骤，最多八个排队本地任务；trajectory 只读末尾 1 MiB，状态文件上限 64 KiB，目录最多 256 项。满额或降级会说明遗漏，不静默删除或淘汰；已接受记录也占容量，需用户检查后在 Darwin 之外管理旧本地状态。

偏好批准在 `~/.darwin/agentcore/<binding>/`；outbox 在 `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`，均视为敏感用户策略路径，文件权限私有且拒绝符号链接。关闭功能不访问这些状态。`/clear`、`/rewind` 建立新控制器、刷新偏好，保留持久 outbox，不撤销 AWS 效果。退出取消 CLI，并等待有限的已接受本地投影任务；若进程在投影落盘前崩溃，该候选可能遗漏，不补扫历史。原始事件 TTL 或删除**不会**删除长期记录。

离线验证：`pnpm tsx spike/verify-agentcore-memory.ts` 使用真实文件、子进程、runtime 和权限门，不调用 AWS。`pnpm tsx spike/verify-agentcore-memory-live.ts` 默认跳过；只有 `AGENTCORE_DISPOSABLE_CONFIG` 指向明确的一次性测试资源配置，且 `AGENTCORE_ALLOW_SYNTHETIC_UPLOAD=yes`，actor 以 `synthetic-` 开头，才上传合成事件。不创建或删除资源，清理由资源所有者负责；它检验传输接受，不保证提取时机。本次实现没有提供一次性资源，因此没有验证真实服务行为。
