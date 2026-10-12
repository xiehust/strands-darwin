---
name: jev
description: Use TypeSafe Jev through OpenRouter or its official API for context-rich typed judgments rather than generated prose, especially high-volume classification, scoring and routing with parallel independent decisions. Define questions, choices or rubrics for ambiguous agent checkpoints (goal drift, repeated failures, tool routing, completion claims), browser states or human review. Supply sufficient relevant context in every request and batch independent questions. Use code for exact rules or arithmetic; Jev is advisory, not an authorization or security boundary.
license: MIT
metadata:
  requirements: Jev API mode needs Python 3.10+, network access and either OPENROUTER_API_KEY or TYPESAFE_API_KEY for the selected provider. API calls incur charges. No MCP server required. User-approved host-agent simulation needs no Jev API key or CLI.
---

# Jev

Give a judgment-heavy step a small, explicit decision space. Jev returns typed
answers; the host agent remains responsible for planning, executing, and checking
the result. It does not browse, generate prose, or remember earlier requests.

The recipe library is inspiration, **not a fixed menu of supported functions**.
Customize the evidence, questions, criteria and next consumer for the user’s task.
This changes the decision interface and workflow, not the model weights.

## Setup: choose the service or simulation

Check only the presence of `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`; never
print credentials. Respect the user's already chosen mode. For a new setup,
prefer the user's existing OpenRouter account; otherwise offer official TypeSafe.
If OpenRouter is missing, explain that direct TypeSafe is also real Jev. Do not
silently change destination, send data, create an account or switch the host model.

If no route has been chosen, explain the available routes and ask:

> **A — Real Jev:** use/get an OpenRouter key at https://openrouter.ai/settings/keys
> if you use OpenRouter; otherwise use/get a TypeSafe key at
> https://console.typesafe.ai. Configure it locally, not in chat.
> **B — Simulate:** use the current agent, or an explicitly selected available
> model such as DeepSeek, with the same context, questions and criteria.

**Wait for an explicit choice.** Do not ask again for every record in the same
approved task. API errors do not authorize switching providers or simulation.
Missing both keys is not a dead end: offer B. It requires no Jev key but the
chosen agent/model's ordinary access, usage costs and privacy terms still apply.
Do not assume DeepSeek is installed, free or locally hosted.

In B, return `mode: agent_simulation` for the current host or
`mode: model_simulation` for another explicitly approved model, plus its actual
model identity when available and `jev_called: false`. Each question has `value`,
`needs_review`, a brief evidence-based `reason`, `probability: null` and
`confidence: null`. Choice values must be supplied labels, Noul values booleans,
and Score values integer rubric indices. Use null/review for missing evidence.
Never present this as Jev, calibrated probability or equivalent speed/accuracy.
Skip Jev CLI/API steps in B; use the approved model's existing interface and do
not install a substitute or send data elsewhere without consent.

