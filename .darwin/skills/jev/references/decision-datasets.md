# Decision and calibration datasets

Source check: **2026-09-20**. This is a dataset menu and test design, not a claim
that all these experiments ran. Only the [BBH pilot](https://github.com/wuyoscar/jev-skill/blob/main/evals/CALIBRATION_RESULTS.md)
has completed here. Static decision accuracy is not agent task success.

## Current pilot: 160 BBH decisions

The pilot uses **40 examples from each task below**. Use benchmark-supplied labels, retain
native options, and score against a hidden answer key. The [BBH authors' task
definitions](https://github.com/suzgunmirac/BIG-Bench-Hard/blob/9ee07bd481feebf959a6b59d61ea57bdcf30964d/bbh/README.md)
explain the intended judgments.

| Task / HF config | Available test rows | Native targets | What the judgment means |
|---|---:|---|---|
| `disambiguation_qa` | 250 | `(A)`, `(B)`, `(C)` | Identify a pronoun's antecedent; C is the supplied ambiguous interpretation. |
| `causal_judgement` | 187 | `Yes`, `No` | Match typical-person causal attribution, not an objective physical or moral verdict. |
| `logical_deduction_three_objects` | 250 | `(A)`, `(B)`, `(C)` | Select the ordering statement supported by the clues. |
| `snarks` | 178 | `(A)`, `(B)` | Select the sarcastic statement; cultural interpretation can be debatable. |

[HF mirror: lukaemon/bbh](https://huggingface.co/datasets/lukaemon/bbh) has
`input`/`target` fields and a `test` split per config. Pin revision
`982bb89fd79532a8ac676a61fc42eb1aeec63f99`; files follow
`CONFIG/test-00000-of-00001.parquet`, for example
[disambiguation Parquet](https://huggingface.co/datasets/lukaemon/bbh/resolve/982bb89fd79532a8ac676a61fc42eb1aeec63f99/disambiguation_qa/test-00000-of-00001.parquet).
No remote dataset code is needed. The authors also supply small JSON files under
`bbh/TASK.json`, for example [pinned disambiguation JSON](https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/9ee07bd481feebf959a6b59d61ea57bdcf30964d/bbh/disambiguation_qa.json).

The BBH repository declares MIT; the HF mirror does not declare a license in its
current card. Preserve original and upstream notices; see
[third-party attribution](https://github.com/wuyoscar/jev-skill/blob/main/evals/THIRD_PARTY.md). These older public
benchmarks may be contaminated and their labels are not infallible.

**Ambiguous answer ≠ uncertainty abstention.** Selecting C correctly says the
sentence is ambiguous. Declining to choose because the model is unsure is a
different event. Preserve both separately in the evaluation.

## Follow-up menu—not part of the current pilot

| Source | Native data / labels | Evidence and license caveat |
|---|---|---|
| [ComVE, author repository](https://github.com/wangcunxiang/SemEval2020-Task4-Commonsense-Validation-and-Explanation) | A: choose nonsensical `sent0`/`sent1`; labels `0`/`1`. B: choose one of three explanations. | Human commonsense benchmark; **CC BY-SA 4.0** in author README. A test has 1,000 rows; gold CSV is headerless. Join by `id`, not position. |
| [FalseQA, authors](https://github.com/thunlp/FalseQA) | `question,answer,label`; **1 = false premise**, 0 = true premise. Test: 1,374 rows, 687 per class. | Human-written questions, but reference prose and assumptions still need review. No explicit license found; do not bundle by assuming MIT. |
| [Meta AbstentionBench on HF](https://huggingface.co/datasets/facebook/AbstentionBench) | `question`, `reference_answers`, `should_abstain`, `metadata_json`; 20 source datasets. | **CC BY-NC 4.0**, plus upstream restrictions. Old loader needs `datasets <= 3.6.0` and remote code; inspect and fetch only the desired original source instead. |
| [LooksJuicy/ruozhiba](https://huggingface.co/datasets/LooksJuicy/ruozhiba) | 1,496 `instruction`/`output` rows, `default/train`. | **GPT-4 answers**, obvious refusals filtered out; Apache-2.0 declared. Not human classification gold or representative abstention prevalence. |
| [hfl/ruozhiba_gpt4](https://huggingface.co/datasets/hfl/ruozhiba_gpt4) | 2,449 questions, two answer versions: GPT-4-Turbo and GPT-4o. | Apache-2.0 declared; synthetic answers. Identical questions across versions are not independent samples. |
| [qywu/ruozhiba_en](https://huggingface.co/datasets/qywu/ruozhiba_en) | 238 `train_sft` rows; translated/culturally modified instructions and GPT-4-Turbo conversations. | Qualitative English counterpart, not a controlled translation benchmark; no license declaration found. |

Primary papers: [ComVE](https://aclanthology.org/2020.semeval-1.39/),
[FalseQA](https://aclanthology.org/2023.acl-long.309/),
[AbstentionBench](https://arxiv.org/abs/2506.09038).
The exact name **FlawedQA** was not verified; do not silently equate it with FalseQA.

Small, pinned follow-up files:

- [ComVE A test input](https://raw.githubusercontent.com/wangcunxiang/SemEval2020-Task4-Commonsense-Validation-and-Explanation/c55b1a9e6cb66997675f85073e17a9522cf38c2c/ALL%20data/Test%20Data/subtaskA_test_data.csv)
  and [gold](https://raw.githubusercontent.com/wangcunxiang/SemEval2020-Task4-Commonsense-Validation-and-Explanation/c55b1a9e6cb66997675f85073e17a9522cf38c2c/ALL%20data/Test%20Data/subtaskA_gold_answers.csv).
- [FalseQA test CSV](https://raw.githubusercontent.com/thunlp/FalseQA/9a9729974d8c5cfbfc6929e5b830111c0ed7c0c7/dataset/test.csv).
- [LooksJuicy Ruozhiba JSON](https://huggingface.co/datasets/LooksJuicy/ruozhiba/resolve/2a39d86721e0109a7c598a25a1338e297c639d2f/ruozhiba_qa.json).

## Ruozhiba: qualitative first, human labels only when ready

1. Freeze a small random sample and retain IDs. Keep GPT reference outputs out of
   both model inputs and annotators' initial view. Report the whole sample, not
   only amusing successes or failures.
2. Ask separate, explicit questions on these **overlapping axes** (for example,
   independent Noul questions, not one forced Choice among overlapping labels):
   - **Literal answerability:** can the literal question be answered from supplied
     context and the agreed background assumptions?
   - **False premise:** does it presuppose something contradicted by those facts?
   - **Wordplay:** does understanding it require a nonliteral reading or a pun?
   - **Clarification need:** is missing intent/context necessary to choose a
     useful response?
3. Initially inspect outputs qualitatively. For scored labels, two proficient
   Chinese annotators independently assess each axis, record rationale and
   uncertainty, then adjudicate disagreements. Preserve disputed cases instead
   of forcing automatic gold. Add ordinary valid-question controls when testing
   excessive clarification or abstention.
4. Publish as a **newly annotated pilot** with its rubric, not existing Ruozhiba
   benchmark accuracy. Synthetic-answer agreement is not correctness. Some
   source language is offensive; choose publication examples thoughtfully.

## Evaluation hygiene

- Pin files and record hashes, row IDs, sampling seed and exclusions. Keep
  related question variants together. Declare any class balancing.
- Freeze prompts before testing. Fit thresholds on separate development data,
  not the reported test rows; an internal split of BBH is not an official dev set.
- Report accuracy, Brier/log loss and risk–coverage with counts and uncertainty;
  tiny calibration bins cannot establish deployment guarantees. Separate tasks
  and question types rather than hiding them in one aggregate.
- Use the returned option probability for probability scoring; do not assume a
  separate confidence field is calibrated correctness probability. Count failed
  calls/invalid answers, keep gold out of requests, and compare identical options
  across models. Retain original-order results when testing option permutations.
