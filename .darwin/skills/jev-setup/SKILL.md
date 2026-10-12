---
name: jev-setup
description: Set up Jev for an agent, choose OpenRouter or the official TypeSafe API, or guide an explicitly approved current-agent/DeepSeek simulation when no Jev key is available. Checks presence without exposing keys or making paid calls.
---

# Set up Jev

Use the user's current host and existing account where possible. Setup is not a
model call, account creation, provider switch or permission to spend.

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
not key validity, credits or permission. Continue below for the selected route, or use the
[copyable simulation prompt](references/simulation.md).

## Complete the selected route

| Route | Local environment | CLI option | Endpoint / model |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `--provider openrouter` | `https://openrouter.ai/api/alpha/decisions` / `typesafe/jev-1.13` |
| Official TypeSafe | `TYPESAFE_API_KEY` | `--provider typesafe` | `https://api.typesafe.ai/v1/systemone` / `jev-1.13.0` |
| Current agent / approved DeepSeek | Existing host or selected model access | No Jev CLI call | [Simulation prompt](references/simulation.md); never invent an API receipt |

If the user uses OpenRouter but has no key, point them to its key page. If they
do not use OpenRouter, offer the official console rather than requiring another
aggregator account. If neither route is possible or desired, offer simulation.
A missing key is never a reason to collect a secret in chat or browser history.
Let the user complete account/terms/payment steps; describe environment-variable
names and ask them to configure their host locally. Do not edit shell profiles.

Run `jev-decide setup` if already installed. Otherwise check environment presence
with the host tools; the skill does not require Python just to offer choices.
For A, ensure Python 3.10+ and the reviewed shared CLI are available, then:

```bash
jev-decide decide /path/to/request.json --provider typesafe --dry-run
# Only after approval for this input, destination and API usage:
jev-decide decide /path/to/request.json --provider typesafe > result.json
```

Replace `typesafe` with `openrouter` for that route. A dry run maps the known
bundled model ID for direct TypeSafe; use `--model` for a deliberate override.
Report which mode/provider was selected, which prerequisite is missing, what was
actually verified, and the next user action. Do not call an API merely to test a
key. A 401/402/403 is not permission to retry or silently switch services.

The agent does not inherit context into Jev calls. For later work, supply
sufficient context and batch independent questions in the same request; the
host schedules bounded concurrency, not dependent steps in parallel.

[TypeSafe contract](https://docs.typesafe.ai/api) · [TypeSafe models](https://docs.typesafe.ai/models) ·
[OpenRouter contract](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).
