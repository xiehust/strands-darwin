# Implementation patterns: how people wire Jev into a workflow

Read this when the question is **how to build or adapt a use case**, not merely
which category it belongs to. Sources checked September 20, 2026: official
cookbooks, framework documentation, original project READMEs and selected configs.
These are source-inspected methods, not new reproductions of their benchmarks.
Some official notebooks use `jev-1.12` and cached responses; copy their design,
not their model/version, authentication, thresholds or performance claims.

Start with the [customization contract](customization.md). Each card names what
can change and who consumes the answer. Community source IDs link to pinned
implementations; neither those projects nor their dependencies are installed by
this skill. Our transport remains OpenRouter and `OPENROUTER_API_KEY`.

## 1. Select an original span instead of generating a value

**Pipeline:** parser/regex finds candidates → Choice selects a candidate ID or
`none` → code copies the exact original value and normalizes it.

**Change:** requested role, candidate extractor, descriptions and normalization.
An invoice total, receipt destination, phone number, quotation or observed UI text
can use the same shape. Include enough context to distinguish sender from recipient
or subtotal from total. Missing candidates cannot be recovered by classification.
Use [span-selection.json](../assets/span-selection.json).
[Official method](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)

## 2. Separate “best match” from “any suitable match exists”

**Pipeline:** Choice ranks supplied line/skill IDs; a separate Noul checks whether
the source or catalog contains an answer at all. The host returns no match or
retrieves more evidence rather than blindly taking the winner.

