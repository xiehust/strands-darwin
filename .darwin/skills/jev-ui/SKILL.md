---
name: jev-ui
description: Use when a browser or desktop task needs a bounded next-action choice from a fresh text or accessibility observation. Requires a host UI tool; does not install a controller or handle screenshots itself.
---

# Choose a grounded browser or desktop step

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

## Jev API prerequisite and first example

In Jev API mode, use the shared `jev-decide` CLI (Python 3.10+), installed from the reviewed
`jev-skill` package. If unavailable, explain the missing dependency rather than
silently installing software. The agent process must inherit
`OPENROUTER_API_KEY` or `TYPESAFE_API_KEY` for the chosen provider; never place the key in a prompt or request file.
No sibling skill or third-party integration is required for this judgment.
Actual UI, file, mailbox or simulation actions require the host's own tools.

Resolve `<skill-dir>` to this installed folder. Copy and edit
[assets/example.json](assets/example.json) for the user's task; it is synthetic
input, not a captured successful result. Validate it without a key or API call:

The commands below default to OpenRouter. For the official route, append
`--provider typesafe` to both validation and live calls.

```bash
jev-decide decide <skill-dir>/assets/example.json --dry-run
# After reviewing the input and authorization to send it to the chosen provider:
jev-decide decide /path/to/edited-request.json
```

Normal calls send the supplied evidence to the selected Jev provider and incur
usage. Read relevant answers, not only the exit code: `0` means selected/scored,
`2` means review, `1` means error. A confidently false Noul is still false;
selection is not permission. Unknown, missing or conflicting evidence needs a
fallback. Test thresholds on the user's task rather than assuming 0.9 is safe.

## Workflow

1. Use an available connector/browser/computer-use tool for observation. Follow its native instructions; Jev receives sufficient relevant text state, not hidden UI or fabricated element IDs.
2. Build candidates only from fresh observed controls and operations actually supported by the host. Prefer an exact known action without Jev when no judgment is needed.
3. Keep known typing values in the host. If text generation is needed, do it separately and validate it before choosing the target.
4. Interpret the selected action, recheck snapshot freshness, execute only a permitted step, and read the result. Do not treat a DONE choice as completion evidence.
5. Return to the host for sensitive actions, consent, stale state or unsupported controls. This skill does not grant browser, desktop or OS permissions.

## Context and parallelism

Jev does not inherit the agent's history. Give every request sufficient context:
the goal, permitted scope, fresh page/accessibility text, observed controls and
their IDs, relevant preceding actions and errors. A list of button IDs alone is
not enough. Remove unrelated page content and secrets without losing task evidence.

Batch independent page-state, candidate-suitability and completion-evidence checks
over the same snapshot instead of serial LLM calls. Use bounded concurrency only
for independent requests, with snapshot IDs, rate limits and a cost/time budget;
the host schedules calls and the CLI has no parallel scheduler. Questions cannot
read other answers in the same request. Do not precompute later clicks using old
state: execute a permitted step and observe its result before dependent decisions.
Jev's low latency helps the judgment stage, not authorization or browser execution.

## Make it yours

Replace the example's evidence, candidate IDs and criteria together. Preserve a
no-match route when the real task can fall outside the labels. Agree on how the
host or person consumes each answer before enabling any automatic effect.

## Precedent

[Related project or author example](https://github.com/browser-use/jev-ultrafast). Our workflow is an adaptation,
not that project's code, an automatic installer, or a reproduced benchmark.
[OpenRouter request contract](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).
