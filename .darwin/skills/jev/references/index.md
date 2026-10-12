# Decision recipe index

Two ways to use the same primitive: **a checkpoint inside an agent loop**, or
**a tool a person invokes on records and alternatives**. Most recipes can cross
between the two. Nothing here requires giving Jev execution privileges.

**Not a closed feature list.** For a new task, start with
[Customization](customization.md) and choose from the
[implementation patterns](implementation-patterns.md). The same mechanism can
serve many of the domains below; adapt the questions instead of searching for
an exact preset.

## Pick a slice

| Situation | Reference | Useful judgment |
|---|---|---|
| Select real access or an approved model simulation | [Setup](https://github.com/wuyoscar/jev-skill/blob/main/skills/jev-setup/SKILL.md) | Choose a provider without silently changing destination |
| Authorized batch, multi-turn or team safety evaluation | [Red-team workflows](https://github.com/wuyoscar/jev-skill/blob/main/skills/jev-redteam/references/workflows.md) | Preserve transcripts, budgets and independent outcomes |
| Recent app, alternative-model and creative-use roundups | [76-entry intake](intake-2026-09-21.md) | Read the original evidence and matched scenario |
| Rich context or a high-volume parallel workload | [Context and throughput](context-and-throughput.md) | Self-contained evidence, shared-state batching and bounded request concurrency |
| New domain, custom criteria, rubric or personal policy | [Customization](customization.md) | Define the evidence, answer space and downstream consumer |
| Choose between community projects, MCP tools and host integrations | [Ecosystem guide](ecosystem.md) | Match task, prerequisites and evidence status |
| Need a concrete connection pattern | [Implementation patterns](implementation-patterns.md) | Select spans, recover structure, traverse graphs, build features, validate or annotate |
| Creative loops, adaptive UI or X/Twitter examples | [X workflows](twitter-workflows.md) | Compose world design, bounded decisions and rendering; customize forms, rubrics and personal policies |
| Website tools, context-pressure policies, strategy/action split, conversation or TTS | [29-post X intake](x-intake-2026-09-20.md) | Follow original posts, documentation checks and transferable connection methods |
| Agent lost the goal or repeats a failed step | [Agent recipes](agent-recipes.md) | Continue, gather evidence, replan, recover, or pause |
| Too many tools, models, skills, or specialists | [Agent recipes](agent-recipes.md) | Select from real capabilities, with an escape hatch |
| Browser or interactive application | [Agent recipes](agent-recipes.md) | Classify observed page state or choose a permitted element |
| Tests, jobs, completion claims, evaluator gaming | [Agent recipes](agent-recipes.md) | Is the claimed outcome supported by receipts? |
| Memory, context, retrieval, evidence selection | [Agent recipes](agent-recipes.md) | Keep/drop, relevance, conflict, sufficiency |
| Support, inbox, CRM, logs, operations | [Human recipes](human-recipes.md) | Queue, severity, urgency, escalation |
| Papers, qualitative coding, datasets, review | [Human recipes](human-recipes.md) | Inclusion criteria, themes, ambiguity, rubric levels |
| Product ideas, design, content, games, simulation | [Human recipes](human-recipes.md) | Score descriptive dimensions or choose a next branch |
| Compliance, abuse, cheating, sensitive decisions | Both recipe files | Flag evidence for review, never issue an automatic verdict |
| Act, delegate, or defer based on uncertainty | [Calibration](calibration.md) | Validate probability/risk and review-load tradeoffs before picking thresholds |
| Stress-test decisions with labeled or tricky questions | [Decision datasets](decision-datasets.md) | Keep benchmark gold, generated answers, and qualitative annotation separate |

## Evidence legend

The recipe files distinguish **official examples**, **community-reported use**,
**maintainer evaluations**, and **proposed adaptations**. A Reddit anecdote is not
a reproduced benchmark; a GitHub README is not an execution receipt. Follow the
source IDs to [community evidence](community.md), including failures and limitations.

The README displays the full task-based collection, including these 56 recipes
and additional implementation/community uses. These reference files retain the
technical contracts and provenance without expanding the main skill prompt. Do not
load every recipe for a single decision. A good recipe names the observation,
the question, the output, the next consumer, and the failure condition.

## Boundaries shared by all recipes

- Jev supplies judgments, not facts it has never observed.
- Text-only input: host browser/OCR/vision tooling must produce usable text first.
- Use code for counts, dates, account ownership, budgets, permissions, and exact rules.
- Narrow questions and explicit fallback labels reduce forced decisions; they do
  not eliminate prompt injection, ambiguity, or distribution shift.
- Existing model/tool/skill routers may be sufficient. This project contributes a
  curated cross-domain skill and CLI, not a claim to have invented Jev integration.