**Change:** question, candidate granularity, suitability criteria and fallback.
Useful for document search, skill selection and choosing existing templates.
A candidate's share of a Choice distribution is not an absolute relevance score.
[Line search](https://docs.typesafe.ai/cookbooks/semantic_find) ·
[Skill selection](https://docs.typesafe.ai/cookbooks/skill_suggestion)

## 3. Recover structure without rewriting the source

**Pipeline:** classify adjacent-line continuity → build blocks in code → classify
block type and relevant attributes → render original text with structural markup.

**Change:** block taxonomy, line-joining conditions, headings/list/callout rules and
renderer. This can support plain-text imports, OCR cleanup and document conversion.
The second pass depends on the first pass's new blocks; it is not one independent
batch. Preserve original text and inspect uncertain joins.
[Official two-pass example](https://docs.typesafe.ai/cookbooks/autoformat) ·
[Block-question asset](../assets/document-block.json)

## 4. Ask conditional questions together, consume only the active branch

**Pipeline:** one state → intent, target and companion questions in parallel →
code selects which answers matter. A lighting action is ignored when the request
is conversation; a heading-level answer is ignored for an ordinary paragraph.

**Change:** supported intents, real objects/actions, branch conditions and
unknown path. This reduces avoidable round trips when all evidence is already
available, but irrelevant answers are not instructions to perform extra actions.
[Official smart-home fan-out](https://docs.typesafe.ai/demos/smart-home)

## 5. Let semantics identify parts; let code compute

**Pipeline:** classify what a date expression says—absolute/relative, day, month,
weekday or offset—then resolve it using a fixed reference date and calendar code.

**Change:** extraction role, candidate ranges, locale, timezone and invalid-date
handling. The same split applies to currencies, units and amounts: semantic role
selection does not replace parsing, arithmetic or validation. A missing date is
not permission to invent one.
[Official date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)

## 6. Traverse a hierarchy or graph with bounded local choices

**Pipeline:** expose children/neighbors of the current node → Choice over those
IDs → host expands a small frontier and checks stopping conditions.

**Change:** taxonomy/graph, node descriptions, beam width, depth and visited-state
budget. Applicable to products, folders, code navigation and knowledge graphs.
The official example uses length-normalized path scores; treat these as search
heuristics, not a calibrated probability that the final path is correct. Prefer
exact target checks when available; prevent cycles in host code.
[Hierarchy cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification) ·
[Graph prototype P14](community.md#p14)

## 7. Measure dimensions once; change policy separately

**Pipeline:** several focused Scores/Nouls → saved feature vector → local weighted
ranking or explicit branch rules. A user can change weights without reclassifying
unchanged evidence under unchanged questions.

**Change:** dimensions, observable anchors, weighting and hard exclusions. Use for
proposal comparison, review queues or evidence organization. Keep ordered quality
and binary evidence presence separate. Local utility scores are not probabilities.
[Composite configuration P12](community.md#p12) ·
[Feature-extraction experience N02](community.md#n02)

## 8. Use Jev questions as learned-model features

**Pipeline:** a generative model proposes questions → Jev answers them for labeled
records → a conventional supervised model learns from those numeric features →
development errors guide proposed additions, revisions or removals.

**Change:** prediction target, proposer task, feature families, model and evaluation
split. This extends beyond routing into data science. The official wine-review
notebook uses CatBoost; it is an example of learning a downstream predictor, not
fine-tuning Jev or running RLCD. Keep test labels out of the question-discovery loop.
[Official autoresearch method](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)

## 9. Add semantic checks after structural validation

**Pipeline:** ordinary schema/parser rejects malformed input → one Noul per semantic
rule → host distinguishes satisfied, rejected, uncertain and unavailable.

**Change:** rule text, selected field paths, exceptions, scope and feedback message.
Applications include description/category consistency, a supplied writing rubric,
or code conventions that syntax alone cannot express. A semantic flag is a review
lead, not proof of misconduct. Keep deterministic validators for exact constraints.
[zod-jev P16](community.md#p16) · [JevLint P17](community.md#p17) ·
[Rule-bundle asset](../assets/semantic-rules.json)

## 10. Verify a generated candidate against independent evidence

**Pipeline:** inexpensive generator proposes structured data or a cited claim →
Jev compares the proposal with supplied source evidence → host accepts, retrieves
more, or requests bounded repair/review.

**Change:** fields checked, source window, failure taxonomy and escalation path.
For citations, preserve the claim, quote and surrounding source—not merely a URL.
Do not keep asking until a weak answer passes. A stronger reviewer must be measured
on the relevant errors, not assumed stronger by name.
[Structured extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) ·
[Citation checking](https://docs.typesafe.ai/cookbooks/citation_check)

## 11. Rank existing suggestions instead of inventing commands

**Pipeline:** local search/history produces candidates → Jev ranks them against
current context → UI displays a suggestion → the user or authorized host accepts.

**Change:** candidate window, contextual fields, ranking question and no-match rule.
The shell-history project illustrates contextual reuse; retrieval and command
palettes are other adaptations. Reject stale responses after the input changes.
Sanitize secrets before sending command history outside the machine. A selected
command is not automatically authorized to execute.
[Shell-history prototype P15](community.md#p15) · [Reranker P09](community.md#p09)

## 12. Turn observations into reusable semantic state

**Pipeline:** selected sensor/state observations → several named situation questions
→ timestamped values consumed by multiple deterministic automations.

**Change:** which observations matter, the meaning of situations, refresh triggers,
budget and expiry. A house's “cooking” situation and an agent's “verification
pending” are analogous designs, not identical validated models. Expose unknown or
stale states rather than silently reusing yesterday's answer.
[Home Assistant situation-layer configuration P12](community.md#p12)

## 13. Make a human-editable set of categories and consumers

**Pipeline:** a record → one Noul per independently applicable category → configured
labels, review queues or authorized effects. The email project exposes category
text, per-category thresholds and action lists in YAML.

**Change:** what each category means, conflicts between multiple matches, delivery
mode and scope. Preview labels before enabling write actions. Multiple matching
categories should not move the same record unpredictably; the host needs precedence
or a review path. This pattern also fits feedback, notes and issue intake.
[Mail-classifier configuration P13](community.md#p13)

## 14. Drive interaction from partial observations

**Pipeline:** speech transcription or other event stream → fresh UI snapshot and
candidate text spans → intent/target/completeness questions → host waits, shows
alternatives or performs a permitted action.

**Change:** supported commands, completion rule, candidate inventory, debounce,
stale-response rejection and confirmation policy. Jev judges text; speech
recognition and the browser are separate tools. The reviewed project copies selected
text spans instead of asking Jev to write input text. Model-based destructive-action
screening alone is not sufficient authorization.
[Voice-browser implementation P18](community.md#p18)

## 15. Annotate transcripts with a user-defined rubric

**Pipeline:** transcript units plus speaker/context → independent rubric questions
→ probabilities stored as annotations → a timeline, review list or rendered overlay.

**Change:** sentence versus turn granularity, surrounding context, questions and
aggregation. This can support interview coaching, presentation review or content
navigation. Jevmeter's presets are editable JSON; rhetorical labels are not fact
checks, and an isolated sentence may not answer a whole question. Preserve context
and uncertainty rather than presenting a subjective score as truth.
[Transcript-rubric prototype P19](community.md#p19)

## 16. Put semantic predicates next to normal data operations

**Pipeline:** deterministic database query narrows rows → selected row fields become
state → Jev supplies a predicate/category/score → ordinary code filters, groups or
ranks the results.

**Change:** row projection, question, allowed categories and execution budget.
The reviewed jevQL CLI evaluates semantic functions outside vanilla Postgres;
this skill does not install a database extension or SQL engine. Inspect projected
fields and external-data policy before sending rows to a provider. Retain row IDs
and judgments so a person can audit the selection.
[Semantic SQL prototype P20](community.md#p20)

## 17. Separate world design, action selection and presentation

**Pipeline:** a person/generative model authors a world → host supplies fresh
state and legal actions → Jev selects → simulator applies the action → renderer
presents the new state. Repeat with the updated state, not a fabricated outcome.

**Change:** rules, goals, character preferences, action space, human overrides and
rendering medium. This can be a game, branching story, teaching simulation or
agent-run visualization. A video renderer is an optional consumer, not a new Jev
capability. Keep state/round IDs; independent clips may render concurrently, but
dependent decisions require their actual predecessor state.

[Whale-city author report X01](twitter-workflows.md#x01) motivates this adaptation;
its reported throughput does not establish the exact scheduling or decision quality.
[OpenCode game handoff X03](twitter-workflows.md#x03) is a separate discovery lead;
[Catan X06](twitter-workflows.md#x06) reports why a loop also needs a no-progress exit.

## 18. Improve the action interface, or assist inside one primitive

**Pipeline:** inspect real website/tool capabilities → offer explicit task-level
actions → Jev selects → a generator or source-span selector supplies arguments
if needed → host validates, executes and checks the receipt.

**Change:** action granularity, argument source and placement. Rather than running
an entire agent, the caller can use Jev inside one `act`, `observe` or extraction
operation. An explicit website tool may replace several clicks, but only when
the website actually exposes it. Keep arbitrary text generation separate.

[WebMCP U08 and Stagehand U12/U23](x-intake-2026-09-20.md) motivate these designs.
WindTunnel's reported 49/49 tasks means majority success over repeated attempts,
not 147/147 successes; its two harnesses are not an isolated interface ablation.
Compare completed tasks as well as each primitive's label quality.

## 19. Adjust a policy to resource pressure without changing the judgment

**Pipeline:** eligible task checkpoint → classify completion/work shape → host
combines the answers → context usage or deadline determines the local gate →
show advice or invoke an already-authorized host operation.

**Change:** checkpoint definition, combination weight, pressure schedule,
cooldown and advisory versus automatic consumption. A high cost of waiting can
justify a different decision rule, not a fabricated higher probability.
Revalidate pending advice after a state or policy change; hints being timely does
not establish that compaction preserves information needed later.

[compact-adviser U13](x-intake-2026-09-20.md) supplies a concrete configurable
precedent. Deadline/stale-result handling from [U05/U15](x-intake-2026-09-20.md)
also transfers to games or schedulers without adopting live trading behavior.
Our CLI does not install compaction hooks or implement a scheduling policy.

## 20. Separate occasional strategy from frequent local actions

**Pipeline:** reasoning model/person selects a subgoal → Jev chooses among legal
actions under that subgoal → simulator/tool returns fresh state → host decides
whether to continue locally or request a new strategy.

**Change:** objective, strategy refresh triggers, progress measure, action budget
and which decisions require longer-horizon reasoning. Consider a game bot,
navigation exercise, workflow simulation or an agent following a bounded plan.
Replan on violated assumptions, no progress or a completed subgoal rather than
repeating a local action indefinitely. Keep the original goal available to the
planner; an obsolete subgoal should not quietly become the whole task.

The [Pac-Man U10 and action-game U26 posts](x-intake-2026-09-20.md) are author
demo descriptions, not independently measured evidence of strategic competence.
This pattern complements world design/rendering in pattern 17.

## 21. Select conversational roles and expressive presentation separately

**Pipeline:** conversation state plus bot roles → next-speaker/response-mode
choice → separate model writes the utterance → Jev classifies intended delivery
style → code maps the label to a supported TTS preset.

**Change:** participants, speaking permissions, turn-taking policy, style labels,
voice preset mapping and neutral fallback. Either half can be used alone: a host
can orchestrate multiple characters, or a person can apply a delivery rubric to
an existing script. Add turn limits and smooth rapidly changing style selections.
Utterance classification is not mind-reading; do not present a voice-style label
as a diagnosis or a fact about the speaker's internal state.

[U28](x-intake-2026-09-20.md) reports both uses; this compositional pipeline is
our adaptation, not inspected upstream code. Jev neither writes the dialogue nor
synthesizes audio, and this package does not install a TTS provider.

## 22. Compile a user's task into an editable question set

**Pipeline:** natural-language classification request → generative model drafts
typed questions and criteria → schema check and rubric review → Jev answers for
each scoped record → host consumes results according to the approved meanings.

**Change:** original task, answer definitions, sample records, review step and
consumer. Reuse the compiled questions while their semantics are unchanged;
recompile/version when the user changes the task. Give every batched record a
stable ID and explicitly name it in each question to avoid cross-row ambiguity.
A syntactically valid generated rubric can still misrepresent user intent.

[OpenRouter's prompt-to-questions example](https://openrouter.ai/labs/jev/compile)
demonstrates the two-model split. [Jev Explained U29](x-intake-2026-09-20.md)
offers a complementary teaching shape: editable state, questions, sample inputs
and a separate consumer. These inspire agent-authored requests, not a new
compiler command or mandatory second model in this CLI.

## Combining patterns without building a new framework

Start with one call if that solves the task. For a larger workflow, compose only
the needed parts, for example:

- **Agent research:** ordinary retrieval → relevance/contradiction checks → select
  source spans → generated synthesis → citation verification.
- **Human document intake:** recover blocks → select dates/addresses from evidence
  → classify several independent tags → show an editable review sheet.
- **Agent recovery:** deterministic error context → candidate recovery choice plus
  suitability check → one existing tool → check its actual result.

These are our adaptations of the patterns, not completed deployment claims.
Pydantic's [TypeSafe adapter documentation](https://pydantic.dev/docs/ai/models/typesafe/)
also demonstrates output-field questions and tool handoffs; its framework-specific
fallback and usage accounting must not be assumed to exist in our CLI.
[Building with Jev P21](community.md#p21) is an existing skill focused on writing
such programs. This project contributes a cross-domain method library and a small
OpenRouter entrypoint, not a claim to have invented customizable Jev workflows.
