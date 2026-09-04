# SRF-021: rewrite system-prompt rule 8 for the same-message edit contract

## Goal

Rule 8 of `DEFAULT_SYSTEM_PROMPT` (`src/agent/system-prompt.ts`) still describes the pre-SRF-020
world ("several edits to the same file belong in consecutive calls of one message only when they
touch non-overlapping regions") and says nothing about verification commands sharing a message
with the edits they check, nor about routing file writes through `fileEditor`. Reflection
`docs/reflections/reflection_2026-09-02_session-20260902-054329719.md` (F2, F3) shows the model
following the old rule verbatim, losing four of six edits, batching `pnpm typecheck` beside them,
and then falling back to `python3 - <<'EOF'` / `cat >` writes with no edit diff, no permission
classification and no `fileEditor` trajectory record. SRF-020 (`960885e`,
`src/tools/file-editor-serial.ts`) now applies same-path mutations in call order, so the rule must
state that contract — backlog direction SRF-021 (`docs/research/backlog/directions-061-080.md`).

## Requirements

- Rewrite rule 8 (rule 7 only if coherence needs it) so it states, in the register of the
  surrounding rules:
  1. tool calls in one assistant message run concurrently; `fileEditor` edits to the same file in
     one message are applied in call order, so batching disjoint edits to one file in one message
     is correct and each later call sees the earlier result; overlapping edits to one region are
     one edit;
  2. a verification command (typecheck, tests, `rg` for the new text, a build) never shares a
     message with the edits it checks — it goes in the next message, after the edit results;
  3. file mutations go through `fileEditor` (`create`, `str_replace`, `insert`), not `cat >` /
     heredocs, `sed -i`, `python3 - <<EOF`, `tee` or similar shell writes, so the edit diff, the
     permission classification and the trajectory record exist; `fileEditor create` refuses an
     existing file — `view` then `str_replace` a scaffolded file instead of a heredoc.
- Rule count (1–8) and numbering stable; the `## Working method` / `## Working with the user` /
  `## Permissions` headings and every other line of the prompt byte-identical; composition order
  (base → `<project-instructions>` → `<available_skills>` → `<working-context>` → cache point)
  untouched. Roughly the length of today's rules 7+8 (a few extra lines are fine).
- `spike/verify-working-context.ts` gains bounded assertions: key phrases of the new sentences are
  present, "consecutive calls of one message" is gone, and exactly eight numbered rules follow the
  `## Working method` heading.
- `docs/architecture/load-bearing-decisions.md` § System prompt composition notes the rule-8
  change and why; `.trellis/spec/backend/strands-sdk-contracts.md` and `AGENTS.md` only if they
  quote the old sentence (grep says neither does).
- Scope: repository files only; no dependencies, no `node_modules` / SDK patch changes, no
  `pnpm build`, no push; the Host-owned uncommitted `docs/research/backlog/directions-061-080.md`
  is never staged.

## Acceptance Criteria

- [ ] `spike/verify-working-context.ts` asserts the new phrases, the absence of the old one, and
      eight numbered Working-method rules; `spike/verify-system-prompt.ts` still passes.
- [ ] `pnpm typecheck` green; full `pnpm test` exit 0 with zero `FAIL` lines.
- [ ] `docs/architecture/load-bearing-decisions.md` § System prompt composition carries the note.
- [ ] Prompt still caches on a Host live smoke (`cacheWrite` turn 1, `cacheRead` turn 2) — Host
      runs it; the base prompt stays a single static text block, so nothing here changes that.
- [ ] Committed on `main` per `.darwin/skills/commit-message`; task archived in its own commit.
