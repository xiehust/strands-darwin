# Headless prompt mode

## Goal

Make darwin a scriptable one-shot CLI: a caller can send one prompt, receive only the final
assistant reply on stdout, observe concise tool progress on stderr, continue a chosen persisted
conversation, and reliably branch on the process exit status without starting Ink or piping the
debug REPL.

## Background

- `src/cli.ts` currently always constructs `PermissionQueue` and mounts Ink after runtime startup.
- `src/dev-repl.ts` already demonstrates direct `AgentRuntime.send()` event consumption, but mixes
  prompts, headers, tool progress, and assistant text on stdout and is intentionally only a
  debugging aid.
- Session snapshots are stored under `.darwin/sessions/session/<session-id>/...`; the existing
  `.darwin/last-session.json` pointer is updated only after a completed turn.
- The SDK accepts session ids matching lowercase letters, digits, hyphens, and underscores.

## Requirements

1. `darwin -p <message>` and `darwin --print <message>` run exactly one agent turn without
   constructing the Ink renderer or waiting for stdin.
2. On a successful turn, stdout contains the complete final assistant reply followed by one
   newline, with no banner, prompt, tool transcript, ANSI control sequence, or SDK printer output.
3. Headless tool lifecycle is written to stderr as bounded single-line records: one line when a
   tool starts and one line with `ok`, `failed`, or `denied` when it finishes. The line uses the
   existing permission classifier's human-readable summary and collapses embedded whitespace so
   arbitrary tool input cannot create extra log lines.
4. Headless permission requests never block. The non-interactive permission bridge immediately
   denies requests and writes a concise denial line to stderr. Static-safe calls, persisted allow
   rules, `--permission-mode auto`, `--permission-mode yolo`, and `--yolo` retain their existing
   gate semantics; in particular yolo mode does not invoke the denial bridge.
5. `--continue` in headless mode continues the session selected by
   `.darwin/last-session.json`. `--resume` remains supported as the interactive spelling and is
   accepted as a headless compatibility alias.
6. `--session <id>` in headless mode directly selects that persisted session. It takes precedence
   over `--continue`/`--resume`; the id is validated before runtime startup. The behavior when the
   id is syntactically valid but has no persisted snapshot is the remaining product decision.
7. A successfully completed headless turn updates `.darwin/last-session.json`, including a turn
   selected by `--session`, so a later `--continue` follows it. A failed turn does not advance the
   pointer.
8. CLI usage errors (missing/empty `-p` value, missing/invalid `--session` value, conflicting
   repeated value flags, or unknown flags) fail before model invocation with a concise stderr
   message and nonzero exit status.
9. Exit status is `0` only after the agent turn, session snapshot, and resume-pointer write all
   complete successfully. Startup/configuration, model/turn, persistence, and cleanup failures
   produce a nonzero status and an actionable stderr message. A denied tool call by itself is not
   a process failure if the model handles the denied result and completes its reply.
10. Headless shutdown uses the same runtime cleanup path as the TUI and exits within a bounded
    time; SIGINT cancels the active turn, performs cleanup, and exits nonzero.
11. Existing interactive behavior and `--resume`, `--yolo`, and `--permission-mode` combinations
    remain compatible. Every headless run writes an exact `session: <id>` line to stderr so scripts
    can capture the effective id for later `--session` calls; documentation describes this format.

## Acceptance Criteria

- [ ] `darwin -p "reply with ok" >reply 2>progress` does not mount Ink, exits `0`, and writes only
      the assistant answer plus a final newline to `reply`.
- [ ] A tool-using headless turn emits deterministic single-line start/result records to stderr;
      multiline arguments and results never pollute stdout or expand one record into many lines.
- [ ] In default permission mode, a risky tool request is denied immediately, logged, returned to
      the model as a denied tool result, and the process does not hang.
- [ ] The same risky request can execute with `--yolo` or `--permission-mode yolo`; auto mode keeps
      its existing classifier behavior.
- [ ] Two separate invocations using `--continue` preserve conversational context.
- [ ] Two separate invocations using the same `--session <id>` preserve conversational context,
      and choosing one existing session does not restore another.
- [ ] Invalid argument combinations and invalid session ids make no model call, write no Ink/ANSI
      output, and exit nonzero with a useful stderr message.
- [ ] A forced startup or turn failure leaves stdout empty, reports stderr, exits nonzero, and does
      not update the last-session pointer.
- [ ] Headless process-exit verification completes within a deadline after success and failure;
      existing TUI scenarios, `pnpm typecheck`, `pnpm test`, and `pnpm build` remain green.

## Out of Scope

- Reading prompts from stdin or files; structured JSON/JSONL output; streaming partial assistant
  text to stdout; batch prompts; an interactive approval protocol over stdin; session listing,
  naming, deletion, or metadata management; replacing `dev-repl`.
- Treating individual tool failures/denials as process failure when the agent still reaches a
  normal end-of-turn response.

## Open Question

- Should `--session <id>` fail when the id does not already exist, or create a new empty session
  under that caller-supplied id?
