# DeepSWE 前 20 题：darwin vs claude-code

**Bedrock Opus 5 · effort high · 并发 4 · pass@1** ｜ 2026-09-05

## 结论

两个 agent harness 在同一模型、同一批任务上**得分完全相同：12/20（60%）**。逐题对照 20 题里 18 题结果一致，仅 2 题分歧且方向相反（各赢一题）。在这个样本上，**分数由模型能力与任务难度决定，harness 的影响小于单次采样的噪声**。成本 claude-code 高 7.5%。

## 实验设置

两轮之间**只有 agent 不同**，其余逐字节相同。

| | darwin 轮 | claude-code 轮 |
|---|---|---|
| agent | `darwin` | `claude-code` |
| agent 版本 | `2240a3c8449ed8b5e06e5121d0d7c921af0d62e7` | `2.1.261` |
| effort 参数 | `thinking_effort=high` | `reasoning_effort=high` |
| 安装阶段放行 host | github / nodejs.org / registry.npmjs.org 等 6 个 | `downloads.claude.ai` |
| 额外 env | — | `CLAUDE_CODE_USE_BEDROCK=1` |

完全一致的部分：

- **模型**：`bedrock/global.anthropic.claude-opus-5`（cross-region inference profile），区域 `us-east-1`
- **鉴权**：`AWS_BEARER_TOKEN_BEDROCK`（Bedrock API key）
- **数据集**：`datacurve/deep-swe@sha256:aaa82ceb8404dccc17689c9383f93dbcbc8f029a7601d2e3856a416f2cb89269`，task schema 1.1
- **任务**：清单前 20 题（字典序），显式列名固定，非 `--n-tasks`
- **并发**：`n_concurrent_trials=4`；`n_attempts=1`；未设 `max_model_calls`
- **agent 阶段网络**：`no-network` + 仅放行 `bedrock-runtime.us-east-1.amazonaws.com`；verifier 全程无网络
- **单题 agent 超时**：5400 s（1.5 h）—— 无任何一题触顶
- Harbor `0.22.0`；两轮记录的 commit 不同（`e0165e9d` vs `475bd093`），但 `git diff` 在 `src/` 下为空，差异仅为一份 skill 文档，无行为影响

## 总体结果

| 指标 | darwin | claude-code |
|---|---|---|
| **通过** | **12/20（60%）** | **12/20（60%）** |
| 失败 | 8 | 8 |
| 异常/环境错误 | 0 | 0 |
| 成本 | $138.92 | $149.29 |
| input tokens | 168.5 M | 176.5 M |
| ├ 其中缓存命中 | 165.4 M（98%） | 173.0 M（98%） |
| output tokens | 1477 K | 1471 K |
| 单题耗时 | 11–33 min（中位 18） | 8–45 min（中位 18） |
| 每题均价 | $6.95 | $7.46 |

## 逐题对照

| 任务 | darwin | claude-code | darwin 用时(min) | cc 用时(min) |
|---|---|---|---|---|
| `abs-module-cache-flags` | ✅ 1.0 | ✅ 1.0 | 14 | 16 |
| `abs-stepped-slices` | ✅ 1.0 | ❌ 0.0 | 11 | 11 |
| `actionlint-action-pinning-lint` | ✅ 1.0 | ✅ 1.0 | 19 | 22 |
| `adaptix-name-mapping-aliases` | ✅ 1.0 | ✅ 1.0 | 28 | 29 |
| `aiomonitor-task-snapshots-diff` | ✅ 1.0 | ✅ 1.0 | 15 | 17 |
| `anko-default-function-arguments` | ❌ 0.0 | ❌ 0.0 | 22 | 21 |
| `anko-typed-variable-bindings` | ❌ 0.0 | ❌ 0.0 | 13 | 13 |
| `arcane-drift-detection-baselines` | ✅ 1.0 | ✅ 1.0 | 20 | 16 |
| `arktype-json-schema-refs-dependencies` | ❌ 0.0 | ❌ 0.0 | 33 | 26 |
| `awilix-async-container-initialization` | ❌ 0.0 | ❌ 0.0 | 19 | 18 |
| `bandit-incremental-cache-control` | ✅ 1.0 | ✅ 1.0 | 18 | 24 |
| `bandit-interprocedural-taint-checks` | ✅ 1.0 | ✅ 1.0 | 17 | 19 |
| `bandit-structured-nosec-directives` | ❌ 0.0 | ✅ 1.0 | 19 | 17 |
| `boa-hierarchical-evaluation-cancellation` | ❌ 0.0 | ❌ 0.0 | 25 | 45 |
| `cattrs-partial-structuring-recovery` | ✅ 1.0 | ✅ 1.0 | 22 | 19 |
| `clack-async-autocomplete-options` | ✅ 1.0 | ✅ 1.0 | 13 | 15 |
| `claude-code-by-agents-recursive-delegation` | ❌ 0.0 | ❌ 0.0 | 14 | 8 |
| `cliffy-config-file-parsing` | ✅ 1.0 | ✅ 1.0 | 17 | 25 |
| `csstree-shorthand-expansion-compression` | ❌ 0.0 | ❌ 0.0 | 18 | 16 |
| `dasel-html-document-format` | ✅ 1.0 | ✅ 1.0 | 17 | 13 |

## 两处分歧

| 任务 | darwin | claude-code |
|---|---|---|
| `abs-stepped-slices` | **通过** | 失败 |
| `bandit-structured-nosec-directives` | 失败 | **通过** |

