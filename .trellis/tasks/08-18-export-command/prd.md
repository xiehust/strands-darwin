# Export session transcript via /export

Backlog direction SER-019 (docs/research/research_2026-08-18.md, run 2026-08-18T09:15:03Z;
docs/research/backlog_index.md).

## Goal

A new `/export <path>` built-in writes the transcript of the *current* session — projected
from its own trajectory record — to the user-named file, and reports the write as a notice.
Absence of a record degrades to a "nothing to export" notice, never an error and never an
empty file.

Peer evidence (cite-only): Claude Code `/export [filename]` (plain text file or clipboard
dialog), OpenCode `/export` (Markdown + `$EDITOR`), Codex `/copy` (clipboard). Clipboard and
`$EDITOR` are deliberately out of scope (SSH-hostile, environment-dependent): darwin writes a
file at the path the user names, nothing else.

## Requirements

1. **Observer only.** Export *reads* the record bytes that exist: never writes to, repairs,
   truncates or reorders the record, never moves the resume pointer, never blocks or delays a
   turn. Reading mid-turn is allowed and tolerates a partial trailing line exactly as
   `readTrajectory` already does.
2. **One projection.** The transcript body reuses `replayRead`/`formatReplay` — never a second
   formatter. A small header (session id, project, record path, export time) is allowed but the
   body stays byte-identical to `formatReplay` output, and the header says it is a replay
   projection.
3. **Path handling.** The argument is required (`/export` alone → usage notice naming the
   shape); relative paths resolve against the project root; an existing file is refused with a
   clear notice (no `--force`); an unwritable path degrades to one error notice, never a crash;
   a target inside `~/.darwin/sessions/` is refused (the record directory belongs to the
   recorder).
4. **Absence is an answer.** `trajectory: false`, a session with no record file yet, and a
   record with zero turns all read as "nothing to export" notices stating why.
5. The write is small and local; it may be awaited; a failure costs the export only, never the
   session.
6. No model call anywhere in the path; no new dependency; notices go through `<Static>`; the
   header gains no row.
7. `pnpm typecheck` and `pnpm test` pass; a focused free spike suite covers export over real
   trajectory records in a throwaway HOME; `verify-tui.ts completion` passes with the 14th
   built-in visible (`MAX_COMPLETIONS` grows to 14).

## Acceptance Criteria

- [x] In a session with recorded turns, `/export out.md` writes a file whose transcript body is
      byte-identical to `formatReplay` of the same record (modulo the stated header).
- [x] The record file, its sha256 and the resume pointer are unchanged by the export.
- [x] `/export` with no argument yields usage.
- [x] Exporting over an existing file is refused with a notice.
- [x] An unwritable directory yields one error notice.
- [x] A trajectory-off session yields "nothing to export" and writes no file.
- [x] The completion menu lists every built-in including `/export`.

## Design sketch

- New module `src/trajectory/export.ts` (no `Agent`/`Model`/Ink imports, like the rest of
  `src/trajectory/`): `exportTranscript({ argument, projectRoot, sessionId, recordFile })`
  returning a notice-shaped outcome. Uses `readTrajectory` + `replayRead` + `formatReplay`;
  writes with `flag: 'wx'` so refuse-to-overwrite is atomic, not a check-then-write race.
- `App.tsx` handler follows the `/trajectory` local-report pattern (above the busy check —
  reading a record cannot disturb a turn); `recordFile` comes from
  `runtime.trajectoryStatus?.file` (undefined ⇔ trajectory off).
- `BUILTIN_COMMAND_NAMES` gains `export` (13 → 14 names, alphabetical), with a description;
  `MAX_COMPLETIONS` 13 → 14; `verify-tui.ts completion` gains the `/export` row assert.
- New free suite `spike/verify-export-command.ts` in `pnpm test`: real record fixtures in an
  owned HOME (pattern: `verify-prompt-recall.ts`), sha256-before/after on the record and the
  resume pointer, body-identity against `formatReplay`.
