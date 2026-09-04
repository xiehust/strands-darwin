---
name: self-reflection
description: Reflect on the current session's recorded trajectory with a fresh headless darwin worker — grade goal completion, mine the record for darwin-side improvements, score them with the self-evolution gate, and queue accepted directions into the research backlog. Use when the user asks darwin to reflect on or review this session.
---

# Self-reflection

Run this workflow from the Darwin repository root. The reflection itself is delegated to a
headless darwin child, exactly like the `developer` workflow's worker: this Host conversation
locates the evidence and accepts the result; the child reads the record and writes the
reflection. Do not analyse the trajectory in the Host and do not write the reflection yourself.

## 1. Locate this session's trajectory first

Before launching anything, run the bundled locator once from the skill directory shown in the
`load_skill` result:

```bash
node <skill-directory>/scripts/locate-trajectory.mjs
```

It resolves `~/.darwin/sessions/<project-key>/` for the current working directory and selects
the trajectory file appended to most recently — at this moment that is the Host's own session,
because the prompt that invoked this skill was already recorded as a `userInput` line. The
script prints a `session:` / `trajectory:` / `last-user-input:` block plus explicit
`closed-through-turn:` and `closed-through-seq:` fields, and mutates nothing. Those two fields
name the latest recorded `turnEnded` and form the inclusive reflection cutoff: the later open
`userInput` identifies this Host session but is not part of the subject being graded.

Two checks are mandatory before the selected id is trusted:

- on the default (newest-mtime) selection, the `last-user-input:` preview must be
  recognizable as this conversation's latest user prompt. If it is not — another darwin
  session in this project is active, or this session runs with `trajectory: false` — stop and
  ask instead of reflecting on the wrong session;
- run the locator **before** starting the child. The child is itself a darwin session in the
  same project, so a locator run after launch could select the child.

The user may also name any past session of this project explicitly: run the locator with
`--session <id>` (ids come from `darwin sessions` or `darwin trajectory list`). The named id
is then the authority — the preview no longer has to match this conversation; echo it back so
the user can confirm the subject is the session they meant. The script refuses a missing id
rather than falling back to another session. When the project records no trajectory at all,
the locator says so and exits non-zero; there is nothing to reflect on — report that instead
of inventing a subject. A selected current or named record with no `turnEnded` also exits
non-zero: an open request is not a reflection subject and must never be graded as unfinished.

Keep the exact `session:`, `trajectory:`, `closed-through-turn:` and `closed-through-seq:`
values; all four go into the child prompt verbatim.

## 2. Launch the reflection worker

