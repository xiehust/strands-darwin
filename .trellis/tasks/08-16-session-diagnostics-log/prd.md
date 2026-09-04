# Opt-in per-session diagnostics log for SDK `debug`/`info` plus darwin notices

Backlog direction `SER-008` (origin report `docs/research/research_2026-08-16.md`, run `10:52:35Z`),
the third and last direction of the batch that shipped `SER-006` (`1f2c147`) and `SER-007`
(`e4033ef`). Unlike those two this one has a privacy dimension, which is why it is opt-in.

## Goal

The diagnostics darwin currently discards must be available to whoever is debugging a session, and
invisible to everyone who did not ask for them.

## Background — measured, not assumed

- `routeSdkLogs` wires the SDK's `debug` and `info` to `() => {}` (`src/agent/sdk-logging.ts:40-41`,
  and again in the restore closure at `:48-49`) with **no configuration to route them anywhere**.
  `warn`/`error` *are* routed to the renderer (`:42-43`), deliberately, and that must not regress:
  `src/tui/App.tsx:139` turns them into transcript notices and `src/cli.ts:93-95` writes them to
  stderr.
- The SDK logs the answer to "why was that turn slow" at `debug`:
  `models/bedrock.js:1181` `throttled | error_message=<…>`, with equivalents at `anthropic.js:222`,
  `openai/model.js:210`, `vercel.js:156`. Also lost: cache-point placement (`bedrock.js:573`/`:576`),
  native token counting and its fallbacks (`:279`/`:290`/`:294`), tool-result-status auto-detection
  (`:673`), MCP tool renames (`mcp/client.js:200`), retry scheduling
  (`retry/default-model-retry-strategy.js:77-84`) and intervention dispatch
  (`interventions/registry.js:190-234`). `grep -c` over `dist/src` counts **60** `logger.debug|info`
  call sites.
- The SDK's `logger` is a **mutable module binding** read at call time
  (`dist/src/logging/logger.js`: `export let logger = defaultLogger`), so `configureLogging`
  replaces it process-wide — for the parent agent, every subagent, and every model adapter at once.
  Its default `debug`/`info` are themselves no-ops, so darwin's are not adding a suppression the SDK
  did not already have; what is missing is any way to opt in.
- The root export map exposes `configureLogging` only — there is no deep `logging` entry point — so a
  test cannot import the binding to inspect it. Proving "off is off" therefore has to be
  **behavioural**, driving a real SDK path.
- Measured before implementing: a real `Agent` turn with one intervention emits six real `debug`
  lines (`event=<beforeInvocation> | dispatching to 1 handler(s)`, `handler=<…>, event=<…> |
  evaluating`, …) with no network and no model call. darwin always installs an intervention (the
  `PermissionGate`, `runtime.ts`), so the fast suite can prove the whole seam with the SDK's own
  output instead of a mock logger.
- TUI notices live in Ink's scrollback and die with the frame (`turnReducer`'s `notice` case in
  `src/tui/turn-state.ts`). Headless writes `sdk warn — …` / `error: …` to stderr, which is gone
  unless the caller captured it.

## Requirements

1. **Opt-in, and off is indistinguishable from today.** A boolean `diagnostics` in `SessionFields`,
   absent by default. With no tap installed, `debug`/`info` are installed as literal `() => {}` —
   not a closure that tests a flag — no file is created, and nothing is formatted or buffered.
2. **Validated at load time** like every other config value: `ConfigError` naming the field, refusing
   to start. Session-scoped (`SESSION_KEYS`), so `/model` preserves it and a `models` entry carrying
   it is refused. No CLI flag: it would add an override path and a startup fact to serve a workflow
   the config field already serves.
3. **One file per session, beside the record**:
   `~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log`, a sibling of `trajectory.jsonl`,
   `background/` and `offload/`, created lazily on the first line. Never in the working tree.
4. **It captures what is lost, plus what already reaches the renderer**: SDK `debug`/`info`/`warn`/
   `error` and darwin's own notices with their severity, so one file holds the whole story. Every
   line carries an ISO timestamp and is individually parseable by a human reading with `tail -f`.
5. **Observer discipline, as the trajectory earned it**: writing a diagnostic may not fail a turn,
   reorder, delay or drop a *stream event*, throw into a caller, or write to the console. A failure
   latches, stops logging, and surfaces once. Volume is bounded — 8,000 code points per line, 8 MiB
   per file, 1 MiB of pending unwritten bytes — and at each bound what happened is written into the
   file, never silently dropped. Dropping a *diagnostic line* under backpressure is correct; delaying
   or dropping a stream event is not.
6. **Discoverable without a frame row**: a transcript notice when the feature is on, and one stderr
   record in headless. No header line (the header contract in `AGENTS.md`, enforced by
   `spike/verify-tui.ts approve` on a 50-row terminal) and no new slash command.
7. **Nothing existing is weakened or duplicated**: notices still render, headless still writes every
   stderr record it writes today byte-for-byte and in the same order, and the trajectory is untouched.
   This is a second, opt-in sink.

## Non-goals

- A log level. Every fact this direction exists to capture is at `debug`, so an `info` level would
  produce a file that exists and is silent about the evidence in the row's own justification; volume
  is bounded by bytes anyway, and a level would be a second, weaker bound tuned by guessing. A later
  `diagnosticsLevel` stays additive.
- A `--diagnostics` CLI flag, a `/diagnostics` command, log rotation, or reading the file back with a
  subcommand. `tail`/`grep` are the reader.
- Redaction. The file is opt-in precisely because it cannot be promised to be free of
  conversation-derived material.

## Acceptance Criteria

- [ ] A default run: no diagnostics file anywhere, `debug`/`info` still discarded (proven
      behaviourally through a real SDK path), and `routeSdkLogs`' `warn`/`error` routing unchanged.
- [ ] Feature on, real Bedrock turn: the file exists and holds SDK `debug` lines the run genuinely
      produced, plus at least one darwin line with its severity and a timestamp.
- [ ] A misconfigured value refuses to start with a `ConfigError` naming `diagnostics`.
- [ ] An unwritable path degrades to one notice and fails neither the turn nor the session.
- [ ] The bound is enforced and the stop is stated in the file itself.
- [ ] No frame row added: `spike/verify-tui.ts approve` still passes on its 50-row terminal.
- [ ] `pnpm typecheck`, `pnpm test` (27 suites), `spike/verify-diagnostics.ts`,
      `spike/verify-tui.ts completion`, `git diff --check`, Trellis validation.
