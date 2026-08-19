# Session reflection — `<session-id>`

Follow this layout exactly: every section present, in order, headings unchanged. Every
judgement cites trajectory evidence as `turn N` / `seq N` references. Unknown metrics are
written as `unknown`, never `0`.

```markdown
# Session reflection — <session-id>

- **date (UTC):** <YYYY-MM-DD>
- **project:** <absolute project root>
- **trajectory:** <absolute trajectory.jsonl path>
- **record read:** seq <first>–<last>, turns <first>–<last> (the record ends mid-turn: the
  reflection turn itself was still open when this was read)
- **model / provider:** <from runStarted>
- **session spend:** input=<n|unknown> output=<n|unknown> cacheRead=<n|unknown>
  cacheWrite=<n|unknown> (summed over recorded `turnEnded.spend`; absent fields stay unknown)

## 1. What the user asked for, and what happened

One paragraph per user goal: the goal in the user's own terms, what the session delivered,
and where in the record the delivery (or its absence) is visible.

## 2. Overall completion grade

**Grade: <Perfect | High | Medium | Low>**

Rubric — pick exactly one:

- **Perfect** — the whole run was smooth: no failed or misdirected tool calls, no
  direction reversals, and the user's goal fully met.
- **High** — the user's goal fully met, but the path had real detours: tool-use errors,
  retried approaches, changed direction.
- **Medium** — the core need was met, with two or more stated problems left unresolved.
- **Low** — the core need was not met.

Justification: the specific records that place the run at this level and rule out the level
above (e.g. the failed tool calls that deny Perfect, or the unresolved leftovers that deny
High, each with turn/seq references). List every leftover problem explicitly when grading
Medium.

## 3. Process observations

A factual pass over the record — what a reader needs before believing section 4:

- turn-by-turn outline (goal of the turn, tools used, outcome);
- every failed, retried, or abandoned tool call, with its error text;
- direction changes, cancelled turns, permission denials, queued prompts;
- time and token hotspots: the slowest stretches and the most expensive turns, from record
  timestamps and `turnEnded.spend`.

## 4. Improvement findings for darwin

What this run shows could have been avoided by improving darwin itself — system prompt, tool
descriptions, multi-agent orchestration, context management, execution time, token spend, or
anything else the record supports. One subsection per finding:

### F<N> — <one-line finding>

- **Evidence:** <turn/seq references and what they show>
- **Root-cause area:** <system prompt | tool description | orchestration | context
  management | execution time | token spend | other>
- **Suggestion:** <the concrete, implementable change to darwin>

A run with nothing to improve says so here instead of inventing findings.

## 5. Scored directions and the gate

The `self-evolution-research` ranking applied to each section 4 suggestion. Dimensions are
1–5; `Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`;
`MINIMUM_IMPLEMENTATION_SCORE = 6`. Check `docs/research/backlog_index.md` first and propose
only non-duplicates (zero to five in total). The formula never overrides a documented safety
or dependency concern — say so in Rationale when that applies.

| ID | Direction | Importance | Architecture fit | Evidence confidence | Difficulty | Risk | Score | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---|
| SRF-<NNN> | <direction> | <1–5> | <1–5> | <1–5> | <1–5> | <1–5> | <n> | accepted / rejected (below gate) / duplicate of <ID> |

Rationale per direction: why these ratings, and the dependency order among accepted rows.
Rejected and duplicate directions stay in this table with their scores; they are not added to
the backlog.

## 6. Backlog updates

The exact rows appended to `docs/research/backlog_index.md` (status `not-started`, origin
report pointing at this document), in dependency order — or `none` when nothing passed the
gate.
```
