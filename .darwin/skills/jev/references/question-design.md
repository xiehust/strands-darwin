# Designing useful Jev decisions

Jev is a narrow judgment layer: **observed state → bounded questions → typed answers → application-controlled action**. It does not write plans, patches, explanations, arbitrary browser arguments, or replacement policies. Use a reasoning model for open-ended generation and code for exact computation. [System One](https://docs.typesafe.ai/concepts/system-one)

For task-specific contracts, read [Customization](customization.md). For ways to
connect questions into extraction, search, interaction or data workflows, read
[Implementation patterns](implementation-patterns.md). This page covers the
question itself, not a fixed catalog of supported uses.

## 1. Start from a decision, not an essay

Name the decision the caller can actually take: continue, inspect a failed check, retrieve missing evidence, choose a listed skill, retry a known recovery, delegate, or pause. Include a `none`, `insufficient_evidence`, or `delegate` option when the supplied choices may not fit.

| Need | Primitive | Example |
| --- | --- | --- |
| One route from a finite set | Choice | `inspect_failure`, `run_verification`, `delegate` |
| Independent properties that can coexist | Several Nouls | Goal drift? Missing evidence? Proposed check weakening? |
| A degree with meaningful ordered anchors | Score | No supporting observation → partial verification → complete verification |
| New plan, code, prose, or arbitrary text | Not Jev | Ask the host agent or another generative model. |
| Exact counts, money, timestamps, or equality | Not Jev | Use parsers and deterministic code. |

A Choice is relative: it finds the best supplied candidate. A Noul asks whether a proposition holds independently. Use both when choosing the best candidate is different from establishing that *any* candidate is acceptable. The official skill-selection cookbook uses this distinction to avoid forcing an unsuitable skill. [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)

## 2. Make the state evidence-bearing

For an agent checkpoint, provide:

- The user's actual goal and acceptance criteria.
- The current task stage and a short recent-action trace.
- Tool observations and failure results, not only the agent's interpretation.
- Proposed next actions, with their actual arguments or stable candidate IDs.
- Relevant constraints and policy, separated from untrusted source content.
- Which evidence is missing and which checks have not run.

Every request must be self-contained: Jev does not inherit the host's conversation
or earlier calls. Supply enough relevant context to resolve the question, not just
the last message, an opaque ID or your summary conclusion. Narrow questions do not
require tiny evidence. Do not paste the full conversation by default; irrelevant
context can lower accuracy. Question IDs are routing keys, not hidden instructions:
put the full judgment in `instructions`. [State](https://docs.typesafe.ai/concepts/state),
[Choice](https://docs.typesafe.ai/primitives/choice)

## 3. Ask atomic, literal questions

Avoid: **“Is the agent safe, compliant, finished, and ready to deploy?”**

Prefer independent questions:

- Does the proposed action modify a check instead of the implementation being checked?
- Is a required verification result absent from the observations?
- Does the proposed action address the currently observed failure?
- Does the proposed action exceed the user's stated scope?

Then combine the answers in code. Keep approval rules explicit rather than hiding multiple conditions inside “should proceed.” In particular, a high completion score does not replace a test run or establish that a browser submission succeeded. [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)

## 4. Write criteria that separate neighboring answers

Describe observable conditions, inclusions, and exclusions. For confusing labels, add compact examples or structured descriptions. Score levels must each stand alone: “worse than the previous level” is not a useful anchor. Avoid bare numeric levels such as `["0", "1", "2"]`; the number comes from array position, not semantic understanding of your scale. [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score)

A Noul should read naturally, with high probability meaning yes. Its optional `criteria` must align `true` with the positive condition and `false` with the negative condition. Do not reverse them to manufacture a different score. [Noul](https://docs.typesafe.ai/primitives/noul)

## 5. Separate confidence, suitability, and authorization

These answer different questions:

1. **Preference:** Which candidate has the highest Choice probability?
2. **Suitability:** Does a separate check establish that this candidate fits the task?
3. **Uncertainty:** How concentrated is the answer's distribution?
4. **Authorization:** Is the action permitted by the user and the host's policy?
5. **Success:** Did the action produce the required observable result?

Jev's confidence addresses only the third item. It cannot grant the fourth or prove the fifth. A Noul supplies no separate confidence. Thresholds are task-specific operating points, not universal safety guarantees. [Confidence](https://docs.typesafe.ai/confidence)

For an unattended task, uncertainty should trigger a bounded evidence-gathering step, delegation, or a saved checkpoint waiting for the user. It should not expand scope, lower tests, fabricate missing evidence, or treat absence of a human as approval. Always retain deterministic gates for dangerous operations. [Tool-gating cookbook](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev)

## 6. Fan out only independent judgments

Batch questions over shared evidence to avoid repeatedly sending the same state. Speculative follow-up questions can be asked in advance, but code must ignore answers whose preconditions do not hold. A second request is needed when its state depends on a first request's answer. More questions still consume tokens; batching is not free. [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)

For many independent records, preserve per-record context and scope every question
to an explicit record ID. The host can run separate requests with bounded concurrency;
this is different from native parallel questions inside one request. See
[context and throughput](context-and-throughput.md) for scheduling and measurement.

For browser routing, enumerate actual current controls or fully formed actions. Jev can select among them; the browser tool performs the action and reads the resulting page. If typing requires new prose, use a generative model. The official Wikiracing demonstration selects existing links; it is not evidence of unrestricted browser competence. [Launch demonstrations](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Function calling](https://docs.typesafe.ai/cookbooks/function_calling)

## 7. Understand Jev 1.13's known limits

The provider documents unreliable arithmetic, counting, date comparison, complicated indirection, long irrelevant context, and adversarial steering. Jev does **not** treat state as hostile by default. Clear criteria and a screening question are useful defenses, not a security boundary or guarantee against prompt injection.

Separate questions need not obey expected logical identities: `P(x)` need not equal `1-P(not x)`, and a yes/no Choice need not match the same proposition asked as a Noul. Do not transfer thresholds between primitives. Enforce invariants in code.

Bounded outputs prevent invented labels; they do not prevent a confidently wrong classification. “Cannot generate an arbitrary tool name” is not “cannot make a harmful decision.” [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

For anti-cheating checks, compare the original requirements, current diff, and independently preserved tests. Detecting a suspicious edit is an advisory signal; verify the actual artifacts and rerun untouched checks. For compliance, classify against an explicit supplied policy and route consequential or ambiguous findings to a qualified reviewer. Neither use establishes intent or legal compliance by itself. [Guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails)

## 8. Test before promoting a question to automation

Use positive, negative, ambiguous, missing-evidence, contradictory, and adversarial fixtures. Include unchanged behavior where Jev should not intervene. Record raw outputs, model resolution, cost, latency, and external outcome checks. Tune questions and thresholds on development fixtures; evaluate on held-out cases.

For before/after agents, keep task, initial state, tools, permissions, budgets, and success criteria identical. Measure task success, false interventions, unsafe continuations, abstentions, extra calls, latency, and total cost—not merely agreement with another model. Repeat runs and distinguish a checkpoint replay from a real end-to-end agent experiment. The provider's workflow evals use model-reference probabilities, so they are not a substitute for your application's ground truth. [Evaluation methodology](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

The OpenRouter cascade example reports a small dataset and model/judge noise, including a cheap-model baseline that also made no wrong answers in one run. Use it as a reproducible pattern, not a universal claim that adding Jev always improves quality or reduces spend. [Verified-cascade cookbook](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-verified-cascade)
