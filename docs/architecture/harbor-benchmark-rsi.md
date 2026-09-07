# Harbor 作为 RSI 自进化的 benchmark 目标 — 初步思路

> 状态：**提案草稿**（2026-09-07）。尚未实现任何代码；本文只记录调研结论、设计方向和分阶段计划。
> Harbor 以 git submodule 形式挂在 `external/harbor`（fork：`xiehust/harbor`）。

## 1. 为什么需要它

darwin 现在的自进化回路是：

```
self-evolution-research  →  backlog（Score 门 ≥ 6）  →  developer（headless worker）
        ↑                                                          ↓
self-reflection（单 session 轨迹打分）  ←────  独立验收：typecheck / pnpm test / spike 套件
```

这条回路里所有的"选择压力"都是**定性的、内生的**：

- backlog 的 `Score = 2×Importance + Architecture fit + Evidence confidence − Difficulty − Risk`，五个维度全是 1–5 的主观评级；
- developer 的验收标准是"没有回归"（typecheck、free suites、live spike 通过），而不是"darwin 变强了"；
- self-reflection 只看 darwin 自己的一次会话，评价者和被评价者是同一个系统。

名字叫 darwin，但目前没有一个**外部的、可复现的、量化的 fitness function**。Harbor + DeepSWE / Terminal-Bench 正好能补这个缺口：它们把"darwin 这个 commit 在同一模型下能解决多少真实软件工程任务、花多少钱、多长时间"变成一个数字。

## 2. 现状盘点（调研结论）

### 2.1 Harbor fork 已经有 darwin adapter

`external/harbor/src/harbor/agents/installed/darwin.py`（fork 最近 6 个 commit 全是它）：

- 在任务容器内 `git clone <repo_url> && git checkout <git_ref>`，装 Node 22 + pnpm 11，`pnpm install --frozen-lockfile && pnpm run build`，包成 `~/.local/bin/darwin`；
- 按 `--model <provider>/<id>` 和 `--agent-kwarg` 生成容器内 `~/.darwin/config.json`（`permissionMode: yolo`，可传 `thinking_effort`、`max_tokens`、`region`、`openai_api`、`bedrock_mantle`）；
- 固定以 `darwin -p "<instruction>" --yolo --output-format stream-json [--max-model-calls N]` 运行；
- 产物：`agent/darwin.jsonl`（stream-json，终态 `result` 带 usage）、`agent/darwin.stderr`；`populate_context_post_run` 把 tokens / cache read / cache write / cost 回填到 Harbor 的 `AgentContext`；
- 记录实际安装的 darwin commit SHA 作为 `agent_info.version`。

配套中文操作文档：`external/harbor/docs/content/docs/agents/darwin-deepswe.mdx`（单题冒烟 → 固定子集 → 全量 113 题，四种模型接入方式，可复现性清单，常见问题）。

**关键约束**：`git_ref` 必须是容器能从远端 checkout 到的对象——本地未 push 的 commit 不能评测。

### 2.2 两个数据集

| | DeepSWE | Terminal-Bench 2.0 |
| --- | --- | --- |
| 来源 | `~/workspace/deep-swe/tasks`（本地 clone，已是 Harbor task 格式，无需 adapter） | Harbor registry 内置 `terminal-bench@2.0`（89 题）、`terminal-bench-sample@2.0`（10 题） |
| 题量 | 113 题，TS / Go / Python / JS / Rust，取自活跃开源仓库 | 89 题，终端操作 / 系统配置 / 构建 / 调试等 |
| 任务形态 | 长周期 SWE：读 instruction.md，改 `/app` 里的仓库，**必须 commit**；verifier 在独立无网络容器里抽取 patch 跑隐藏测试 | 短到中等；agent 在容器里操作，verifier 跑 tests |
| 单题上限 | agent 3h、2 CPU / 8 GB；verifier 30 min | 通常几分钟到几十分钟 |
| 网络 | agent 阶段 `no-network`，需 `--allow-agent-host` 只放行模型 API（fork 已支持） | 大多数允许 |
| 测的是什么 | 长程规划、大仓库理解、编辑—测试—提交闭环 | 工具使用、shell 熟练度、环境排障 |
| 成本 | 高（长任务、长上下文） | 中 |