分歧方向相反、数量对称。**在 `n_attempts=1` 下无法区分这是 harness 的系统性差异还是采样噪声** —— 要判定必须对这两题多次采样（`--n-attempts N`）后比较通过率。不要基于单次结果得出"某个 harness 更擅长某类任务"的结论。

## 两个 harness 都失败的 7 题

- `anko-default-function-arguments`
- `anko-typed-variable-bindings`
- `arktype-json-schema-refs-dependencies`
- `awilix-async-container-initialization`
- `boa-hierarchical-evaluation-cancellation`
- `claude-code-by-agents-recursive-delegation`
- `csstree-shorthand-expansion-compression`

这 7 题是当前配置下的**真实能力边界**，与 harness 无关，是最值得优先分析的对象。
两个 harness 都通过的 11 题：`abs-module-cache-flags`、`actionlint-action-pinning-lint`、`adaptix-name-mapping-aliases`、`aiomonitor-task-snapshots-diff`、`arcane-drift-detection-baselines`、`bandit-incremental-cache-control`、`bandit-interprocedural-taint-checks`、`cattrs-partial-structuring-recovery`、`clack-async-autocomplete-options`、`cliffy-config-file-parsing`、`dasel-html-document-format`

## 成本与耗时

- 两轮的 output token 几乎相同（1477K vs 1471K，差 0.4%），成本差异主要来自 input：claude-code 多消耗 8.1 M input token（+4.8%）。
- 两轮 input 都是**缓存主导（98% / 98%）**，这是单题成本能压在 $7–$7 的主要原因。评估这类长周期任务时，缓存命中率是第一位的成本杠杆。
- 单题中位耗时完全相同（均 18 min），但 claude-code 的分布更宽（8–45 min vs 11–33 min）。
- **整体墙钟时间不可比**：claude-code 轮一次跑完（121 min）；darwin 轮因下面提到的镜像拉取故障分两段执行，跨度 154 min 中含人工介入的间隔。

## 局限

1. **pass@1，单次采样。** 每题只跑一次，60% 这个数字本身有采样误差，两轮的"相同得分"也不代表 harness 等价。
2. **不能与历史 xhigh 结果对比。** 本次两轮都是 `high`；此前 darwin/claude-code 的前 5 题 5/5 是 `xhigh` 跑的，effort 不同不可混比。
3. **仅前 20 题**，非完整 113 题，且按字典序取前 20 —— 不是随机抽样，可能存在仓库/语言分布偏差（例如 `anko-*` 两题同属一个 Go 解释器项目且双双失败）。
4. **dataset 版本敏感。** 本次用 Hub pin（schema 1.1，超时 5400 s，采集未提交改动）；`deep-swe` 本地 clone 是 schema 1.3（超时 10800 s，只采集已提交改动，镜像 tag 带 `-v1.1`）。两者**不可比**，换版本必须重跑基线。

# 追加：effort medium 对照（2026-09-08）

**模型 opus 5 · 并发 4 · pass@1 · 同一 dataset pin 与同一份任务名单** ｜ 2026-09-08

两轮把 effort 从 high 降到 medium，agent 分别是 claude-code 与 darwin，其余按各自 09-05 那轮不变。

## 结论：省钱的结论站得住，涨分的不站

**两个 harness 各自独立地把 effort 从 high 降到 medium，成本各降 37% 与 40%，分数都是 12/20 → 13/20。**

方向和量级在两个互不相关的 harness 上复现了一次，这是本文档里第一个有重复验证的成本结论 —— 上面五轮全是单次。而且 claude-code 那一轮的 build 几乎没动（`2.1.261 → 2.1.263`，两个 patch 版本），**effort 基本就是唯一变量**，是目前为止最干净的一次对照。

**那 +1 分是噪声，不要读成"medium 更好"。** claude-code 在两个 effort 之间翻转了 7 题、darwin 翻转 3 题，而本文档的噪声基线是同配置两跑翻 6 题 —— 1 题的差距远在其中。能说的只有"降到 medium 没有让分数变差"，不能说"更好"。

**顺带复现了本文档最稳的那条结论。** 上面测到 Opus 5 下换 harness 不改变总分（high：12 vs 12）。medium 下同样成立：**13 vs 13**（4 题不同）。一个"无差异"结论在两个 effort 档上都成立，比任何"有差异"结论都硬。

实用推论：DeepSWE 这类任务在 Opus 5 上，**high 相对 medium 没买到可测量的分数，代价是约 1.6 倍成本**，两个 harness 一致。

## 总体结果

| 指标 | cc/O5 high（09-05） | **cc/O5 medium** | dw/O5 high（09-05） | **dw/O5 medium** |
|---|---|---|---|---|
| **通过（reward，分母 20）** | 12/20 | **13/20** | 12/20 | **13/20** |
| 成本 | $149.29 | **$94.42（−37%）** | $138.92 | **$83.97（−40%）** |
| 每题均价 | $7.46 | $4.72 | $6.95 | $4.20 |
| input tokens | 177 M | 113 M（−36%） | 168 M | 99 M（−41%） |
| 缓存命中 | — | 98.0% | 98.2% | 97.9% |
| output tokens | 1471 K | 966 K（−34%） | 1477 K | 903 K（−39%） |
| 单题耗时 中位（仅非异常） | 18 min | 12 (6–23) | 18 (11–33) | 11 (5–31) |
| 异常 trial | 0 | **0** | 0 | 1 |
| 端到端 | — | 70 min | 分两阶段，不可比 | 67 min |