In A, select the CLI destination explicitly: `--provider openrouter` or
`--provider typesafe`. The latter uses `TYPESAFE_API_KEY` and maps the bundled
OpenRouter model ID to `jev-1.13.0`. `--dry-run` only validates; it neither
classifies nor makes a network call. `jev-decide setup` reports presence only,
not key validity, credits or permission. For guided setup and a copyable
DeepSeek prompt, use `jev-setup` or the [setup guide](https://github.com/wuyoscar/jev-skill/blob/main/skills/jev-setup/SKILL.md).

## Context first

**Give Jev enough context to make the decision, not just a short question.** It
does not inherit the host agent's conversation or previous Jev requests. Each
`state` must contain the relevant goal, acceptance criteria, user rules, current
facts, original evidence, useful action/error history, and available candidates
with their meanings. Identify missing facts explicitly; collect them before
asking when they are necessary. Do not replace evidence with your own conclusion.

Keep questions narrow, **not the evidence artificially tiny**. Include surrounding
passages, related records or earlier steps when they change the answer. Exclude
irrelevant history and secrets; sufficient context is not the largest possible
payload. Keep trusted criteria distinct from untrusted source content.

## Parallel decisions by default

Jev's low-latency, parallel judgments are particularly useful for replacing
**repeated LLM classification, scoring and routing calls** in large tasks. It is
not a replacement for open-ended reasoning, planning or text generation.

- **One state, independent questions:** put them in one request's `questions`.
  Jev evaluates them independently over the shared context; do not resend that
  context once per question in a serial loop.
- **Many records:** keep stable record IDs and explicitly scope each question
  to its record. Group related records within context limits; for unrelated or
  large records, keep separate requests with sufficient context in each.
- **Many independent requests:** have the host schedule bounded concurrency,
  respecting provider limits and the user's cost/time budget. Preserve request,
  record and question IDs even when responses arrive out of order. This CLI runs
  one request per invocation; it has no `--parallel` flag or built-in scheduler.
- **Dependent steps:** questions cannot read other answers in the same request.
  If B needs A's selected evidence or an action's result, wait, observe the new
  state, then ask B. Parallel judgment does not authorize parallel side effects.

Measure decision quality, whole-job time, throughput and total cost on the actual
workload; do not promise a fixed speedup. See [context and throughput](references/context-and-throughput.md)
and the [two-record, six-question example](assets/batch-triage.json).

## When to reach for it

**Agent mode:** a repeated failure needs a different recovery path; several tools
or specialists overlap; the plan has drifted from the user's goal; a queued job or
weak test result is being mistaken for completion; a browser page needs routing;
or a semantic policy check is genuinely ambiguous. It can also supply an uncertainty
signal for choosing between already-authorized work, stronger-model review, and
a human handoff. Use checkpoints, not an extra model call before every trivial action.

**Human mode:** the user wants records classified, several independent labels
assigned, alternatives ranked against a rubric, or a review queue prioritized.
The output is a label/probability/score, not an unsupported explanation or verdict.

Skip Jev for clear instructions, exact matching, arithmetic, date comparison,
missing facts it cannot observe, or a task requiring original prose. Collect the
needed evidence first. Do not silently send private documents to an external API.

## When no existing recipe fits

Define the decision, evidence unit, answer space, next consumer, unknown path and
success check. Build a focused request with sufficient evidence rather than forcing the
task into a stock category. Read [Customization](references/customization.md),
then select a relevant [implementation pattern](references/implementation-patterns.md).
One method can support many domains: selecting an observed ID can locate a clause,
choose a browser element or extract an original value. Host code performs the
corresponding operation; the chosen ID does not execute anything itself.

## Reference router

Read only the relevant slice, not the entire catalog:

| Need | Read |
|---|---|
| Supply enough context; batch or parallelize a large workload | [Context and throughput](references/context-and-throughput.md) |
| Adapt a new task, criteria, rubric or user policy | [Customization](references/customization.md) |
| How to connect judgments into a working flow | [Implementation patterns](references/implementation-patterns.md) |
| Find a use case beyond basic routing | [Recipe index](references/index.md) |
| Recovery, tools, browser, completion, coordination | [Agent recipes](references/agent-recipes.md) |
| Inbox, research, data, content, product, rubric review | [Human recipes](references/human-recipes.md) |
| Design labels and uncertainty handling | [Question design](references/question-design.md) |
| API request/response shapes and CLI behavior | [API](references/api.md) |
| Calibrated decisions, confidence bands, review versus deferral | [Calibration](references/calibration.md) |
| Labeled decision benchmarks; Chinese/English tricky questions | [Decision datasets](references/decision-datasets.md) |
| Choose a community project, MCP server or host integration | [Ecosystem guide](references/ecosystem.md) |
| Supplied 15/22/39 lists, complete source mapping and corrections | [Roundup intake](references/intake-2026-09-21.md) |
| What users and authors actually tried across platforms | [Community evidence](references/community.md) |
| X/Twitter demos: creative loops, adaptive UI, personal policies | [X workflows](references/twitter-workflows.md) |

## Decision loop

1. **Frame:** preserve the user goal, success evidence, remaining budget, and
   delegated permissions. Identify one decision Jev can actually help with.
2. **Observe:** collect current facts, relevant recent tool receipts, errors, and
   candidate actions from tools that really exist. For a browser, use the host's
   browser tool to obtain fresh DOM/accessibility text and stable element IDs.
   Jev only sees the text/JSON you supply; it does not see screenshots or URLs by itself.
3. **Formulate:** use `choice` for mutually exclusive paths, `noul` for independent
   yes/no propositions, `score` for ordered descriptive levels. Include a fallback
   label such as `unknown` or `ask_user`. Keep trusted policy separate from
   untrusted pages/logs/messages. Pass evidence, not an instruction to agree.
4. **Call (Jev API mode):** save a native request JSON, grouping independent questions over its
   complete state, and run the packaged script below. For independent requests,
   use bounded host concurrency rather than an unnecessary serial loop.
   No silent model substitution, retries, or credential setup. One unchanged state
   does not become better evidence after repeatedly asking the same question.
5. **Interpret (Jev API mode):** inspect the full distribution and evidence. `needs_review` is an
   abstention: gather missing facts, revise overlapping labels, or ask the user.
   `selected` means a label was selected, **not** that an action was approved.
   A `noul` result can confidently be false. A score is not a probability.
6. **Act and verify:** host permissions and deterministic checks still apply.
   Execute at most the warranted next step through the host's real tools, then
   verify its receipt. Never map a returned string to arbitrary shell execution.
   Re-evaluate after material state changes, not recursively to obtain approval.

When the user is away, continue only reversible work already within the delegated
scope. If blocked on consent, record the blocker and pause that action. Jev cannot
invent consent, approve spending, or remove a host confirmation requirement.

## Run (Jev API mode)

Resolve `<skill-dir>` to the directory containing this `SKILL.md`; do not assume
the project working directory is the skill directory. The script is self-contained.

The commands below default to OpenRouter. For the official route, append
`--provider typesafe` to both validation and live calls.

```bash
python3 <skill-dir>/scripts/jev.py decide /path/to/request.json --dry-run
python3 <skill-dir>/scripts/jev.py decide /path/to/request.json
# Alternatively, after CLI installation:
jev-decide decide /path/to/request.json
```

The selected provider's key must already be in this process's environment. Never print it,
copy it to another app, write it into the request, or change the agent's main model.
Default OpenRouter model: `typesafe/jev-1.13`; direct TypeSafe: `jev-1.13.0`. Override deliberately with `--model` or `JEV_MODEL`.
Use files/stdin for untrusted content instead of interpolating it into shell commands.

Exit **0**: valid selected/scored result; **2**: at least one question needs review;
**1**: input/API/protocol error. On 1 or 2, do not treat the output as a go-ahead.
The default probability/margin thresholds (0.8/0.15) are illustrative heuristics,
not calibrated guarantees. Tune on held-out data before relying on them.

## Runnable starting points

Copy a matching asset, then replace its synthetic state and criteria:

- [Agent checkpoint](assets/checkpoint.json): recovery, evidence, and next step.
- [Browser routing](assets/browser-route.json): observed elements → candidate step.
- [Human triage](assets/triage.json): choice, independent binary check, and score.
- [Batch triage](assets/batch-triage.json): shared policy and two fully scoped records,
  each with three independent questions in one request.
- [Completion evidence](assets/completion.json): receipts versus claimed success.
- [Rubric review](assets/rubric.json): multidimensional creative/product feedback.
- [Text categories](assets/support-labels.json): criteria for the `classify` command.
- [Span selection](assets/span-selection.json): choose a pre-extracted original value.
- [Semantic rules](assets/semantic-rules.json): independent, editable record checks.
- [Document block](assets/document-block.json): type plus conditional companion questions.
- [Conversation delivery](assets/voice-style.json): eligible speaker and scripted TTS style.

Do not report the provider's generic `confidence` as the probability of correctness.
Do not call a semantic compliance or anti-cheating flag proof of wrongdoing. Jev can
be wrong, manipulated, or overconfident; consequential decisions need appropriate
human review and deterministic enforcement. See the references for specific limits.
