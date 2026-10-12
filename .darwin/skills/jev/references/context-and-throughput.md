# Enough context, many independent decisions

Use Jev to replace repeated general-purpose LLM judgment calls when the answer
can be a choice, binary judgment or anchored score. Two design decisions matter:
provide sufficient evidence, and avoid unnecessary sequential calls.

## Make every request self-contained

Jev sees the supplied `state` and question, not the host's conversation, files,
browser or prior API calls. Include what a reviewer would need:

| Context | Examples |
|---|---|
| Objective | User goal, current subtask, acceptance criteria |
| Rules | User policy, label definitions, rubric anchors, permitted scope |
| Evidence | Source passages, current records, actual tool receipts and errors |
| History that changes the answer | Earlier message, failed recovery, unresolved dependency |
| Candidates | Real action/record IDs and descriptive meanings, including a fallback |
| Freshness and gaps | Observation version, source IDs, unavailable facts |

Put supporting material in structured state and the requested judgment in each
question's instructions/criteria. Keep related material together when comparison
is required. This follows the official [State guide](https://docs.typesafe.ai/concepts/state).

“Is this urgent?” plus “Still not working” is underspecified. Include what is not
working, who is affected, prior attempts, any workaround and the user's urgency
rubric. Likewise, give a code review the surrounding invariants, not just a changed
line. Rich context means **relevant evidence**, not an unfiltered transcript.
Keep source material distinct from trusted instructions; remove secrets and
unrelated detail. The model's [documented limits](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include difficulty with distracting context. Do not truncate away decisive evidence
just to make requests smaller; split the workload or retrieve missing material.

## Choose the parallel unit

| Workload | Preferred structure |
|---|---|
| One document, many independent checks | One state, multiple questions in one request |
| Related records sharing rules/context | A bounded group with explicit per-record questions |
| Many unrelated or large records | Separate self-contained requests, bounded host concurrency |
| Next question needs a selected passage or a tool result | Wait, collect the new evidence, then build the next request |

Native batching and request concurrency are different. In one request, every
question is evaluated independently against the same state. Shared context is
sent once rather than once per question. Questions cannot consume other answers
from that request. See the official [parallel-question cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions).

Adding unrelated records changes the state; it is not the same experiment as
adding questions over unchanged evidence. Check for cross-record contamination
and quality changes when tuning group size. For large jobs, the host should:

1. Choose a group size that preserves necessary context within current provider
   limits. Keep the common policy and each record's relevant history available.
2. Assign stable request, record and question IDs. Include the exact record path
   in each question's instructions; its ID alone is not an instruction.
3. Run independent requests with a bounded worker pool and a cost/time budget.
   Respect rate limits; do not spawn one unbounded process per item. The CLI handles
   one request per invocation and has no scheduler or automatic retries.
4. Collect results by ID, not arrival order. Preserve failed/uncertain items for
   review; do not silently drop them or rerun an entire successful batch.
5. Apply separate host rules before effects such as moving messages or tool calls.
   Concurrent judgments do not imply that their proposed actions are independent.

## Runnable example: two records, six independent questions

[batch-triage.json](../assets/batch-triage.json) supplies a shared support policy,
two records with relevant history and observations, and three questions per
record: category, need for account-specific review and urgency.

```bash
jev-decide decide <skill-dir>/assets/batch-triage.json --dry-run
# Only after reviewing the evidence and authorization for a paid call:
jev-decide decide <skill-dir>/assets/batch-triage.json
```

Resolve `<skill-dir>` to the installed general `jev` folder. Its bundled
`python3 <skill-dir>/scripts/jev.py` can replace `jev-decide` if no CLI is installed.
The example is synthetic input, not a benchmark or a recorded model output.
All six questions use supplied evidence; none refers to another question's answer.

## Check the whole-job benefit

Compare serial questions, same-state native batching and bounded concurrent
requests on the same workload. Separately compare against the LLM judgment step
being replaced, at an acceptable quality/review rate. Record whole-job wall time,
records/second, request p50/p95, total usage/cost, failures and decision accuracy.
Include evidence collection, retries, review and host execution where applicable.

The official cookbook's speed comparison sums sequential single-question call
times; it is not a comparison against concurrent calls or a universal speedup.
More context/questions still consume input tokens, and provider load/rate limits
affect throughput. Our existing API smoke timings are not a parallel-load benchmark.