两者互补：Terminal-Bench 便宜、快、覆盖 darwin 的 bash / 后台任务 / 文件编辑基础能力，适合做**回归门**；DeepSWE 贵、慢、覆盖 darwin 的 subagent / workflow / context offload / compact 等长程能力，适合做**周期性全量**。

### 2.3 Harbor 的输出恰好是我们要的指标

- job 级 `result.json`（`JobStats`）：`pass_at_k`、`reward_stats`、`exception_stats`、`n_input_tokens` / `n_cache_tokens` / `n_output_tokens` / `cost_usd`；
- trial 级 `result.json` + `verifier/reward.json` + `ctrf.json` + `test-stdout.txt`：能区分"补丁没收集到"（darwin 忘了 commit）和"补丁收集了但隐藏测试没过"；
- `agent/darwin.jsonl` 是 darwin 自己的 stream-json 协议，可直接喂给 self-reflection。

### 2.4 本机条件

Docker 28.4、`uv`、全局 `harbor` 0.22.0（**不含** darwin adapter，必须在 `external/harbor` 里 `uv run harbor`）、`~/workspace/deep-swe` 已 clone。Bedrock 通过 EC2 instance role 访问。

## 3. 核心思路：把 Harbor 变成 RSI 的 fitness function

### 3.1 一句话

**每个候选进化 commit，在固定模型、固定任务子集、固定运行参数下跑 Harbor，与 baseline 比 pass@1 / cost / 时长；差值成为验收依据和下一轮研究的证据来源。**

这和 `v0.0.1` 作为 fixed point 的思想一脉相承：baseline 不动，后来的每个 commit 都能量出离它多远。

### 3.2 两层节奏

```
                 ┌───────────────────────────────────────────────────────┐
                 │  慢速层：全量  terminal-bench@2.0 (89) + DeepSWE (113) │
                 │  触发：每次 release / 每 N 次 accept / 手动             │
                 │  产出：docs/bench/full-<date>-<sha>.md，刷新 baseline    │
                 └───────────────────────────────────────────────────────┘
                                          ▲
                                          │ 累积
┌──────────────────────────┐   ┌──────────┴──────────────────────────────┐
│ developer 产出 candidate │──▶│ 快速层：smoke 子集                        │
│ commit（已 push）        │   │  terminal-bench-sample (10) + DeepSWE 短题 │
└──────────────────────────┘   │  5–8 题，n_attempts=1–2                  │
                               │  触发：commit 触及 agent 核心时的验收      │
                               │  产出：docs/bench/smoke-<date>-<sha>.md   │
                               └────────────────────┬────────────────────┘
                                                    │ 失败轨迹
                                                    ▼
                    self-evolution-research 新 path `bench`：从 darwin.jsonl +
                    verifier 输出里挖 **darwin 侧**（非模型侧）的改进方向 → backlog
```

- **快速层**只对"可能影响 agent 行为"的 commit 触发：`src/agent/**`、`src/tools/**`、`src/agents/**`、`src/hooks/**`、system prompt 组成、SDK patch。纯 TUI / 文档 / spike 改动不跑。
- **慢速层**给 release 定基线，也是 leaderboard 意义上的"darwin 现在到哪了"。

### 3.3 闭环：benchmark 失败 → 研究方向

self-evolution-research 目前有 `tui / observability / sdk / open / peer` 五条 path。加一条 **`bench`**：证据来源不是 darwin 自己的会话，而是最近一次 Harbor job 里 reward=0 的 trial。要挖的是可归因于 darwin 的模式，例如：

- DeepSWE 里 `model.patch` 为空 —— darwin 改了文件却没 commit → 是提示词 / 收尾阶段的缺陷；
- `--max-model-calls` 耗尽前长期在同一失败上重试 → retry-guard 或 plan 工具的问题；
- 上下文溢出后 offload / compact 行为不当；
- Terminal-Bench 里后台进程 / 长命令处理不当（`bash start/wait` 语义）；
- 工具错误信息不够让模型自纠。

