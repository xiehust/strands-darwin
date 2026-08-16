---
name: self-evolution-research
description: Research comparable coding-agent products, compare sourced innovations with Darwin's current code and architecture, maintain a ranked iteration backlog, and drive the developer skill iteratively through every qualifying direction in the batch. Use for Darwin self-evolution, competitive research, or continuous product iteration.
---

# Self-evolution research

Run this workflow from the Darwin repository root. Keep research claims sourced, backlog state persistent, and implementation inside the existing `developer` supervision boundary.

One research run produces one **batch**: every direction that run adds to the backlog shares its origin report, and those rows are that batch. The batch is then implemented **iteratively** — one direction at a time, each built on the Darwin revision the previous direction produced — and the loop continues until the batch is exhausted or a halt condition in section 7 fires. Finishing one direction successfully is not a reason to stop.

## 1. Inspect the backlog first

Before using any product-research source, read `docs/research/backlog_index.md`. If it is missing, stop and report that this required product artifact is unavailable; do not silently invent a replacement elsewhere.

Treat only these values as valid statuses: `未开始`, `进行中`, `完成`, `放弃`.

Identify the current batch as the unfinished rows sharing the most recent origin report, then select work within it in this order:

1. the highest-priority `进行中` direction;
2. otherwise the highest-priority `未开始` direction;
3. otherwise begin fresh research.

A lower numeric **Priority** wins; use the earlier stable ID to break a tie. If either unfinished status exists, do **not** perform fresh product research. Work the existing batch instead, starting from that selected direction and continuing through the rest of it.

## 2. Apply the score gate before spending an iteration

`MINIMUM_IMPLEMENTATION_SCORE = 6`. Every dimension is rated 1–5, so a direction that is merely average on all of them scores exactly 6; the gate therefore drops anything below across-the-board average without touching any direction that has a real argument for it.

Apply the gate twice, with the same threshold:

- **when proposing** — a direction scoring below the gate is not added as `未开始`. Record it in the research report as considered and rejected, with its score.
- **when selecting** — a backlog row scoring below the gate is set to `放弃` with the reason `below score gate (Score = <n> < 6)` and skipped. Continue the loop with the next direction; a gated row never halts the batch.

Two constraints keep the gate honest. Never restate a dimension rating to move a direction across the gate — if a rating was wrong, correct it in a research run and say that the correction is what changed. And a below-gate direction survives only when the run records an explicit safety, correctness, or dependency reason in its Notes; the reason, not the score, then justifies it.

## 3. Research only when the backlog has no unfinished work

First inspect current Darwin behavior and architecture in source, tests, README, `.trellis/spec/`, and recent relevant history. Cite repository paths and symbols for every comparison; do not compare peers with assumptions or model memory.

Then research all of these scopes:

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
- Give every claim and direction a source or repository-evidence link.

Propose zero to five new, non-duplicate iteration directions. Check the backlog before adding one. Rank each direction on 1–5 scales:

- **Importance** — higher is more valuable;
- **Architecture fit** — higher fits Darwin's current design better;
- **Evidence confidence** — higher has stronger source support;
- **Implementation difficulty** — higher is harder;
- **Implementation risk** — higher is riskier.

Compute `Score = 2 × Importance + Architecture fit + Evidence confidence − Implementation difficulty − Implementation risk`. Rank by score, but include qualitative rationale and do not let the formula override a documented safety or dependency concern. Apply the section 2 gate: add every direction at or above it to the backlog as `未开始`, with a stable ID, priority, dimensions, source report, and notes, and record the gated ones in the report as rejected with their scores. Order the accepted directions so dependencies come first — that order is the batch's implementation sequence, not a suggestion.

## 5. Iterate the batch through developer

Call `load_skill` with the exact name `developer` once, then follow that workflow separately for each direction. Do not reproduce, bypass, or recursively delegate the developer protocol, and give every direction its own fresh child session — a child conversation is never reused across directions.

For each direction in the batch, in priority order:

1. **Check the starting point.** The working tree must be clean, HEAD must contain the previously accepted commit, and `pnpm typecheck` plus `pnpm test` must pass at HEAD. Halt per section 7 rather than delegating onto an unverified tree; a failure inherited from the previous iteration would otherwise be indistinguishable from one the next child caused.
2. **Delegate against the newest Darwin.** Each iteration must run the revision the previous iteration produced. Launching the child from repository source (`tsx src/cli.ts`, as `package.json`'s `start` script does) uses HEAD directly; if the child is launched from the built `bin` entry (`dist/src/cli.js`), run `pnpm build` first. Never hand iteration N+1 to a stale artifact.
3. **Mark the work.** Change exactly the one selected direction to `进行中`.
4. **Hand over** the direction's stable ID and requirement; the originating research report and reference sources; the Darwin architecture evidence and intended extension points; repository scope and Trellis requirements; independently observable acceptance checks; and authorization boundaries.
5. **Accept and close** it per section 6, then append that supervision run's batch record to `docs/iteration-log.md`.
6. **Report the iteration** to the user — direction, commit, independently re-run checks, token spend, and what remains in the batch — and then continue immediately with the next direction. Do not wait for another instruction to keep going.

Exactly one direction is `进行中` at a time. Others stay `未开始` until their turn.

## 6. Close each direction honestly

After each developer child finishes, perform the developer workflow's independent acceptance before changing status:

- On acceptance, set the direction to `完成` and record commit/change plus exact acceptance evidence.
- On failed or blocked acceptance, keep it `进行中` and record blockers and the next recovery step.
- Set `放弃` only for an explicit product decision or the section 2 gate, and record who/what decided it and the reason.

Never mark `完成` from the child's report alone. Ensure the actual `/developer` supervision batch is appended to `docs/iteration-log.md` with the child session, accepted milestone, and Host-rerun checks before moving on to the next direction.

## 7. Halt the batch only for a recorded reason

Stop iterating and report when — and only when — one of these holds:

- **the batch is exhausted**: every row is `完成` or `放弃`. Normal completion.
- **acceptance keeps failing**: one direction fails independent acceptance twice, counting the developer workflow's focused correction as the second attempt. Leave it `进行中` with blockers and do not start the next direction on an unaccepted tree.
- **a premise was falsified**: an accepted result invalidates a remaining direction's assumption. Record the invalidation on that row and require a fresh research run; never silently reinterpret a requirement into a different feature.
- **only the user can decide**: a remaining direction needs a product, safety, or authorization decision that neither the requirement nor repository evidence resolves. Ask instead of guessing.
- **the starting point cannot be restored**: the tree is dirty or HEAD is red, and fixing it would mean inventing scope.
- **continuing is not worth it**: every remaining row is below the gate, obsolete, or already covered by shipped work. Record each as `放弃` with that reason.

Difficulty alone is not a halt condition, and neither is a successful iteration.

## 8. Report the batch

Report each direction attempted with its final status and commit, the directions abandoned by the gate or by decision with their reasons, aggregate token spend across every child delegation, the halt condition that ended the loop, and the remaining backlog. Recommend fresh research only once the batch holds no unfinished row.
