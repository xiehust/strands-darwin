# Darwin self-evolution research — YYYY-MM-DD

Copy this structure to `research_<YYYY-MM-DD>.md`, using the UTC date. A daily file is append-only: before a same-day run, read the existing file and append another timestamped `## Run` section at the end. Never overwrite an earlier run.

## Run — YYYY-MM-DDTHH:MM:SSZ

### Backlog-first decision

- Backlog inspected first: `docs/research/backlog_index.md`
- Unfinished directions found: none | IDs
- Decision: fresh research | resume/start `<ID>` without fresh research

> If any `in-progress` or `not-started` row exists, stop product research and use the existing backlog path. A research section below is valid only when no unfinished row existed at invocation start.

### Research path

Paste the verbatim output of `scripts/roll-research-path.mjs` (bundled with the skill), rolled once before any source was read. Keep `path-source` exactly as printed: `roll` or `override (user-directed)`.

```text
research-path: <tui|observability|sdk|open|peer>
focus: <as printed>
share: <as printed>
draw: <as printed>
path-source: <roll | override (user-directed)>
rolled-at: <as printed>
weights: <as printed>
```

The path decides where evidence comes from. On `peer`, fill the reference-source table below from primary product sources. On `tui`, `observability`, `sdk` or `open`, the evidence is this repository: cite paths and symbols, and state plainly that no peer product was consulted rather than leaving the table blank or padding it.

### Source availability and method

State which source tools were available, the UTC access date, and any products that could not be verified. Do not fill an unavailable scope from memory or inference.

### Reference sources

| Ref | Product | Source type | URL | Accessed (UTC) | Claims supported |
|---|---|---|---|---|---|
| S1 | Claude Code | Primary docs / release notes / repository | `<url>` | YYYY-MM-DD | `<specific claims>` |
| S2 | Codex | Primary docs / release notes / repository | `<url>` | YYYY-MM-DD | `<specific claims>` |
| S3 | DeepSeek harness | Primary docs / release notes / repository | `<url or unavailable>` | YYYY-MM-DD | `<specific claims or no claim>` |
| S4 | PenguinHarness | Primary docs / release notes / repository | `<url or unavailable>` | YYYY-MM-DD | `<specific claims or no claim>` |
| S5 | `<additional product>` | Primary docs / release notes / repository | `<url>` | YYYY-MM-DD | `<specific claims>` |

### Peer highlights and innovations

| Product | Sourced feature / innovation | Reference | Why it matters |
|---|---|---|---|
| `<product>` | `<fact; distinguish inference explicitly>` | S1 | `<value>` |

### Current Darwin baseline

| Capability / architecture | Repository evidence | Current behavior |
|---|---|---|
| `<area>` | `src/...` / `spike/...` / `.trellis/spec/...` | `<observed behavior>` |

### Comparison and gaps

| Peer evidence | Darwin evidence | Parity / gap / deliberate difference | Implication |
|---|---|---|---|
| `<feature + source ref>` | `<repository path/symbol>` | `<assessment>` | `<possible response>` |

### Ranked iteration directions

Propose at most five new directions, excluding duplicates already in the backlog. Rate each dimension 1–5. Higher difficulty and risk reduce the score.

`Score = 2 × Importance + Architecture fit + Evidence confidence − Implementation difficulty − Implementation risk`

Only directions scoring at or above `MINIMUM_IMPLEMENTATION_SCORE = 6` enter the backlog as `not-started`; they form this run's batch, ordered so dependencies come first.

| Rank | Proposed ID | Direction | Importance | Architecture fit | Evidence confidence | Implementation difficulty | Implementation risk | Score | Evidence and rationale |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | SER-NNN | `<direction>` | 1–5 | 1–5 | 1–5 | 1–5 | 1–5 | `<score>` | `<source refs, Darwin refs, dependencies and qualitative rationale>` |

### Gated-out directions

Directions considered but not queued because they fell below the score gate. Record them rather than dropping them silently; a later run may re-rate one with new evidence.

| Direction | Score | Gate | Why it fell below | Kept anyway? |
|---|---:|---:|---|---|
| `<direction>` | `<score>` | 6 | `<which dimensions sank it>` | `no` \| `yes — <explicit safety/correctness/dependency reason>` |

### Recommendation

- Batch to implement: `<ordered IDs>`
- Start with: `<one ID, or none>`
- Why this order: `<dependencies, safety, qualitative rationale; note any score override>`
- Independently observable acceptance: `<checks for the developer workflow, per direction>`
- Backlog updates: `<IDs added as not-started; IDs set abandoned by the gate; the first ID changed to in-progress only immediately before developer handoff>`

### Batch iteration outcome

One row per direction handed to the loaded `developer` skill. The batch is worked one direction at a time, each on the Darwin revision the previous one produced; append a row as each direction closes rather than waiting for the whole batch.

| Direction | Child session and managed tasks | Host acceptance (exact independent checks and outcomes) | Commit | Final status | Iteration-log entry |
|---|---|---|---|---|---|
| `<ID>` | `<evidence>` | `<checks and results>` | `<sha>` | `done` only after acceptance; otherwise `in-progress` with blockers; `abandoned` only with explicit reason | `<docs/iteration-log.md heading/link>` |

- Halt condition that ended the loop: `<batch exhausted | acceptance failed twice | premise falsified | user decision needed | starting point unrecoverable | not worth continuing>`
- Aggregate token spend across every child delegation: `<per-field totals; carry `-` through as unknown>`
- Remaining backlog after this run: `<IDs and statuses; recommend fresh research only when nothing is unfinished>`
