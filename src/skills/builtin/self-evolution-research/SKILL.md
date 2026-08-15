---
name: self-evolution-research
description: Research comparable coding-agent products, compare sourced innovations with Darwin's current code and architecture, maintain a ranked iteration backlog, and use the developer skill to implement one direction. Use for Darwin self-evolution, competitive research, or choosing the next product iteration.
---

# Self-evolution research

Run this workflow from the Darwin repository root. Keep research claims sourced, backlog state persistent, and implementation inside the existing `developer` supervision boundary.

## 1. Inspect the backlog first

Before using any product-research source, read `docs/research/backlog_index.md`. If it is missing, stop and report that this required product artifact is unavailable; do not silently invent a replacement elsewhere.

Treat only these values as valid statuses: `未开始`, `进行中`, `完成`, `放弃`.

Select work in this order:

1. the highest-priority `进行中` direction;
2. otherwise the highest-priority `未开始` direction;
3. otherwise begin fresh research.

A lower numeric **Priority** wins; use the earlier stable ID to break a tie. If either unfinished status exists, do **not** perform fresh product research. Resume or start exactly one existing direction instead.

## 2. Research only when the backlog has no unfinished work

First inspect current Darwin behavior and architecture in source, tests, README, `.trellis/spec/`, and recent relevant history. Cite repository paths and symbols for every comparison; do not compare peers with assumptions or model memory.

Then research all of these scopes:

- Claude Code;
- Codex;
- DeepSeek harness;
- PenguinHarness; and
- at least one additional relevant coding-agent product.

Prefer primary product documentation, release notes, and source repositories. Record a URL, access date, source type, and the specific claim each source supports. Separate sourced fact from inference. If source access is unavailable or a named product cannot be verified, record the limitation and make no claim about it; never fabricate coverage to complete the list.

Capture notable product features and innovations, then compare each relevant item with Darwin's present functionality, SDK-extension architecture, permission model, sessions, skills, MCP, subagents, TUI, and verification approach as applicable.

## 3. Persist the research run safely

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

Compute `Score = 2 × Importance + Architecture fit + Evidence confidence − Implementation difficulty − Implementation risk`. Rank by score, but include qualitative rationale and do not let the formula override a documented safety or dependency concern. Add each accepted direction to the backlog as `未开始`, with a stable ID, priority, dimensions, source report, and notes. Recommend at most one direction to start.

## 4. Implement exactly one direction through developer

Choose the selected existing or newly recommended direction and change only its status to `进行中`. Then call `load_skill` with the exact name `developer` and follow that workflow. Do not reproduce, bypass, or recursively delegate the developer protocol.

Give the developer workflow:

- the direction's stable ID and requirement;
- the originating research report and reference sources;
- the Darwin architecture evidence and intended extension points;
- repository scope and Trellis requirements;
- independently observable acceptance checks; and
- authorization boundaries.

Implement exactly one selected backlog direction per invocation. Other new directions remain `未开始`.

## 5. Close the backlog state honestly

After the developer child finishes, perform the developer workflow's independent acceptance before changing status:

- On acceptance, set the direction to `完成` and record commit/change plus exact acceptance evidence.
- On failed or blocked acceptance, keep it `进行中` and record blockers and the next recovery step.
- Set `放弃` only after an explicit product decision, and record who/what decided it and the reason.

Never mark `完成` from the child's report alone. Ensure the actual `/developer` supervision batch is appended to `docs/iteration-log.md` with the child session, accepted milestone, and Host-rerun checks before reporting overall completion.
