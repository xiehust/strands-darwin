# Calibration and confidence-based routing

Primary sources checked 2026-09-20. Distinguish vendor claims, published evidence,
and the deployment policy you validate yourself.

## What RLCD means

TypeSafe describes **Reinforcement Learning for Calibrated Decisions (RLCD)** as
training for typed decisions and calibrated probabilities, rather than prose.
Calibration is a population property: events assigned probability 0.8 should occur
about 80% of the time, not a guarantee for one answer. **This skill calls Jev; it
does not perform RLCD training or establish that your workload is calibrated.**
The reviewed official primer, launch article, and evaluation pages do not provide
a complete RLCD reward/loss specification or comprehensive independently labeled
calibration study. Treat calibrated-output claims as vendor claims pending your
own validation. [Primer](https://docs.typesafe.ai/introduction/machine-learning-primer),
[launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

## Name the signal before choosing thresholds

| Signal | Meaning and correct use |
|---|---|
| Choice `probabilities[label]` | Probability assigned to that supplied label. Evaluate against the matching ground-truth label. |
| Choice/Score `confidence` | Derived distribution-concentration statistic; **not automatically probability of correctness**. Evaluate as a routing/ranking signal. |
| Noul `noul` | Probability of yes; no separate confidence field. `0.02` is strong no, not automatically uncertainty. |
| Score `score` | Expected zero-based rubric index. A confidently low score remains a negative assessment, not permission to act. |

Keep the primitive, metric name, question, domain, model version, and candidate
count `K` in evaluation records. Do not transfer thresholds silently across them.
[Confidence](https://docs.typesafe.ai/confidence),
[Noul](https://docs.typesafe.ai/primitives/noul),
[Score](https://docs.typesafe.ai/primitives/score)

### Formula provenance and a documentation discrepancy

The official **LLM comparison adapter**, at commit
`adffc2eab300a4fa3c0e92252d4ffd6ceaa53700`, normalizes probabilities `p` and computes,
for `K > 1`:

```text
choice_confidence = (max(p) - 1/K) / (1 - 1/K)
score_confidence = max(0, 1 - sum_i p[i] * abs(i - mode_index) / D_K)
mode_index = argmax_i p[i]
D_K = mean_i abs(i - (K-1)/2), for i = 0,...,K-1
```

This adapter creates TypeSafe-shaped answers for **other LLMs**; it is not evidence
of the production Jev server implementation or a permanent API guarantee. Preserve
the returned field rather than replacing it with this formula.
[Pinned implementation](https://github.com/typesafe-ai/system-one-adapter-python/blob/adffc2eab300a4fa3c0e92252d4ffd6ceaa53700/src/system_one_adapter/_utils/confidence_metrics.py),
[adapter conversion](https://github.com/typesafe-ai/system-one-adapter-python/blob/adffc2eab300a4fa3c0e92252d4ffd6ceaa53700/src/system_one_adapter/_client.py#L118-L164)

Under this Choice formula, binary `p_max=0.9` gives `confidence=0.8`;
`confidence=0.9` corresponds to `p_max=0.95` for two labels but `0.925` for four.
It depends only on `p_max` and `K`. The official classification cookbook's claim
that confidence distinguishes equal winning probabilities with different
runner-up distributions conflicts with this adapter formula. The production
formula is therefore not settled by these sources.
[Cookbook](https://docs.typesafe.ai/cookbooks/classification_using_confidence)

## Illustrative three-way policy, not a CLI feature

The following uses **API `confidence`**, with explicit boundary handling. It is a
starting policy to test, not a claim of 90%/70% correctness. The CLI's
`--min-probability` and `--min-margin` use different signals; the CLI does **not**
implement this confidence cascade or automatically call a stronger model.

**First enforce permissions and deterministic prerequisites.** Forbidden actions,
missing authorization, invalid responses, abstention labels, or unresolved
contradictions require a stop/review regardless of confidence.

| Eligible Choice/Score result | Consumer policy |
|---|---|
| `confidence >= 0.90` | Let the selected meaning guide already-authorized, low-risk work; retain required confirmation for consequential actions. |
| `0.70 <= confidence < 0.90` | Obtain bounded stronger-model review or additional evidence, within authorization and budget. |
| `confidence < 0.70` | Seek human review. If the user is away, checkpoint and pause the affected action. |

High-confidence `deny` still means deny. Score level and confidence need separate
conditions. For Noul, define a separate yes/no/uncertain policy on `noul`; do not
invent a confidence field. Stronger-model disagreement is not automatic approval.
Official examples use different cutoffs and retain confirmation for consequential
actions, reinforcing that thresholds are task-specific.
[Confidence guidance](https://docs.typesafe.ai/confidence),
[routing example](https://docs.typesafe.ai/patterns/confidence-routing)

## Validate on your deployment domain

1. **Freeze the task and labels.** Use independently labeled gold decisions;
   model consensus is not ground truth. Split development and held-out evaluation
   by independent task/family, not repeated checkpoints from the same episode.
   Tune thresholds on development data only. Label the predicted proposition:
   eventual task failure does not necessarily make an earlier routing label wrong.
2. **Measure probability quality.** Report NLL (`mean(-log(p_true))`) and Brier
   score (binary `mean((p-y)^2)`; multiclass `mean(sum_k (p_k-y_k)^2)`). Disclose
   scaling and any probability clipping. These assess overall probabilistic
   quality, not calibration alone. Use actual label/event probabilities, not
   concentration-confidence as if it were correctness probability.
   [Brier definition](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.brier_score_loss.html),
   [calibration caveat](https://scikit-learn.org/stable/modules/calibration.html)
3. **Inspect reliability.** Show reliability bins with counts, observed accuracy,
   and mean predicted probability; report ECE with the exact binning. Small samples
   and bin choices can obscure errors. If separately mapping confidence to
   correctness probability, fit that mapping without using held-out test labels.
   [Guo et al., calibration and NLL](https://proceedings.mlr.press/v70/guo17a.html)
4. **Measure routing tradeoffs.** Report coverage (`accepted / all`), selective
   risk (`wrong accepted / accepted`), unsafe-release rate, each band's count,
   review/hold rates, total cost, and latency. Zero acceptance gives undefined
   selective risk, not zero risk. Plot risk versus coverage and report 95% Wilson
   intervals for binomial proportions where independent-sample assumptions fit;
   correlated repeat runs are not extra independent evidence.
   [SelectiveNet](https://proceedings.mlr.press/v97/geifman19a.html),
   [NIST Wilson intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
5. **Monitor risk and shift.** Audit new labeled samples after changes in domain,
   language, model, prompt, or candidate set. Track accepted errors and drift;
   increase review/hold rates until revalidated when risk changes. Score histograms
   alone cannot establish continued calibration.
   [Ovadia et al., uncertainty under shift](https://proceedings.neurips.cc/paper/2019/hash/8558cb408c1d76621371888657d2eb1d-Abstract.html)

Calibration is not prompt-injection resistance, authorization, or execution proof.
Jev documents adversarial steering and other limitations; preserve deterministic
controls and independent outcome checks.
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Interpret published and local evidence narrowly

The vendor's 60-filing example selected 30 cases at confidence at least 0.9 and
got 27 group labels correct. That is a useful selective-prediction example, not a
general calibration certificate. Vendor workflow evaluations use model-consensus
references, not independently labeled outcomes.
[Vendor example](https://docs.typesafe.ai/cookbooks/classification_using_confidence),
[evaluation methodology](https://evals.typesafe.ai/)

See [decision datasets](decision-datasets.md) and the
[calibration protocol/results](https://github.com/wuyoscar/jev-skill/blob/main/evals/CALIBRATION.md) for local evidence.
The [160-item BBH pilot results](https://github.com/wuyoscar/jev-skill/blob/main/evals/CALIBRATION_RESULTS.md)
(four tasks × 40 items) include a label-only DeepSeek comparison. Jev matched
136/160 labels; confidence >=0.9 selected 100 with eight errors. High-confidence
causal judgment alone matched only 14/20. These results characterize that sample,
not production agent safety or RLCD training.
Label-only DeepSeek outputs do not support direct Brier/NLL/ECE comparisons of
its probabilities. Repeated agreement is consistency, not calibration.
