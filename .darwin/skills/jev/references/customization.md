# Customize the decision, not just the category names

The recipes are examples, **not a closed list of supported use cases**. Start
from the user's task; invent a new question set when none of the examples fits.
Customization here means changing the request and its surrounding workflow,
not fine-tuning Jev's weights or performing RLCD training.

## Six things you can change

| Part | What to customize | What stays outside Jev |
|---|---|---|
| Evidence | One message, a diff, source spans, a page snapshot, a graph neighborhood, a time window, or several records | Collection, access permission, timestamps and provenance |
| Question | The exact judgment and the fields it concerns; one property or bounded choice at a time | Open-ended plans, prose and new factual evidence |
| Answer space | Candidate IDs, category definitions, independent tags, rubric anchors, explicit no-match outcomes | Exhaustive enumeration and mechanically invalid candidates |
| Invocation | On demand, at a task checkpoint, after a relevant state change, or as a batch over shared evidence | Scheduling, debounce, budgets, timeouts and cache invalidation |
| Consumer | Display a label, filter/rank rows, add an annotation, choose a graph edge, prepare a tool call, or request review | Arithmetic, rendering, authorization, execution and verification |
| Quality policy | What constitutes a correct decision, acceptable review load and different mistake costs | Held-out evaluation, auditing and versioning |

A recipe's values are not defaults for every deployment. A user can change the
meaning of “urgent”, the available tools, the rubric, or whether the result is
only displayed. Do not silently change their criteria to match a convenient demo.

## Turn a new request into a small decision contract

Before collecting a large context, write this compact description in the task's
working notes. It is a design aid, **not an extra JSON schema for the API**:

```text
Decision: what must the caller choose or assess?
Unit and evidence: which object, fields, IDs and observation version?
Questions: Choice, independent Nouls, or anchored Scores?
Consumer: what does each answer mean for the next step?
Unknown path: no candidate, missing evidence, ambiguity, or API failure?
Success check: how will we tell whether the decision and subsequent action worked?
```

For a one-off request, the agent can fill this from the user's instructions and
show the resulting labels or rubric. Ask only about missing distinctions that
would materially change the judgment or authority. For repeated work, preserve
the contract and question version so later results remain interpretable.

Then:

1. Select an [implementation pattern](implementation-patterns.md). The same
   pattern often works in both agent and human-facing workflows.
2. Write a native `{model, state, questions}` request with sufficient relevant
   context in every state; Jev does not inherit the host's history. Name field paths in the
   question; use structured criteria with short inclusions, exclusions or examples
   when adjacent labels are easy to confuse.
3. Batch independent questions sharing evidence, then validate with
   `decide request.json --dry-run` and make the authorized live call. For independent requests, prefer
   bounded host concurrency; see [context and throughput](context-and-throughput.md).
4. Interpret **each** returned value, not only the process exit code. A selected
   false Noul remains false; a low Score remains low. Apply the consumer's rules.
5. Record misses and revise the smallest relevant question, evidence slice or
   candidate generator. Keep a separate evaluation set when tuning repeated use.

The API only receives its documented fields. Host-side weights, schedules,
callback functions and permissions are not new top-level request fields.

## One mechanism, very different applications

| Mechanism | Agent version | Human-tool version | Main change |
|---|---|---|---|
| Pick an observed ID | Choose a useful DOM element or evidence file | Locate a receipt address or contract clause | Candidate collection and the role being requested |
| Ask independent properties | Missing verification? Repeated permanent failure? | Urgent? Contains a request? Needs specialist review? | Questions and how multiple positives are combined |
| Score several dimensions | Prioritize review effort across candidate changes | Compare proposals by the user's rubric | Anchors, weights and non-negotiable exclusions |
| Traverse a shortlist/tree | Select an installed skill, module or graph neighbor | Classify a product in a personal taxonomy | Catalog, navigation budget and stopping rule |
| Produce annotations | Mark retrieved evidence as conflicting or relevant | Mark transcript segments or document blocks | Evidence unit, surrounding context and renderer |
| Choose a next consumer | Continue, retrieve, delegate, verify, or hold | Show, queue, label, draft, or ask | Available capabilities and authorized effects |

These are adaptations, not claims that all variants have been benchmarked.
Use [agent recipes](agent-recipes.md) and [human recipes](human-recipes.md) for
more domain ideas, and [community sources](community.md) to inspect real projects.

## Keep judgment reusable when policy changes

Suppose the user wants to prioritize feature requests. Ask separately about
workflow impact, availability of a workaround and evidence of repeated demand.
The host can combine those saved results with different local weights. Changing
weights need not trigger another model call **if the evidence and meaning of the
questions are unchanged**. Changing what “impact” means does require new judgment.
A hard exclusion is a separate rule, not a small negative weight that other
scores can outvote. The [Home Assistant composite example](https://github.com/AboveColin/HA-Jev/blob/1f63190483d8718fa57d9750f39118b577325330/examples/06_composite_score.yaml)
demonstrates this separation; the existing [rubric asset](../assets/rubric.json)
is another starting shape.

Normalize a Score by its highest level index only when that scale makes sense
for the chosen aggregation. The resulting utility number is **not** a probability.
Learned combinations are also possible; see the feature-discovery pattern rather
than assuming hand-picked weights are universally better.

Policy can also depend on host-observed conditions: the cost of waiting changes
as a context window fills or a deadline approaches. Change the downstream gate,
not the recorded model probability. The [compact-adviser example](x-intake-2026-09-20.md)
shows configurable questions, weights and a context-usage schedule. Those
upstream features are not built into this CLI; evaluate a new policy separately.

## Customize scope and timing as well as wording

- A review rule can apply only to public API files, not generated code or fixtures.
- An inbox record can match several categories; independent Nouls avoid forcing
  it into a single queue. The host resolves conflicting move/tag actions.
- A live UI result belongs to the snapshot it judged. Ignore it if that snapshot
  has changed; an old high score is not a fresh observation.
- Several questions can share one state. But if question B needs data selected
  or produced by A, build B only after that data exists.
- Cache by evidence version, question/criteria version and model identity, not
  just the record ID. Do not reuse a judgment after the relevant facts changed.

These are workflow design choices, not additional capabilities installed by this
skill. Existing host tools perform collection and execution. Read
[question design](question-design.md) for precise wording and
[calibration](calibration.md) when deciding which cases need review.

## Copyable shapes

- [Span selection](../assets/span-selection.json): choose from pre-extracted values;
  the host copies the selected original span rather than asking for new text.
- [Semantic rules](../assets/semantic-rules.json): one question per editable rule;
  preserve separate flags rather than collapsing them into a vague pass/fail.
- [Conditional document questions](../assets/document-block.json): ask a block type
  and companions together; use a companion only when its branch applies.

The block example demonstrates a request shape, not an installed renderer. The
CLI conservatively summarizes every question: an uncertain unused companion can
still produce exit 2. Branch-aware consumption belongs in explicit host logic;
never interpret a global exit code as proof that every branch is applicable.

All are synthetic, schema-checked examples, not measured model outcomes. The
output is an advisory judgment; the user's authority and the host's verification
requirements do not change when a question or threshold changes.
