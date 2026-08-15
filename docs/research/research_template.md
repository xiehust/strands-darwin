# Darwin self-evolution research — YYYY-MM-DD

Copy this structure to `research_<YYYY-MM-DD>.md`, using the UTC date. A daily file is append-only: before a same-day run, read the existing file and append another timestamped `## Run` section at the end. Never overwrite an earlier run.

## Run — YYYY-MM-DDTHH:MM:SSZ

### Backlog-first decision

- Backlog inspected first: `docs/research/backlog_index.md`
- Unfinished directions found: none | IDs
- Decision: fresh research | resume/start `<ID>` without fresh research

> If any `进行中` or `未开始` row exists, stop product research and use the existing backlog path. A research section below is valid only when no unfinished row existed at invocation start.

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

| Rank | Proposed ID | Direction | Importance | Architecture fit | Evidence confidence | Implementation difficulty | Implementation risk | Score | Evidence and rationale |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | SER-NNN | `<direction>` | 1–5 | 1–5 | 1–5 | 1–5 | 1–5 | `<score>` | `<source refs, Darwin refs, dependencies and qualitative rationale>` |

### Recommendation

- Selected direction: `<one ID, or none>`
- Why now: `<qualitative recommendation; note any safety/dependency override>`
- Independently observable acceptance: `<checks for the developer workflow>`
- Backlog updates: `<IDs added as 未开始; selected ID changed to 进行中 only immediately before developer handoff>`

### Developer outcome

Complete this only when one direction is handed to the loaded `developer` skill.

- Direction: `<ID>`
- Child session and managed tasks: `<evidence>`
- Host acceptance: `<exact independent checks and outcomes>`
- Final status: `完成` only after acceptance; otherwise `进行中` with blockers; `放弃` only with explicit reason
- Iteration-log entry: `<docs/iteration-log.md heading/link>`
