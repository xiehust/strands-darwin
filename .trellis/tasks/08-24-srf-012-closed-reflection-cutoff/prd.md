# SRF-012 closed reflection cutoff

## Goal

Make built-in self-reflection locate and hand off the latest closed turn/seq cutoff, refusing subjects with no closed turn.

## Requirements

- Select the current or explicitly named trajectory exactly as today: newest mtime plus recognizable latest prompt for the default, strict `--session` authority for a named past session, and no missing-id fallback.
- Read the selected append-only trajectory without mutation and derive a durable subject cutoff from its latest valid `turnEnded` record. Print the closed turn and seq boundary explicitly while retaining the latest `userInput` preview used to identify the current session.
- Exclude every record after that cutoff, including a later open reflection `userInput`; refuse nonzero when the selected record has no closed turn.
- Require the managed reflection child to read and grade only the passed inclusive closed cutoff, report the actual bounded turn/seq range honestly, and preserve unknown spend values as unknown.
- Preserve locator-before-child ordering, managed-child/developer supervision semantics, exact reflection template and score gate, read-only trajectory behavior, append-only backlog handling, and all trajectory observer invariants.
- Do not alter the origin reflection or SRF-012 backlog row; Host acceptance owns final backlog status and iteration logging.

## Acceptance Criteria

- [x] Locator output for a current-session fixture identifies the newest trajectory, previews its later open `userInput`, and supplies the preceding latest closed turn/seq cutoff.
- [x] Explicit named past-session selection remains authoritative and supplies that record's own latest closed cutoff.
- [x] A selected current or named trajectory with no valid `turnEnded` exits nonzero and supplies no reflection-subject fallback; a missing named id also refuses without fallback.
- [x] Tests prove the locator leaves trajectory bytes and surrounding session state unchanged.
- [x] Bundled self-reflection instructions hand the child the exact inclusive cutoff and require all replay/raw inspection, grading, spend aggregation, citations, and range claims to stop there.
- [x] Architecture/spec/AGENTS contracts describe closed-cutoff reflection without weakening trajectory invariants.
- [x] Focused checks, `pnpm typecheck`, one full `pnpm test`, Trellis validation, `git diff --check`, and `pnpm build` pass; generated dist assets match source.
- [x] Implementation and Trellis artifacts are committed using the project convention.
