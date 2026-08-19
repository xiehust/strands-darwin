# PRD — SER-025: `darwin sessions` listing + `--resume <id>`

## Problem

`--resume` today follows only `last-session.json`; `--session <id>` requires already
knowing the id; `darwin trajectory list` lists only what the record store knows and
offers no resume path. There is no way to see this project's resumable sessions and
reopen one by choice. Peer tools have this (Codex `codex resume`, OpenCode `/sessions`).

## Scope (deliberately minimal)

1. **`darwin sessions`** — a CLI subcommand (sibling of `darwin trajectory …`) listing
   this project's sessions from the existing per-project snapshot store
   (`~/.darwin/sessions/<project-key>/`), newest first. Per row: session id, age, and
   the first user prompt where the trajectory recorded one — `(not recorded)` where it
   did not (absence is an answer, never an error). The session bare `--resume` would
   reopen is marked `(last)`.
2. **`--resume <id>`** — `--resume` optionally followed by a session id reopens that
   named session, in both TUI and headless modes. Bare `--resume` (followed by nothing
   or by another flag) keeps today's semantics exactly: reopen the pointer's session.

An in-session switcher is **not** in scope. No new slash command; `MAX_COMPLETIONS`
does not change.

## Binding constraints

- The listing makes no model call and no network access, works with credentials
  absent, and never mutates anything: no pointer moves, no file rewrites — the store
  is byte-identical before and after a listing.
- Sessions of other projects stay invisible (the store is already keyed by project).
- A bogus or other-project id given to `--resume <id>` is a clear refusal (no crash,
  no stack trace, no fallback to the last session). Resolution reuses the existing
  strict `{ kind: 'id' }` path in `resolveSession`.
- A session whose snapshot is missing or unreadable is skipped from the listing and
  the skip is stated (a count with a pointer to `darwin trajectory list`); on resume
  it is refused clearly.
- `process.cwd()` only in `cli.ts` / `dev-repl.ts`; every path derives via
  `src/paths.ts` / `src/agent/session.ts`.

## Decision: pointer semantics after resuming a named session (constraint 5)

Unchanged and now stated explicitly: `markResumable()` writes `last-session.json`
after a turn completes, whatever selector opened the session. So after a
`--resume <id>` (or `--session <id>`) session finishes a turn, `last-session.json`
points at *that* session — the resumed session becomes the one bare `--resume`
reopens. Opening a session and quitting without completing a turn moves nothing.

## Design

- `src/cli-sessions.ts` — new module following the `cli-trajectory.ts` precedent:
  `isSessionsInvocation` / `parseSessionsArgs` (no I/O) / `runSessionsCommand(io)`.
  Routed in `cli.ts` before `parseCliArgs`, before any runtime/model/Ink import.
  Imports nothing from the SDK, no `Agent`, no `Model`.
- Listing = `listSessionIds()` ∩ has-snapshot. Age from the snapshot file's mtime
  (`stat`, read-only), humanized (`3m ago`, `2h ago`, `5d ago`). First prompt = first
  `userInput` record of `trajectory.jsonl` via the existing `readTrajectory` reader
  (same per-id read `darwin trajectory list` already does), collapsed to one line and
  capped for the row.
- `--resume <id>` grammar in `parseCliArgs`: when the token after `--resume` exists
  and does not start with `-`, it is taken as a session id (alphabet-validated like
  `--session`); otherwise `--resume` stays the bare boolean it is today. Combining an
  id-carrying `--resume` with `--session` is a usage error (two id sources).
- TUI refusal: `resolveSession`'s strict unknown-id error becomes a named
  `SessionNotFoundError`; `cli.ts` catches it beside `ConfigError` and prints a plain
  one-line refusal with exit code 1 (headless mode already refuses cleanly). This also
  fixes the pre-existing `--session bogus` stack-trace crash in the TUI.

## Acceptance Criteria

- [ ] `darwin sessions` lists resumable sessions newest first with id, age, first
      prompt where recorded, `(not recorded)` where not; `(last)` marks the pointer.
- [ ] Listing is mutation-free (store byte-identical by hash), no model, no network.
- [ ] Empty project prints a normal notice, exit 0.
- [ ] Missing/unreadable snapshots are skipped-and-stated in the listing.
- [ ] `--resume <id>` opens the named session; unknown/other-project id is a clear
      refusal; bare `--resume` (incl. before another flag) unchanged.
- [ ] pnpm typecheck, pnpm test (incl. new verify-sessions-command.ts), and free pty
      scenarios `clear` + `completion` all pass.