这些方向进入同一个 backlog、走同一个 Score 门、由同一个 developer 实现——只是 `Evidence confidence` 第一次能由数字支撑。

### 3.4 必须分清：模型能力 vs darwin 工程能力

只有**同一模型、同一参数、不同 darwin commit** 的差值才是 darwin 的信号。控制变量：`--model`、`thinking_effort`、`max_tokens`、`max_model_calls`、任务名单（显式 `--include-task-name`，不用 `--n-tasks`）、`n_attempts`、Harbor 版本（submodule SHA）、数据集版本（deep-swe SHA）。

## 4. 设计草案

### 4.1 仓库内新增 `bench/`（名字待定，不进 `spike/`——它是 live、慢、贵的，不进 `pnpm test`）

```
bench/
  subsets/
    smoke.txt          # 5–8 题：terminal-bench-sample 里 3–4 题 + DeepSWE 里 2–4 题短任务
    regression.txt     # ~20 题
    full-tb.txt        # terminal-bench@2.0 全部
    full-deepswe.txt   # DeepSWE 全部 113
  run.sh               # 包装 `uv run harbor run`（cd external/harbor），固定参数，
                       #   --ak git_ref=<sha>，拒绝未 push 的 sha
  compare.ts           # 读两个 job 的 result.json，输出 Markdown 表：
                       #   pass@1、Δ、cost_usd、tokens、耗时、按题 reward 对照、exception 分布
docs/bench/
  baseline.md          # 当前 baseline：sha、模型、参数、任务名单、结果、job 路径
  smoke-<date>-<sha>.md
  full-<date>-<sha>.md
```

`compare.ts` 只读 Harbor 的 `result.json`，不碰 darwin 运行时——它是个投影，和 `/status`、`/export` 一样不新增信息通道。

### 4.2 与现有回路的接入点

| 接入点 | 改动 | 备注 |
| --- | --- | --- |
| `developer` skill 验收 | 增加可选 "bench gate"：触及 agent 核心时，Host 跑 `bench/run.sh smoke`，smoke pass@1 比 baseline 掉 ≥ 2 题即视为未通过 | 阈值先松，等噪声数据积累后再收紧 |
| `self-evolution-research` | 新 path `bench`（权重待定），report 模板加 "bench job 路径 + 失败 trial 列表" 表 | 不改 Score 公式，只是 Evidence 来源多了一种 |
| `docs/iteration-log.md` | 每条 accept 记录若跑了 bench，附一行 `smoke: 6/8 (baseline 6/8), $x.xx` | 论文脚注式的 paper trail |
| `self-reflection` | 允许把 Harbor trial 的 `darwin.jsonl` 作为反思对象（当前只接受本机 session 轨迹） | 需要研究 stream-json 与 trajectory 记录格式的差异 |

### 4.3 Harbor fork 侧可能要做的事（在 submodule 里改、往 fork 提 PR）

1. **本地 candidate 评测**：现在必须 push 到 GitHub 才能 `git_ref`。可考虑 `repo_url` 支持挂载本地 bare repo / `git bundle` 到容器，让"developer 刚 commit → 立刻 bench"不依赖远端。这是迭代速度的瓶颈。
2. **采集 darwin 自己的 trajectory**：容器内 `~/.darwin/sessions/<project-key>/*.jsonl` 比 stream-json 更完整（含 tool 输入、hooks、记忆、offload 事件）。adapter 在 post-run 把它拷进 `agent/` 目录，self-reflection 就有了原生输入。
3. **`darwin` adapter 的 Bedrock 凭证路径**：instance role 在容器里不一定可用，文档建议显式传短期凭证；bench/run.sh 要处理这一步。

### 4.4 darwin 侧可能要做的事（都是"benchmark 揭示了缺陷"之后再做，不预设）

