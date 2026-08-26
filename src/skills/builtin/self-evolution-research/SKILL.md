---
name: self-evolution-research
description: Roll a weighted research path — self-review of TUI polish, logging and observability, unused Strands SDK capability, anything else, or comparable coding-agent product research — then compare the findings with Darwin's current code and architecture, maintain a ranked iteration backlog, and drive the developer skill iteratively through every qualifying direction in the batch. Use for Darwin self-evolution, competitive research, or continuous product iteration.
---

# Self-evolution research

Run this workflow from the Darwin repository root. Keep research claims sourced, backlog state persistent, and implementation inside the existing `developer` supervision boundary.

One research run produces one **batch**: every direction that run adds to the backlog shares its origin report, and those records are that batch. The batch is then implemented **iteratively** — one direction at a time, each built on the Darwin revision the previous direction produced — and the loop continues until the batch is exhausted or a halt condition in section 7 fires. Finishing one direction successfully is not a reason to stop.

## 1. Inspect the backlog first

Before using any product-research source, read `docs/research/backlog_index.md`. It is the source-of-truth router for stable 20-priority pages under `docs/research/backlog/`. If the index or a routed page is missing, stop and report that this required product artifact is unavailable; do not silently invent a replacement elsewhere.

Treat only these values as valid statuses: `not-started`, `in-progress`, `done`, `abandoned`.

Do a metadata-only search across the routed pages for direction headings and exact `Status`, `Priority`, and `Origin report` lines. Do not read completed directions' evidence or notes into context. Identify the current batch as the unfinished records sharing the newest origin report, then select work within it in this order:

1. the highest-priority `in-progress` direction;
2. otherwise the highest-priority `not-started` direction;
3. otherwise begin fresh research.

A lower numeric **Priority** wins; use the earlier stable ID to break a tie. If either unfinished status exists, do **not** perform fresh product research. Read only the selected direction section and unfinished records sharing its origin report, then work that batch starting from the selected direction.

## 2. Apply the score gate before spending an iteration

`MINIMUM_IMPLEMENTATION_SCORE = 6`. Every dimension is rated 1–5, so a direction that is merely average on all of them scores exactly 6; the gate therefore drops anything below across-the-board average without touching any direction that has a real argument for it.

Apply the gate twice, with the same threshold:

- **when proposing** — a direction scoring below the gate is not added as `not-started`. Record it in the research report as considered and rejected, with its score.
- **when selecting** — a backlog record scoring below the gate is set to `abandoned` with the reason `below score gate (Score = <n> < 6)` and skipped. Continue the loop with the next direction; a gated record never halts the batch.

Two constraints keep the gate honest. Never restate a dimension rating to move a direction across the gate — if a rating was wrong, correct it in a research run and say that the correction is what changed. And a below-gate direction survives only when the run records an explicit safety, correctness, or dependency reason in its Notes; the reason, not the score, then justifies it.

## 3. Research only when the backlog has no unfinished work

### 3.1 Roll the research path first

Before reading a single source — repository or product — run the bundled script once from the skill directory shown in the `load_skill` result:

```bash
node <skill-directory>/scripts/roll-research-path.mjs
```

It draws one of five paths on the weights `tui=2 observability=0.5 sdk=1 open=1.5 peer=5` (so 20% TUI, 15% open, 10% SDK, 5% observability, and 50% peer research; the draw runs over half-units, so those shares are exact) and prints a `research-path`/`focus`/`share`/`draw`/`path-source`/`rolled-at`/`weights` block.

| Path | Share | What the run looks for |
|---|---:|---|
| `tui` | 20% | TUI interaction and visual polish: the live frame, streaming and history rendering, prompts and completion, colour and severity, small-terminal layout, keyboard editing. |
| `observability` | 5% | Logging and observability: notices and diagnostics, the trajectory record, usage and cost reporting, background-job and subagent visibility, what a failure leaves behind. |
| `sdk` | 10% | Strands SDK capability darwin has not adopted — hooks, plugins, interventions, conversation managers, model and tool features — measured against what darwin hand-rolls or lives without. |
| `open` | 15% | Anything else worth improving; deliberately unscoped. |
| `peer` | 50% | The sourced comparable-product analysis in 3.3. |

The roll is binding, and these rules are what make it worth running at all:

- **Once per research run, before any source.** Rolling after reading is choosing.
- **Copy the script's output verbatim** into the report's research-path section (see section 4). Never paraphrase it, and never write a path the script did not print.
- **Never re-roll an unappealing outcome.** If the script was somehow run more than once, record every output and use the first. A run that finds its path unproductive says so in the report and proposes nothing rather than quietly switching paths.
- **`--path <id>` is for a user who directs the path**, and only then. It prints `path-source: override (user-directed)`, which must survive into the report — a directed run may never be presented as chance. A run does not override on its own initiative.
- **The path decides where evidence comes from, not the standard it meets.** Sections 1, 2 and 4–8 apply unchanged: the same backlog contract, the same 1–5 ratings, the same score gate, the same report file, the same `developer` handoff.

### 3.2 Every path starts in the repository

Inspect current Darwin behavior and architecture in source, tests, README, `.trellis/spec/`, and recent relevant history. Cite repository paths and symbols for every claim; never characterize darwin from model memory when the file is right there.

On the four self-review paths, that repository evidence *is* the evidence — there is no peer requirement, and the report says so explicitly instead of padding its source table with products the run never opened. A self-review finding still has to be shown, not asserted: name the file, symbol, spec line or test that demonstrates the gap, and state what a user or operator experiences because of it. Where a path's own scope has a spec (`.trellis/spec/frontend/tui-testing.md` for `tui`, `backend/error-handling.md` for `observability`, `backend/strands-sdk-contracts.md` for `sdk`), read it first: a "missing" capability is often a recorded, deliberate decision, and re-proposing it as an improvement is the characteristic failure of these paths. If the scope turns out to be in good shape, that is a legitimate outcome — record it and propose nothing.

Consulting a peer product opportunistically on a self-review path is allowed, but it never replaces the repository evidence, and anything cited still obeys the sourcing rules in 3.3.

### 3.3 Peer-product research — the `peer` path

Research all of these scopes:

- Claude Code;
- Codex;
- DeepSeek harness;
- PenguinHarness; and
- at least one additional relevant coding-agent product.

Prefer primary product documentation, release notes, and source repositories. Record a URL, access date, source type, and the specific claim each source supports. Separate sourced fact from inference. If source access is unavailable or a named product cannot be verified, record the limitation and make no claim about it; never fabricate coverage to complete the list.

Capture notable product features and innovations, then compare each relevant item with Darwin's present functionality, SDK-extension architecture, permission model, sessions, skills, MCP, subagents, TUI, and verification approach as applicable.

## 4. Persist the research run safely

Use the current UTC date and target `docs/research/research_<YYYY-MM-DD>.md`. Follow `docs/research/research_template.md`.

- If the daily file does not exist, create it from the template structure.
- If it exists, read it first and append a new `## Run — <UTC timestamp>` section at the end.
- Never replace or rewrite an earlier same-day run.
- Record the section 3.1 roll before any finding, in its own `### Research path` block, as the script's verbatim output. A run whose report shows no roll is unauditable: nothing afterwards can prove the path was drawn rather than picked.
- On a self-review path, say in the source section that no peer product was consulted, and cite repository paths and symbols in place of URLs. Do not leave the peer table empty without saying why, and never list a product the run did not open.
- Give every claim and direction a source or repository-evidence link.

Propose zero to five new, non-duplicate iteration directions. Use the routed-page metadata search to collect existing IDs, priorities, and headings before adding one. Rank each direction on 1–5 scales:

- **Importance** — higher is more valuable;
- **Architecture fit** — higher fits Darwin's current design better;
- **Evidence confidence** — higher has stronger source support;
- **Implementation difficulty** — higher is harder;
- **Implementation risk** — higher is riskier.

Compute `Score = 2 × Importance + Architecture fit + Evidence confidence − Implementation difficulty − Implementation risk`. Rank by score, but include qualitative rationale and do not let the formula override a documented safety or dependency concern. Apply the section 2 gate: append every accepted direction as a complete `not-started` section to the current priority-range page, with a stable ID, priority, dimensions, source report, empty-or-explicit evidence, and notes; record gated directions only in the report. Order accepted directions so dependencies come first — that order is the batch's implementation sequence, not a suggestion.

