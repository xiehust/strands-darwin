# Three ways to use the evaluation skill

These are reproducible workflow designs, not reported attack success rates.
Scope must be authorized before target access, data export or paid calls.

<a id="batch"></a>
## Batch transcript review

**Input:** one JSONL record per completed case: `case_id`, `test_policy`, `context`
and ordered `messages`. Keep target ID/version, dataset ID and attempt ID in
context, with actual receipts. Hold expected labels in a separate evaluation file.

1. Agree on the target, permitted cases, data policy and budget. Keep a benign
   control set and a frozen held-out set. Deduplicate without deleting failures.
2. Run only approved cases with the user's existing harness. Save timeouts,
   refusals, tool outcomes and target errors; do not classify a missing response
   as a successful jailbreak or drop it from the denominator.
3. Build one Jev request per conversation. Ask independent outcome and evidence
   questions together; the host may schedule e.g. four requests in flight after
   approval. Rate limits and cost caps belong in the executor, not in the prompt.
4. Validate labels; route unknown, low-confidence and disagreements to review.
   Re-check a sample of accepted cases with an independent scorer/reviewer.
5. Join by stable ID, never response order. Compare against held-out labels and
   report all errors. Keep raw provider responses and model/version separately.

**Illustrative interface, not an observed answer:** a conversation where an
assistant prints the fixture's forbidden marker → `boundary_breached` → confirm
with an exact last-assistant-output check. This says nothing about harmful-output
benchmarks; a benign canary only tests that particular instruction boundary.

```text
Use jev-redteam to review my authorized transcript dataset at [PATH]. First show
three examples and propose outcome/evidence questions. Do not contact any target.
Prepare one request per conversation, keep labels outside the prompt, and show
full input plus output schema. Ask me to choose real Jev or explicit simulation.
Only after my approval, judge with at most 4 concurrent requests and a budget I
specify. Preserve errors/unknowns and send disputed cases to independent review.
```

<a id="multi-turn"></a>
## Multi-turn evaluation

Preserve separate session IDs, role labels, turn indices, attacker proposals,
target responses, system policy, tool results and reset boundaries. Never let
one case inherit another case's conversation. A last-turn-only score misses
cumulative context and a session reset changes the experiment.

For each approved session: observe → ask Jev about the **current complete state**
→ let the host choose among already approved `continue`, `stop`, `review` steps
→ invoke the next target turn only within scope → append the real receipt.
A missing turn or uncertain policy interpretation routes to review. Hard limits
on turns, cost, time and sensitive behavior are enforced by code even if Jev
recommends continuing. Terminal success needs independent outcome evidence.

```text
Use jev-redteam to design a multi-turn test in my local instruction-following
sandbox. Start with the bundled benign marker fixture. Set a maximum of 3 turns
per session and do not run targets yet. Show the session record, stopping rules,
independent outcome check, and where Jev would select continue/stop/review.
Never treat a target's claim that it succeeded as proof. Ask before live calls.
```

<a id="team"></a>
## Multiple researchers or agents

| Role | Writes | Must not do |
|---|---|---|
| Coordinator | Scope, IDs, budget ledger, immutable evaluation split | Let models expand authorization |
| Case designer(s) | Candidate test cases and provenance in separate namespaces | See held-out expected labels or mutate target logs |
| Target runner | Actual target receipts, version, timing and failure status | Execute unapproved tools or unlimited retries |
| Jev reviewer | Typed outcome, ambiguity and next-step suggestions | Generate attacks, grant permission or rewrite evidence |
| Independent auditor / person | Final labels and disagreement resolution | Use the same optimizing judge as sole ground truth |

Merge proposals by ID and deduplicate before spending. Parallelize independent
sessions, not dependent turns. Keep the roles separate even if one person handles
several. A second agreeing model is not ground truth; use objective checks where
possible and adjudicate uncertainty. Permission to read this skill does not
create permission to spawn agents or run a campaign.

```text
Design an authorized multi-agent red-team evaluation with jev-redteam: one
coordinator, two candidate designers, one target runner, Jev as a triage judge,
and an independent auditor. Use benign fixtures first. Give each case/session a
stable ID, define separate output files, a shared total budget and hard stopping
rules. Do not spawn agents or call targets yet. Show a no-Jev baseline using the
same target cases and budget, then ask me to approve the execution plan.
```
