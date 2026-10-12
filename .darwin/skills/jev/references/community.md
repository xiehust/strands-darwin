# Community evidence ledger

New: [all 15 + 22 + 39 supplied entries](intake-2026-09-21.md), with recovered original links, duplicates and evidence limits.

For a task-based comparison of MCP, browser/desktop, routing, context, code-review
and playground projects, see the [pinned ecosystem guide](ecosystem.md).

Research snapshot: **2026-09-20**. These are sources for recipes, not endorsements or a claim that this skill reproduces another project's results. Jev was newly released; most public evidence is small, developer-run, and rapidly changing. Reddit dates below come from indexed post dates; cached relative timestamps can disagree.

## Evidence vocabulary

- **Reported:** a user says they tried it, with the sample size/limitations shown when available.
- **Prototype:** public project documentation describes an implementation. Reading it is not running it.
- **Demo:** an author publishes a bounded demonstration; not broad reliability evidence.
- **Proposed:** the source explicitly describes an idea, future test, or work awaiting access.
- **Adaptation:** a recipe designed for this skill from a documented pattern; not a verified community deployment.

Every recipe is an **Adaptation** unless explicitly stated otherwise. Its source link explains the precedent, not proof of this recipe's accuracy. Vendor claims, raw probabilities, a green CI badge, or a repository count do not establish downstream agent success. None of the external experiments below was independently reproduced for this ledger.

## Reddit: firsthand reports, experiments and objections

<a id="r01"></a>

### R01 — Recipe versus scraper routing

**2026-09-17 · Reported · Two examples.** A personal-knowledge-app builder gave agents role descriptions. An incomplete tofu-recipe transcript selected a scraper in reported 145 ms; a transcript with ingredients/steps selected a recipe agent in 271 ms, including network. The author explicitly says this is not an evaluation. Proposed extensions include prefetching, crawl prioritization and cross-map place matching. Comments recommend near-neighbor/multi-intent/missing-context cases, a none-of-the-above option, calibration and irreversible-action confirmation. A family-calendar/meal-planner integration was planned, not demonstrated.