- headless 模式是否需要 `--trajectory-dir` 之类的显式输出位置（便于 4.3.2）；
- DeepSWE 要求 agent 自己 commit：darwin 若经常忘记，这是 darwin 的缺陷，**不应**在 adapter 里 auto-commit 掩盖它；
- `--max-model-calls` 耗尽时的收尾行为（能否在预算耗尽前先 commit 已完成的部分）。

## 5. 风险与未决问题

1. **成本**。粗估（需要实测校准）：Terminal-Bench 单题几十万到几百万 token；DeepSWE 单题上限 3h，长上下文，单题可能 $5–30。全量 DeepSWE 一次可能上百美元、数小时墙钟（并发受本机 Docker 资源限制，2 CPU / 8 GB 每题）。所以：smoke 子集必须小，全量只在 release 跑，并考虑 `--env daytona/modal` 之类的云端并发。
2. **噪声**。模型非确定性使单题 pass 在 run 间波动。子集小时只能看趋势和严重回归，不能对单题下结论；baseline 至少 `n_attempts=3`。
3. **Goodhart / 过拟合**。darwin 若学到针对 Terminal-Bench 的技巧而不是通用能力，benchmark 就失效。对策：留 hold-out 子集不进 smoke；**任务内容、解法永远不进 darwin 的 skills / memory / AGENTS.md**；`bench` path 只允许提出通用的 darwin 侧改进；同时保留 `peer` 等其他 path 的权重。
4. **泄漏**。darwin 的 project memory 是 project-keyed、容器一次性，不会跨题带状态，但要确认 adapter 没有把宿主 `~/.darwin` 挂进容器（目前没有）。
5. **DeepSWE 的三阶段网络切换**依赖 Docker 支持动态网络策略；fork 文档里有排障项，需在本机验证。
6. **Harbor 版本漂移**。submodule 固定了 SHA，但 registry 里的 `terminal-bench@2.0` 是远端拉取的，需记录数据集 SHA。
7. **评测本身消耗 Bedrock 配额**，与日常开发 / live spike 抢限速；需要时段规划。

## 6. 分阶段计划

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| 0（本次） | submodule + 本文档 | `external/harbor` 可 `git submodule update --init`；本文档 |
| 1 冒烟 | 在 `external/harbor` 里 `uv sync`，用当前 `main` 的远端 SHA 跑 1 题 terminal-bench-sample + 1 题 DeepSWE（`abs-module-cache-flags`），Bedrock | 两个 job 都产出 `reward.json`，`darwin.jsonl` 终态 `result` 有 usage；记录实际耗时和 cost |
| 2 基线 | 定义 `bench/subsets/smoke.txt`、`regression.txt`；写 `run.sh` 和 `compare.ts`；`n_attempts=3` 建 baseline 写入 `docs/bench/baseline.md` | 任意两个 job 可 `compare` 出表格 |
| 3 接入 | developer 验收加可选 bench gate；self-evolution-research 加 `bench` path；iteration-log 记录格式 | 一次完整"研究 → 实现 → smoke 对比 → accept"跑通 |
| 4 全量 | terminal-bench@2.0 全量 + DeepSWE 全量，作为 release 基线 | `docs/bench/full-*.md`；README 可引用分数 |
| 5 反哺 | 把 4.3 的 trajectory 采集和本地 repo 挂载提到 fork | self-reflection 能直接消费 Harbor trial |

阶段 1 是最便宜的"能不能"验证，建议先做；阶段 2 之后才值得动 skill 和流程。

## 7. 参考

- `external/harbor/src/harbor/agents/installed/darwin.py` — adapter 实现
- `external/harbor/docs/content/docs/agents/darwin-deepswe.mdx` — 运行指南（中文）
- `external/harbor/src/harbor/models/job/result.py`、`models/trial/result.py` — 结果 schema
- `~/workspace/deep-swe/README.md`、`tasks/*/task.toml` — DeepSWE 任务格式与限制
- `src/skills/builtin/self-evolution-research/SKILL.md`、`docs/research/backlog_index.md` — 现有 RSI 回路与 Score 门