The current page owns at most 20 priorities. If the next Priority falls outside its range, create the next zero-padded `directions-NNN-NNN.md` page for the next 20-priority range and add exactly one route to `backlog_index.md`; never rebalance a closed page or duplicate mutable direction state in the index.

## 5. Iterate the batch through developer

Call `load_skill` with the exact name `developer` once, then follow that workflow separately for each direction. Do not reproduce, bypass, or recursively delegate the developer protocol, and give every direction its own fresh child session — a child conversation is never reused across directions.

For each direction in the batch, in priority order:

1. **Check the starting point.** The working tree must be clean, HEAD must contain the previously accepted commit, and `pnpm typecheck` plus `pnpm test` must pass at HEAD. Halt per section 7 rather than delegating onto an unverified tree; a failure inherited from the previous iteration would otherwise be indistinguishable from one the next child caused.
2. **Delegate against the newest Darwin.** Each iteration must run the revision the previous iteration produced. Launching the child from repository source (`tsx src/cli.ts`, as `package.json`'s `start` script does) uses HEAD directly; if the child is launched from the built `bin` entry (`dist/src/cli.js`), run `pnpm build` first. Never hand iteration N+1 to a stale artifact.
3. **Mark the work.** Change exactly the one selected direction section in its routed page to `in-progress`; do not create an index status summary.
4. **Hand over** the direction's stable ID and requirement; the originating research report and reference sources; the Darwin architecture evidence and intended extension points; repository scope and Trellis requirements; independently observable acceptance checks; and authorization boundaries.
5. **Accept and close** it per section 6, then append that supervision run's batch record to `docs/iteration-log.md`.
6. **Report the iteration** to the user — direction, commit, independently re-run checks, token spend, and what remains in the batch — and then continue immediately with the next direction. Do not wait for another instruction to keep going.

Exactly one direction is `in-progress` at a time. Others stay `not-started` until their turn.

## 6. Close each direction honestly

After each developer child finishes, perform the developer workflow's independent acceptance before changing status:

- On acceptance, set the direction to `done` and record commit/change plus exact acceptance evidence.
- On failed or blocked acceptance, keep it `in-progress` and record blockers and the next recovery step.
- Set `abandoned` only for an explicit product decision or the section 2 gate, and record who/what decided it and the reason.

Never mark `done` from the child's report alone. Ensure the actual `/developer` supervision batch is appended to `docs/iteration-log.md` with the child session, accepted milestone, and Host-rerun checks before moving on to the next direction.

## 7. Halt the batch only for a recorded reason

Stop iterating and report when — and only when — one of these holds:

- **the batch is exhausted**: every record is `done` or `abandoned`. Normal completion.
- **acceptance keeps failing**: one direction fails independent acceptance twice, counting the developer workflow's focused correction as the second attempt. Leave it `in-progress` with blockers and do not start the next direction on an unaccepted tree.
- **a premise was falsified**: an accepted result invalidates a remaining direction's assumption. Record the invalidation in that section and require a fresh research run; never silently reinterpret a requirement into a different feature.
- **only the user can decide**: a remaining direction needs a product, safety, or authorization decision that neither the requirement nor repository evidence resolves. Ask instead of guessing.
- **the starting point cannot be restored**: the tree is dirty or HEAD is red, and fixing it would mean inventing scope.
- **continuing is not worth it**: every remaining record is below the gate, obsolete, or already covered by shipped work. Record each as `abandoned` with that reason.

Difficulty alone is not a halt condition, and neither is a successful iteration.

## 8. Report the batch

**Push before reporting.** Accepted commits exist only on the local branch until now — a batch that ends with commit but no push leaves the evolution invisible outside this machine. Once the loop halts (whatever the halt reason), if any commit was accepted this run, `git push` the current branch once and verify with `git log @{u}..` that nothing accepted remains unpushed. Never force-push and never rewrite history to make a push succeed; if the push is rejected, the remote is missing, or credentials fail, state that plainly in the report together with the exact unpushed commits, instead of retrying around it.

Report each direction attempted with its final status and commit, the push result (pushed, or why not, with any unpushed commits), the directions abandoned by the gate or by decision with their reasons, aggregate token spend across every child delegation, the halt condition that ended the loop, and the remaining backlog. When this invocation performed fresh research, also report the rolled path and whether it came from the roll or from a user override. Recommend fresh research only once the batch holds no unfinished record.