[Reddit report and discussion](https://www.reddit.com/r/LLMDevs/comments/1wihigc/tried_typesafes_new_decisiononly_model_jev_as_an/)

<a id="r02"></a>

### R02 — A supervisor that steers the agent

**2026-09-17 · Reported / Prototype.** pi-warden's author describes intended-action checks, irreversible-action holds, Markdown rule checks, repeated-failure detection and unsupported completion claims. Feedback usually goes to the agent, not the absent user. The author reports replaying roughly 17,000 personal tool calls: off-task holds performed poorly and became advisory steers, while plan-versus-call checks were more useful. This is an important negative result: more intervention can make an agent worse.

[Reddit launch](https://www.reddit.com/r/PiCodingAgent/comments/1wimfhg/piwarden_a_jevpowered_second_pair_of_eyes_for_pi/) · [Current project](https://github.com/DevMortimer/pi-warden)

<a id="r03"></a>

### R03 — Tool safety prototype and atomic questions

**2026-09-16 · Prototype / Proposed.** A Pi user was implementing tool-call safety ratings; prompt-intent alignment and model routing were next ideas. They found explicit questions important. A reply proposes choosing NPC actions from LLM-written candidates. The author notes that Jev does not directly consume images: game examples need a structured-state adapter. No broad safety evaluation is supplied.

[Reddit thread](https://www.reddit.com/r/PiCodingAgent/comments/1whsav6/anyone_else_testing_out_typesafe_ais_new_system/) · [Question-design comment](https://www.reddit.com/r/PiCodingAgent/comments/1whsav6/comment/pa4q36u/)

<a id="r04"></a>

### R04 — Local-model tier selection and response checking

**2026-09-18 · Reported · Small developer-authored test.** A four-tier local setup reports 16/16 routing labels and 15/15 refusal/empty-response detections, with roughly half-second hosted decisions. Avoiding a wrong model load is useful even when inference is local. The author keeps sensitive local-only traffic away from the hosted classifier. This is not evidence of general quality parity. Their fallback to an uncensored model is not part of this skill: response checks must not be used to circumvent host safety rules.

[Reddit report](https://www.reddit.com/r/LocalLLaMA/comments/1wk0st3/routing_between_a_3b_a_4b_a_12b_and_a_26b_moe/) · [Author's setup](https://github.com/clduab11/the-array)

<a id="r05"></a>

### R05 — Concern screening, policy checks and product categories

**2026-09-19 · Reported anecdotes / Proposed.** One user says they first screen long conversations for concerns, then call a larger model only on positives; they also compare policy clauses with supplied legislation. Reported savings and high accuracy lack a labeled dataset or receipts. Other commenters describe early tests of manufacturing-product categories and travel-tool handoffs; a game bot is another anecdote. Login-abuse filtering and sales-call next steps are suggestions. Treat legal/compliance labels as triage, not authoritative conclusions.

[Discussion](https://www.reddit.com/r/ArtificialInteligence/comments/1wkhsyh/jev_typesafeai_is_revolutionary_as_llms/) · [Direct policy/prefilter comment](https://www.reddit.com/r/ArtificialInteligence/comments/1wkhsyh/comment/paqmh38/)

<a id="r06"></a>

### R06 — Context pruning: compression is not agent quality

**2026-09-19 · Reported · Three paired shadow snapshots.** A Hermes extension compares Jev selection against stock summarization on frozen contexts. The author reports mean reductions of 75% versus 55% and 5.6 versus 44.8 seconds. The live agent still consumed the stock output. Those measurements establish neither preserved task quality nor fewer total tokens after rework. Comments warn that pruning tool state can remove dependencies, repeat work and damage caching; tool/skill selection is offered as a less destructive alternative.

[Hermes experiment and critiques](https://www.reddit.com/r/hermesagent/comments/1wkpl3q/integrated_the_jev_context_engine_into_hermes/) · [Separate prompt-cache warning](https://www.reddit.com/r/ArtificialInteligence/comments/1wkhsyh/comment/paqvj6d/)

<a id="r07"></a>

### R07 — Avoiding unnecessary agent turns

**2026-09-19 · Prototype.** A Hermes showcase describes filtering bulky results before history insertion, suppressing duplicate observations within a mutation epoch, and returning a deterministic completion reply when tool evidence already suffices. The post gives architectural claims, not a controlled quality result. A model classification does not make a write successful.

[Showcase thread](https://www.reddit.com/r/LocalLLaMA/comments/1wgcpww/biweekly_megathread_project_showcase/) · [Project](https://github.com/rsdkrasen/hermes-jev-router)

<a id="r08"></a>

### R08 — Ideas that had not yet been tested

**2026-09-18 · Proposed.** The opening post proposes routing among 250–300 API calls but explicitly says access has not arrived. Comments suggest CV/job matching, pruning repetitive tool traffic and selecting old history. These are inspiration, not deployment evidence. A later indexed commenter reports experimenting with intent routing in a sports-research app while deterministic code performs the rankings; there is no controlled accuracy result.

[Thread](https://www.reddit.com/r/PiCodingAgent/comments/1wjibh5/anyone_here_using_jev/) · [CV-matching proposal](https://www.reddit.com/r/PiCodingAgent/comments/1wjibh5/comment/paiv33r/)

<a id="r09"></a>

### R09 — Home automation

**2026-09-18 · Proposed.** The discussion suggests resolving entities and actions from natural-language requests, then routing requests requiring generation to a general LLM. It does not establish reliable control of a real home. Locks, alarms, appliances and other consequential devices still need explicit authorization and deterministic safeguards.

[Home Assistant discussion](https://www.reddit.com/r/homeassistant/comments/1wjmqj0/upcoming_revolution_for_smart_home_control_with/)

<a id="r10"></a>

### R10 — Game control through structured observations

**2026-09-20 · Demo.** A Doom comparison gives four models textual visible-object/HUD state and asks for one button action. Episodes start from the same seed but diverge after each model acts. The video uses selected episodes, and hosted Jev versus local models includes different hardware/network conditions. It illustrates bounded feedback loops, not visual perception or general planning superiority.

[Demo and measurement boundaries](https://www.reddit.com/r/LocalLLaMA/comments/1wl1yzq/i_gave_jev_laya_finetuned_modernce_and_qwen35_the/)

<a id="r11"></a>

### R11 — A useful local baseline

**2026-09-19 · Reported.** choosekit's author reports identical 96.53% accuracy for local Qwen3.8 27B Q4 XL and hosted Jev on SemIf's 144 tasks, with medians of 239 ms and 368 ms. This bounded comparison is not universal equivalence; infrastructure, privacy and operating costs differ. Do not assume a generic LLM is always slower or more expensive.

[Reddit experiment](https://www.reddit.com/r/LLMDevs/comments/1wkc9hp/i_tried_jevstyle_decisions_with_local_qwen_same/) · [choosekit](https://github.com/NotXf1le/choosekit)

<a id="r12"></a>

### R12 — Ecosystem map, not an execution audit

**2026-09-19 · Discovery lead.** An author describes reviewing 287 Jev-related projects, covering browser/desktop actions, context filtering, routing, code navigation/review, games, graph search, data curation and evaluation. The upstream list already advertised a different total when checked. We did not reproduce its claimed source audit or execute every project. Use the directory to find original implementations, not to infer adoption or reliability.

[Reddit overview](https://www.reddit.com/r/LLMDevs/comments/1wko2e5/i_reviewed_287_opensource_jev_projects_here_are/) · [Directory](https://github.com/logicrw/awesome-jev-projects)

## Original project references and competition

<a id="p01"></a>

### P01 — JevRouter: direct integration overlap

**Prototype / maintainer benchmark.** Existing CLI, SDK, skill and optional MCP integration for routing among models, tools and subagents; supports OpenRouter environment credentials and separates permission/risk policy from probabilities. Its published comparison predicts five ordered tool calls on ten Toolathlon tasks, not end-to-end task completion. Reported 38% versus 24% position accuracy should not be reused as this skill's result. Generic routing or “a Jev skill” is not a novel product claim.

[Repository and benchmark scope](https://github.com/BillionsBobby/JevRouter)

<a id="p02"></a>

### P02 — pi-warden: agent feedback and paired evaluation

**Prototype / maintainer benchmark.** Current README covers action/rule/stuck/done/security guards, subagent-report triage and recoverable output trimming. It reports 150 paired runs with six control rule violations versus zero guarded violations and links evaluation reports. We did not rerun them; the test population and policy determine applicability. Read alongside the negative off-task-hold result in R02, rather than assuming every guard helps.

[Repository, evaluation links and data handling](https://github.com/DevMortimer/pi-warden)

<a id="p03"></a>

### P03 — Canny: facts versus semantic judgments

**Prototype / host-hook demo.** A local ledger tracks edits, exit codes and validation freshness; deterministic checks handle test removal and repeated failures. Jev advises on rule violations and whether a message claims completion. The documented live hook session made an agent run checks before finishing, but the README separately says the Jev part was tested with mocked endpoints. Do not attribute the deterministic success to Jev. A command exiting zero is still not proof of adequate test coverage.

[Repository and limitations](https://github.com/qkal/Canny)

<a id="p04"></a>

### P04 — SemDecide: human-facing Unix primitives

**Prototype.** A CLI exposes semantic predicates, queue choices, ordinal rubric scores, JSONL filters and action-risk signals, with explicit uncertainty/error outcomes. Examples include account-takeover signals, churn, breaking changes and answer quality. This is the closest precedent for treating Jev as a composable tool rather than an autonomous agent. Its README examples are not an accuracy benchmark.

[Repository and CLI recipes](https://github.com/sharziki/semdecide)

<a id="p05"></a>

### P05 — Browser Use: decision, generation and execution split

**Demo / maintainer measurements.** Jev selects operations and observed DOM IDs; a small text model supplies text when needed. The roughly seven-second Flights example **searches for options, not books tickets**. Freshness and compatibility checks remain in code, and a separate check verifies the final route/date/results. A small before/after optimization study used three repeats per version of one task; it was not an agent-with-versus-without-Jev study. Complex widgets, frames and uploads have limits.

[Repository, traces and measurement boundaries](https://github.com/browser-use/jev-ultrafast)

<a id="p06"></a>

### P06 — Retrospective agent-failure attribution

**Maintainer benchmark.** jev-agent-failure-benchmark reports results on 6,257 text traces with injected failures, identifying agent, step and error type. Its LLM reference scores come from a paper; Jev receives constrained agent/step options while those baselines free-generate. The error-taxonomy comparison is closer to like-for-like. Retrospective attribution is not evidence of successful live recovery or autonomous blame assignment.

[Repository and comparability caveats](https://github.com/TokenTrim/jev-agent-failure-benchmark)

<a id="p07"></a>

### P07 — Review prioritization

**Prototype.** Jev Review stages risk questions, file/evidence selection, mechanism classification and severity scoring. It supplies concrete review leads, not proofs of defects. Its README says it does not yet integrate compiler diagnostics or static analyzers. Keep tests, static tools and human inspection; use the classifier to prioritize attention.

[Original project](https://github.com/devagrawal09/jev-review)

<a id="p08"></a>

### P08 — Dataset filtering

**Prototype.** jev-curate describes filtering/scoring JSONL and Parquet records without rewriting retained text. Its throughput and reasoning-quality claims were not validated here. A rubric about prose quality is not a mathematical proof checker; do not transfer its marketing numbers into this skill.

[Original project](https://github.com/AkashPriyadarshii/jev-curate)

<a id="p09"></a>

### P09 — Reranking retrieved documents

**Maintainer benchmark.** hev/reranker asks a relevance Noul for each document in a shared shortlist. Its published comparisons use the same BM25 top-30 candidates on three corpora and include uncertainty/position/calibration checks. Results differ by corpus; Jev does not dominate every purpose-built reranker. Relevance is not source truth or evidence sufficiency.

[Original recipe and results](https://github.com/hev/reranker)

<a id="p10"></a>

### P10 — Structured idea appraisal

**Prototype.** killmyidea asks separate rubric questions, then local weights and a clarity gate derive a playful kill/fix/ship label. It is an example of separating semantic scores from arithmetic, not market validation or investment advice. The product can archive submitted ideas, so do not send confidential ideas to a demo merely to test the pattern.

[Original project](https://github.com/monteduro/killmyidea)

<a id="p11"></a>

### P11 — Local alternatives are not official Jev weights

**Prototype / competing claims.** OpenJev, Laya, Von and choosekit offer local or compatible approaches. Their model architectures, training and hardware differ; “beats Jev” reports need matched tasks and measurement boundaries. Reddit users also report replacements performing worse for their own data-analysis workloads. This skill's OpenRouter transport is not a claim of drop-in compatibility with those APIs.

[OpenJev](https://www.reddit.com/r/LocalLLaMA/comments/1wjlyzr/still_on_the_jev_waitlist_i_hosted_openjev_its/) · [Laya](https://www.reddit.com/r/LocalLLaMA/comments/1wjieap/made_the_horizontal_opensource_model_for_jev_with/) · [Von and critical feedback](https://www.reddit.com/r/LocalLLaMA/comments/1wkpxn6/von_opensource_395m_system_one_model/)

## Firsthand blogs and non-Reddit experiments

<a id="n01"></a>

### N01 — LangChain: judging frozen agent traces

**Published 2026-09-20; experiment started 2026-09-18 · Reported / public experiment.** LangChain captured five weather-agent runs, including tool calls and evidence, and evaluated each 100 times against one human reviewer's labels. Jev agreed on all **500 repeated binary decisions**, with lower continuous-score variance than the three LLM judges. These are five distinct cases, not 500 independent tasks. The repository contains frozen cases, oracle labels and analysis; it reports 0.44 s average Jev latency. This supports testing inexpensive trace evaluation, not claiming better long-horizon execution. LLM sampling parameters were left at provider defaults; the Jev service version was unavailable. Low variance can still mean consistently wrong, so test representative failures and human agreement separately. Use the official API reference for question types rather than the blog's inconsistent illustrative examples.

[LangChain experiment](https://www.langchain.com/blog/jev-agent-evals-langsmith) · [Author's code, frozen cases and results](https://github.com/danielgshea/jev-as-a-judge)

<a id="n02"></a>

### N02 — Agent Journal: feature extraction versus a direct decision

**Published and run 2026-09-17 · Reported / author-run experiment.** The author compared a direct Jev classification with 12–14 semantic dimensions plus fitted weights, alongside cheap lexical baselines. On 2,101 held-out bookkeeping rows, dimensions reached 91.05% versus 39.98% direct; word-bigram Naive Bayes reached 94.91%, and stacking both reached 96.95%. Inputs included credit-side accounting context; this is not bare-bank-statement categorization. On 2,434 Japanese NLI cases, dimensions reached 90.76% versus 83.73% direct. But for prompt-injection screening, dimensions increased hard-benign false positives from **1.5% to 37.2%** despite higher in-domain accuracy; external performance also worsened. Hand-written dimensions, private ledger data, label noise and split sensitivity limit transfer. The useful pattern is cached semantic features plus a cheap fitted model, with held-out and hard-negative checks—not a universal rule to decompose every decision. The source's blanket warning against twelve-choice questions is not established by one weak task.

[Author's experiment, baselines and caveats](https://agentjournal.dev/blog/llm-judge-vs-feature-extraction/)

<a id="n03"></a>

### N03 — Parallel: reranking versus specialized classifiers

**Published 2026-09-18 · Reported / internal benchmark.** Parallel tested query–document relevance against its own trained rerankers. It reports Jev NDCG@10 of **0.7**, comparable to at least one internal system using human relevance labels, with competitive latency against larger models. Cost per document was materially higher than its internally hosted rerankers. Jev lost to specialized internal models on both broad topic classification and whether a query needs fresh information. The article provides no dataset size, raw predictions or detailed latency table, so this is a firsthand company report, not a reproducible public benchmark. It motivates zero-shot reranking and freshness/topic-routing trials when no trained classifier exists; it does not establish deployment at Parallel's production volume. Include existing cheap classifiers and serving costs in comparisons.

[Parallel's three-task report](https://parallel.ai/blog/testing-jev)

<a id="n04"></a>

### N04 — PrimeLine: real workflow labels and targeted repair

**Published 2026-09-18; live article includes corrections · Reported / author-run experiment.** The author compared Jev and three LLMs on personal workflow records. On 800 commit messages, Jev's stored-prefix agreement was 65.8% versus Haiku's 54.6%; on 450 saved knowledge notes, Jev's stored-category agreement was 90.7% versus Haiku's 97.8%. Unanswered items counted as wrong. Much of both corpora was Claude-influenced, from one developer/project; labels are historical choices, not independently verified semantic truth. Prompts/interfaces also differed. An additional atomic preference-versus-fact question recovered **23 of 53 selected note-classification failures**; this is targeted error-bucket repair, not a 43.4-point overall improvement. Confidence-ranked subsets can help triage, but compare equal coverage and, separately, identical retained items. A threshold from this task or question shape is not a reusable default.

[Author's live report and corrections](https://primeline.cc/blog/typesafe-jev-pre-registered-test)

<a id="n05"></a>

### N05 — A compaction replay where the classifier added little

**2026-09-18 · Reported / firsthand issue with replay code.** A user replayed personal Claude Code sessions through fast-jev-compaction at commit `e3f262a` with real `jev-latest`: eight compaction points, two projects, 277 calls, 256 scored results. Every result-retention score was below 0.3. Real Jev and an always-zero stub produced similar character reduction (87.7% versus 88.5%); both lost 16 results flagged by a later-use proxy. The classifier received tool names, inputs and omitted-result lengths, not the result content it was asked to judge. The user proposed supplying excerpts and deterministic protection for failed calls, edits and irreplaceable outputs. These are proposed repairs, not verified improvements. The proxy overcounts coincidences and misses paraphrases; sessions were mostly Chinese, and repeated compaction was not tested. Compare against a no-model control and preserve actual evidence before attributing compression benefits to Jev.

[Original issue, methodology and replay-code link](https://github.com/tamaratran/fast-jev-compaction/issues/26)

## More implementation-level sources: customization

Checked September 20, 2026. **All entries below are source-inspected projects,
not locally executed integrations.** Pinned READMEs/configs establish how the
authors expose customization; their demos and measurements remain author reports.
The [method cards](implementation-patterns.md) extract reusable designs.

<a id="p12"></a>

### P12 — Configurable situations and composite policies

Questions become Home Assistant entities or automation response variables. The inspected situation-layer example groups several questions over selected household state; the composite example keeps rubric dimensions, local weights and a dealbreaker separate. The transferable design is reusable semantic state and independently editable policy, not permission to control appliances. Its YAML, templates and SDK convenience fields are not the raw OpenRouter request schema.

[Pinned README](https://github.com/AboveColin/HA-Jev/blob/1f63190483d8718fa57d9750f39118b577325330/README.md) · [examples/04_situation_layer.yaml](https://github.com/AboveColin/HA-Jev/blob/1f63190483d8718fa57d9750f39118b577325330/examples/04_situation_layer.yaml) · [examples/06_composite_score.yaml](https://github.com/AboveColin/HA-Jev/blob/1f63190483d8718fa57d9750f39118b577325330/examples/06_composite_score.yaml)

<a id="p13"></a>

### P13 — User-editable multi-label email rules

The inspected YAML contains plain-language category descriptions, a default threshold, per-category overrides and lists of tag/move/flag/webhook actions. The README describes independent category questions and a dry-run preview. Adapt the separation between judgment and consumer; do not inherit its sample thresholds or automatically enable mailbox changes. A record may satisfy several rules, so action conflicts need a host policy.

[Pinned README](https://github.com/parth-kp/jev-mail-classifier/blob/942bbba6ecfe97ee9d1ae96aedfddc1467b40990/README.md) · [config.example.yaml](https://github.com/parth-kp/jev-mail-classifier/blob/942bbba6ecfe97ee9d1ae96aedfddc1467b40990/config.example.yaml)

<a id="p14"></a>

### P14 — Graph-local decisions with host search

The README and navigator code expose outgoing relationships as candidate choices and ask a goal-reached Noul alongside them. The host controls branching, traversal and display; a graph schema can change without inventing free-text edges. Demo fallback answers are labeled stand-ins when live calls fail. We did not connect to its graph or reproduce navigation. Log-probability path sums alone do not remove path-length bias.

[Pinned README](https://github.com/jexp/neo4jev/blob/d157bbe496eb91813475156942bef1c6badfb342/README.md) · [src/neo4jev/navigator.py](https://github.com/jexp/neo4jev/blob/d157bbe496eb91813475156942bef1c6badfb342/src/neo4jev/navigator.py)

<a id="p15"></a>

### P15 — Contextual suggestions over existing commands

The README describes ranking recent distinct history entries, literal-prefix and fuzzy replacement modes, a suitability signal and rejection of stale responses after buffer changes. The displayed demo uses fabricated history. Useful customization points are candidate scope, context and acceptance behavior. The project is an integration example, not authorization to upload private shell history or execute selected commands.

[Pinned README](https://github.com/mrnugget/jev-shell-history/blob/4b2b75d26c0ccf5726263904514a22a8e11659ea/README.md)

<a id="p16"></a>

### P16 — Semantic rules attached to ordinary schemas

The inspected README specifies structural validation first, then parallel Noul rules over value/context, with rule paths and separate rejected, uncertain and unavailable outcomes. Rules describe meaning, while Zod retains ordinary shape checks. This suggests configurable semantic validation, not replacement of exact validators. Test-count and live-test statements are the maintainer's reports; we did not run the package.

[Pinned README](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/README.md)

<a id="p17"></a>

### P17 — File-scoped semantic conventions

The README and example config show plugin instructions/messages plus global or per-plugin files/ignore patterns and thresholds. A custom plugin can ask whether executable code contains temporary debug logging while excluding intentional CLI output and examples. This is a useful pattern for explicit rule scope and exceptions. File-level flags are review leads, not guaranteed precise bug locations or proof that a patch is correct.

[Pinned README](https://github.com/huntedman/JevLint/blob/96b9d693c6e7e9355b802d87f12354a2cbf405f9/README.md) · [jevlint.config.example.json](https://github.com/huntedman/JevLint/blob/96b9d693c6e7e9355b802d87f12354a2cbf405f9/jevlint.config.example.json)

<a id="p18"></a>

### P18 — Streaming intent plus bounded targets

The README describes partial speech transcripts, fresh Playwright element IDs, pre-extracted text spans and a bundle of intent/target/completeness questions. Code chooses act/wait/ask/ignore and copies selected text. Customize commands, candidates and event handling; the model does not hear audio or invent typing arguments. The author reports tests and timing, not reproduced here. Its spoken-confirmation convenience is not a strong authorization boundary.

[Pinned README](https://github.com/moritzkremb/jev-voice-browser/blob/054db0f3dbf537af63a8117632d3f941ccd520e1/README.md)

<a id="p19"></a>

### P19 — Editable transcript-scoring presets

The README exposes JSON questions, context labels, inclusion in an aggregate gauge and flag thresholds. Each transcript unit is evaluated with surrounding conversation before rendering annotations. This transfers to presentation/interview review and navigation, not just the showcased political debate. The author explicitly separates the meter from factual verification and notes sentence-versus-turn problems. We did not reproduce its accuracy claims or render a video.

[Pinned README](https://github.com/ChetasLua/jevmeter/blob/cbf8e117b5b8835e3294c3a8ee652c7dfa737a9a/README.md)

<a id="p20"></a>

### P20 — Semantic predicates in a data workflow

The README shows configurable boolean/probability, Choice and Score expressions alongside ordinary SQL selection/grouping. It states that its CLI evaluates Jev expressions and sends ordinary SQL to vanilla Postgres; this is not the same implementation as a database extension. Reuse the predicate-plus-deterministic-query design, and inspect which row fields leave the database. No database was connected or query executed here.

[Pinned README](https://github.com/kylemclaren/jevql/blob/274532af852e8edfb7715ec6dca1113e589cb191/README.md)

<a id="p21"></a>

### P21 — An existing customization-oriented skill

The README and skill explain writing questions, structuring state, composing answers and diagnosing ambiguous judgments. This directly overlaps the idea of helping agents build customized Jev workflows; it is a useful reference and attribution, not evidence of a novel category invented here. We inspected its guidance, not its installation or runtime. Use the current OpenRouter contract rather than copying direct-provider SDK limits into this project.

[Pinned README](https://github.com/dbreunig/building-with-jev-skill/blob/04fe3666c6b8b8abfec1271c0e581c823a181f6d/README.md) · [skills/jev/SKILL.md](https://github.com/dbreunig/building-with-jev-skill/blob/04fe3666c6b8b8abfec1271c0e581c823a181f6d/skills/jev/SKILL.md)

## X/Twitter: compositional demos and customization leads

See the [X workflow ledger](twitter-workflows.md) for X01–X07: the whale-city
decision/video experiment, adaptive forms, OpenCode game control, semantic
spreadsheets, personal feed policies, a multi-agent deadlock report and creative
model routing. Each entry retains its original post URL and labels whether the
text was read through a mirror or only a directory excerpt. These are not direct
X retrievals, code inspections or local reproductions.

The [29-post intake](x-intake-2026-09-20.md) additionally preserves every item
supplied by the user, deduplicates experiment families, and follows selected
claims to pinned primary documentation. See its WebMCP task-versus-attempt
accounting, configurable compaction policies and mock-versus-live trading notes.

## What this means for comparisons

1. Compare the **same task and permitted actions**, not a free-form planner against a candidate list containing privileged answers.
2. Separate routing accuracy, detection accuracy and compression ratio from **independently verified task completion**.
3. Count false holds, unsafe releases, unnecessary escalations, repeat work, cache effects, all calls and failures—not only successful cheap decisions.
4. Measure provider-returned usage and wall time; do not generalize launch pricing or selected demo latencies.
5. Calibrate per task on held-out cases. Include unknown labels, ambiguous cases, stale state, misleading evidence and adversarial text.
6. In a report, distinguish this repository's test results from all external claims above.
