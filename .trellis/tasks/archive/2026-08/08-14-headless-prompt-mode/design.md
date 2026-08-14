# Headless prompt mode design

## Architecture and boundaries

Keep one binary entry point. `src/cli.ts` parses arguments before runtime construction, then
branches:

- no prompt flag: preserve the existing `PermissionQueue` + Ink path;
- prompt flag: create `AgentRuntime` with an immediate-deny headless permission bridge and run a
  dedicated one-shot text driver without importing any alternate agent loop.

Put the headless event-to-text behavior in a small module under `src/` so argument parsing,
stream rendering, and process orchestration are independently testable without a model call.
`AgentRuntime.send()` remains the only turn mechanism and SDK events remain authoritative.

## CLI contract

Parse `process.argv.slice(2)` as exact flags rather than repeated `includes`/`indexOf` lookups.
Value flags consume their following token. Support:

- `-p`, `--print` (headless prompt)
- `--continue`, `--resume` (last-session selector)
- `--session <id>` (explicit selector, precedence over continue/resume)
- `--permission-mode <default|auto|yolo>`, `--yolo`

Reject unknown flags and ambiguous repeated value flags before runtime startup. Preserve yolo's
precedence over `--permission-mode` for compatibility.

## Session data flow

Replace the runtime's boolean-only session request with a selector union:

- `new`: generate the existing timestamp id;
- `continue`: read `.darwin/last-session.json`, falling back to a generated id when absent;
- `id`: validate and use the supplied id directly.

Runtime initialization still constructs the SDK `SessionManager` and awaits `agent.initialize()`;
that restores an existing explicit id when present. `RuntimeInfo.resumed` is determined from
whether initialization restored messages, not merely whether a selector was requested. The
headless stderr output includes the effective session id in one fixed, script-facing record:

`session: <id>`

No status suffix is placed on that line; any human-oriented status belongs on a separate record so
`^session: ([a-z0-9_-]+)$` stays a stable parser contract.

After stream completion, `markResumable()` writes the normal pointer. SDK
`saveLatestOn: 'invocation'` has already persisted the snapshot before the stream completes.

## Output contract

Accumulate final text from assembled `contentBlockEvent` text blocks. Text deltas are not written
to stdout, avoiding partial output on failed turns and duplicate rendering. On successful
completion, join answer blocks in order, write once to stdout, and append exactly one newline.

For tools, stderr receives normalized records derived from `beforeToolCallEvent` and
`afterToolCallEvent`, reusing `classify()` for summary and the existing denial marker detection:

- `tool <name> — <summary>`
- `tool <name> — ok|failed|denied`

Whitespace is collapsed and each field is bounded. Permission requests emit a separate bounded
`permission denied — <summary>` record before immediately returning `{ allowed: false }`.

## Failure and lifecycle behavior

The headless driver throws on startup, stream, answer extraction, or pointer persistence failure.
The CLI catches expected user/config errors and all headless runtime errors, writes concise stderr,
sets a nonzero exit code, and leaves stdout untouched. A completed agent turn that incorporated a
denied or failed tool result remains successful.

Install a headless SIGINT handler only while the one-shot driver is active. It calls
`runtime.cancel()` and records interruption; the `finally` block always awaits
`runtime.shutdown()`. Reuse the existing post-shutdown forced-exit fallback to cover provider
socket leaks. Cleanup failure must be surfaced as nonzero rather than silently claimed successful.

## Compatibility and trade-offs

- Keep `--resume` for the TUI and as a headless alias; add `--continue` as the scripting spelling.
- Recommended: a valid but missing explicit id fails instead of silently starting empty. This
  catches automation typos and keeps `--session` meaning “continue this exact conversation”; the
  trade-off is that callers cannot preselect their own id for a first turn and must capture the
  generated id from stderr or use `--continue`.
- stdout is buffered until success. This sacrifices token-by-token display but gives scripts an
  atomic success channel and keeps failures from leaving plausible partial answers.
- Local slash commands are not a separate headless API in this MVP; the prompt follows the same
  skill/custom-command expansion path used by other drivers where applicable.
