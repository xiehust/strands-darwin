# darwin 改名 + `.darwin/` 收敛：实测坑与决策记录（2026-08-13）

全部为实测结论。套件结果见本文件末尾。

---

## 坑 13：按字节截断 AGENTS.md 会给模型喂一个 `�`

`Buffer.prototype.toString('utf8')` 对**不完整的尾部多字节序列**会输出替换字符 U+FFFD。
32 KB 的截断点几乎必然落在某个字符中间（中日韩正文尤其），于是注入进 system prompt 的
项目规则最后一个字符是 `�`。

原本以为「截到最后一个 `\n`」就够了 —— 但**一整行超过 32 KB 时缓冲区里没有换行**，
兜底路径直接把带 `�` 的字符串交出去。`verify-agents-md.ts` 里用 `'。'.repeat(32768)`
（单行、无换行）才暴露出来。

修法：`node:string_decoder` 的 `StringDecoder`，它把不完整的尾部字节**留在内部不输出**，
而不是替换掉：

```ts
const decoded = new StringDecoder('utf8').write(slice);  // 不是 slice.toString('utf8')
const lastNewline = decoded.lastIndexOf('\n');
return lastNewline === -1 ? decoded : decoded.slice(0, lastNewline);
```

回归防护：`verify-agents-md.ts` 的 `truncating multi-byte text produces no replacement character`。

## 坑 14（测试侧）：产品名变短之后，断言「header 出现了」变成了假断言

原来 `assert('TUI rendered its header', screen.includes('strands-darwin'))` 是有效的。
改名成 `darwin` 后这条**永真**：verify-tui 的工作目录是 `/tmp/darwin-tui`，
`acceptance-e2e` 是 `/tmp/darwin-acceptance`，屏幕上到处都是 `darwin`。

改为断言 header 独有的 `/exit to quit`。
教训与坑 8 同源：**断言用的字符串必须是被测状态独占的**，
改名/改路径这类「无行为变更」的任务最容易让旧断言悄悄退化成永真。

## 决策：`.darwin/` 里混着「该入库」和「该忽略」两类东西

`.gitignore` 不能写整个 `.darwin/`：`config.json` 与 `skills/` 是团队共享配置，应当入库；
`sessions/` 与 `last-session.json` 是每次运行生成的。所以是两条精确条目：

```
.darwin/sessions/
.darwin/last-session.json
```

（README 里对使用者也这么写。）

## 决策：system prompt 的三段固定顺序

base prompt → `<project-instructions source="AGENTS.md">` → `<available-skills>`。

前两段在 `AgentRuntime.create()` 里由 `composeSystemPrompt()` 拼好，交给 `Agent` 构造函数；
第三段由 `SkillsPlugin.initAgent()` 在 `agent.initialize()` 期间追加（既有机制，未改）。
两处都是字符串追加，`verify-agents-md.ts` 的 `promptComposition` 用真的 `SkillsPlugin`
串起来断言了顺序，防止将来任一侧改成 block 数组时静默串位。

## 决策：MCP 双路径只读一个，不合并

`.darwin/mcp.json` 存在就只读它，根 `.mcp.json` 记进 `RuntimeInfo.mcpIgnoredConfigPath`
并在 header 用黄字提示。合并会让「实际生效的 server 列表」取决于两个文件，
排查时没法只看一个文件回答问题。
`verify-mcp-config.ts` 里用**两个文件放不同数量的 server**来断言到底读了哪个 ——
只断言 `configPath` 字符串不够，那只证明报告了什么，不证明加载了什么。

## 便宜的 TUI 断言：不提交输入的场景不需要模型调用

`agentsMd` 场景（超大 AGENTS.md → header 黄字警示）只看启动后的第一帧，
不 submit 任何东西，实测 **1 秒**跑完、零 token。`completion` 场景（2 秒）同理。
凡是「header / 补全 / 输入框」这类纯渲染的 PRD 要求，都该走这条路
而不是塞进一个要跑模型的场景里等 30 秒。

## 本仓库自身被 dogfood 影响的地方

改完之后在本仓库跑 darwin 会预加载本仓库的 `AGENTS.md`（即 Trellis 说明），
所以 `verify-skills-live.ts` 和 `verify-tui.ts` 的 `completion` 场景（都在 REPO_ROOT 跑）
的 header 现在多一行 `AGENTS.md: loaded (1.0 KB)`。已给 completion 场景加了对应断言，
顺带成了「header 显示预加载」的回归防护。两个模型套件不受影响（实测通过）。

## 质量检查补充（同日）：AGENTS.md「读不到」和「没有」必须区分

初版 `loadProjectInstructions()` 是 `catch { return undefined }`：文件不存在与文件存在但读不到
（`AGENTS.md` 是个目录 → EISDIR、无读权限 → EACCES）走同一条静默路径，header 也一样什么都不显示。
用户手里有一份自认为生效的项目规则，屏幕上没有任何东西反驳他 —— 正是
`error-handling.md` 降级规则表要防的那类静默失败。

改为返回 `{ instructions, problem }`（与 `scanSkills()` 的 `{ skills, problems }` 同形）：
ENOENT/ENOTDIR 静默，其余进 `RuntimeInfo.projectInstructionsProblem`，header 黄字
`AGENTS.md: skipped — <reason>`。空文件/纯空白仍按 PRD 静默跳过。
断言用「放一个名为 AGENTS.md 的目录」造 EISDIR，比 chmod 可靠（suite 以 root 跑时 chmod 无效）。

## 遗留：旧 `.strands-tui/` 未删

仓库里还有上一任务留下的 `.strands-tui/`（276 KB，快照路径含旧 agent id
`scopes/agent/strands-darwin/`，`AGENT_ID` 改成 `darwin` 后已经取不回来）。
按 PRD 不做迁移，`.gitignore` 条目也已按要求换掉，所以它现在是 untracked。
**没有代我删除**（不是本次任务产生的数据）；提交前 `rm -rf .strands-tui` 即可。

---

## 套件结果（全部实测）

| 套件 | 断言 | 说明 |
|---|---|---|
| `verify-config.ts` | 32/32 | 含「根 config.json 不再被读」 |
| `verify-mcp-config.ts` | 22/22 | 含优先/回退/并存三种，外加「优先文件坏掉时报错而不是回退到根文件」 |
| `verify-skills.ts` | 43/43 | 含「根 skills/ 不再被扫」 |
| `verify-agents-md.ts` | 29/29 | 新增；注入/跳过/截断/顺序 + 读失败上报 |
| `verify-step-1-2.ts` | 27/27 | 含 AGENTS.md live 注入（模型回复以 `DARWIN-ACK` 开头） |
| `verify-mcp.ts` | 18/18 | 真实 stdio server，走根 `.mcp.json` 回退路径 |
| `verify-skills-live.ts` | 10/10 | `.darwin/skills/` 下的双触发路径 |
| `verify-tui.ts` | 43/43 | 含新增 `agentsMd` 场景（超大文件截断警示 + 读不到时的 skipped 警示，两段共 3 秒、零模型调用）与 completion 里的 header 断言 |
| `acceptance-e2e.ts` | 10/10 | 真实 git 仓库 read → fix → test |
| `pnpm typecheck` | clean | |