Construct a shell-safe darwin command for the repository root and launch it with the `bash`
tool in **`start` mode** with `--yolo --context-offload`; offload is already default-on, and
this retained process-only flag force-enables it if persistent config opted out. Never run the
child with foreground `execute`. The managed-child contract is the `developer` skill's, applied unchanged: monitor
with `bash status`, drain with incremental `bash output` until `hasMore: false`, capture the
child's `^session: ([a-z0-9_-]+)$`, `^usage: input=(\d+|-) output=(\d+|-) cacheRead=(\d+|-)
cacheWrite=(\d+|-)$` and `^cost: total=(\d+\.\d+|-) input=(\d+\.\d+|-) output=(\d+\.\d+|-)
cacheRead=(\d+\.\d+|-) cacheWrite=(\d+\.\d+|-) model=(\S+) pricing=(\S+)$` stderr records, and
treat `-` as unknown, never zero (a `cost:` `total` of `-` is never summed as 0). The child
must not load the `developer`, `self-evolution-research`, or `self-reflection` skills,
must not start another darwin, and must not delegate the reflection again.

The first prompt must hand the child:

- the reflected session id and absolute trajectory path from section 1, stated read-only: the
  child never rewrites, repairs, or appends to the record;
- the exact inclusive subject boundary from section 1: `closed-through-turn: <turn>` and
  `closed-through-seq: <seq>`. The child must verify that exact seq is a `turnEnded` for that
  exact turn, then read and grade only records with `seq <= <seq>`; no later record may affect
  the goal summary, grade, findings, spend, timing, or citations;
- how to read it: `pnpm tsx src/cli.ts trajectory replay <session-id>` (read-only, no model
  call) for orientation only, plus the raw `trajectory.jsonl` lines for the authoritative
  bounded range and what replay does not print — `turnEnded` spend and failure fields,
  tool-call inputs, timestamps and `seq` ranges. Replay may show the open tail, so the child
  must discard everything after the passed cutoff;
- the honesty bound: state the actual first and last `seq` and turn values among records in the
  passed closed range. The last value must be the passed `closed-through-seq` / turn, never the
  file's later open tail; unknown spend metrics stay unknown, never 0;
- the output contract: exactly one new file,
  `docs/reflections/reflection_<UTC-date>_<session-id>.md` (date as `YYYY-MM-DD`), creating
  `docs/reflections/` when missing and refusing to overwrite an existing file;
- the template: follow `<skill-directory>/references/reflection-template.md` — every section
  present, in order, none renamed;
- the scoring contract of section 3, verbatim;
- the backlog contract of section 4, verbatim; and
- the mutation scope: exactly the one reflection file plus appended direction sections in the
  current routed page under `docs/research/backlog/`; rollover may also create the next page and
  add its one route to `docs/research/backlog_index.md`. No source edits, and no commit unless
  the user explicitly authorized one in this conversation.

## 3. What the reflection must contain

The template is the authoritative layout; these are its two load-bearing judgements.

**Completion grade** — exactly one of four levels, justified by trajectory evidence (turn and
`seq` references), never by impression:

- **Perfect** — the whole run was smooth: no failed or misdirected tool calls, no
  direction reversals, and the user's goal fully met;
- **High** — the user's goal fully met, but the path had real detours: tool-use errors,
  retried approaches, changed direction;
- **Medium** — the core need was met, with two or more stated problems left unresolved;
- **Low** — the core need was not met.

**Darwin improvement findings** — what this run shows could have been avoided by improving
darwin itself: system prompt, tool descriptions, multi-agent orchestration, context
management, execution time, token spend, or anything else the record supports. Every finding
names its evidence records and ends in a concrete, implementable suggestion.

**Scored directions and the gate** — apply the `docs/research/backlog_index.md` ranking
contract to every suggestion: rate **Importance**, **Architecture fit**, **Evidence
confidence**, **Difficulty** and **Risk** on 1–5 scales, compute
`Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`, and
apply the same gate, `MINIMUM_IMPLEMENTATION_SCORE = 6`. Propose zero to five new,
non-duplicate directions; read the index first, search the routed pages'
headings and ID/Priority metadata, and never re-propose a direction that already exists in any
status. Qualitative rationale rides along, and the formula
never overrides a documented safety or dependency concern. Directions below the gate stay in
the reflection document as rejected, with their scores.

## 4. Queue accepted directions into the backlog

Every direction at or above the gate is appended to the current routed priority page as one
complete `not-started` section: a stable `SRF-NNN` id (the next unused number; never renumber
anything), a Priority continuing after the highest existing record, all five dimensions plus
the Score, an Origin report link to the new reflection document, explicit implementation /
acceptance evidence, and Notes carrying the evidence summary. Order accepted sections so
dependencies come first — that order is their implementation sequence. Existing sections are
never edited, reordered, or restated; the page diff must show appended sections only.

A page holds at most 20 priorities. If the next Priority falls outside the current range,
create the next zero-padded `directions-NNN-NNN.md` page under `docs/research/backlog/` and add
exactly one route to `backlog_index.md`. Creating that route is the only permitted index edit;
never add mutable status there or rebalance a closed page.

Accepted `SRF` sections are ordinary backlog work: the next `self-evolution-research` run selects
them as its development tasks through its normal batch rules.
This workflow never starts implementing them itself.

## 5. Accept independently

After the child reports completion, verify from the Host without trusting its prose:

- the reflection file exists at the exact expected path, contains every template section, and
  its grade is one of the four levels with cited trajectory evidence;
- every accepted direction's Score arithmetic is correct and at or above 6, and every `SRF` id
  is new;
- `git status` / `git diff`: nothing changed outside the reflection file, the current/new
  routed page, and an index route on rollover; backlog sections are append-only and any index
  diff adds only that one route.

On a concrete failure, send the exact failure back to the same child session as a focused
correction — another `bash start` task with `--session <captured-id> --yolo
--context-offload`, per the `developer` correction rules. Do not patch the reflection yourself
to conceal the failure.

## 6. Report

Report:

- the reflected session id and trajectory path;
- the child conversation session id, every `bg-*` task id and terminal outcome;
- the reflection document path and its grade;
- accepted directions (`SRF` ids with scores) now queued for `self-evolution-research`, and
  rejected ones with their scores;
- token spend per captured `usage:` line plus the aggregate, `-` metrics stated as unknown, and
  the captured `cost:` USD `total` per line plus its aggregate on the same rule (a missing line
  stated as such);
  and
- unresolved risks, denied operations, or decisions still needed.
