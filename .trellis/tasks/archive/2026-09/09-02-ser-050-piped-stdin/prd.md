# SER-050 Append piped stdin to the `-p` prompt as one delimited block

## Goal

`git diff | darwin -p "review this"` sends the sentence and silently drops the diff: the
headless path takes its prompt only from argv (`HeadlessOptions.prompt`, both drivers send
`options.prompt` alone) and nothing under `src/cli*.ts` / `src/headless*.ts` mentions stdin.
Make `-p` read a piped (non-TTY) stdin to EOF under a stated byte cap and append it to the
one-shot prompt as exactly one delimited block. A TTY stdin, `/dev/null` (`stdio: 'ignore'`)
or immediate EOF must leave every byte of today's behaviour unchanged, and interactive mode
never reads stdin this way.

Origin: `docs/research/backlog/directions-061-080.md` § SER-050 (Notes subsection is the
contract); report `docs/research/research_2026-09-02.md` (run 02:29:40Z).

## Requirements

- Only the headless runner reads stdin, and only when `process.stdin.isTTY` is falsy. A TTY
  stdin is never iterated. Empty or whitespace-only input is "no input": no block, no notice,
  the prompt argument goes to the model untouched.
- Otherwise the model-facing prompt is the argument, one blank line, then one fixed block:
  `--- piped stdin (<N> bytes) ---`, the decoded text (a newline is added only when the text
  does not already end with one), `--- end of piped stdin ---`. `<N>` is the raw byte length
  of everything read. Exactly one block, appended once, and the argument text is not altered.
- Byte cap **256 KiB (262,144 bytes)**, **refuse** rather than truncate: over-cap input is a
  `CliUsageError` (`error: …` line + the one `--help` hint, exit 2, empty stdout, no runtime,
  no session state). Reason: a silently shortened diff reviewed as if whole is the same silent
  class this direction removes; the user can `head -c`, filter, or name a path in the message.
  Reading stops at the first byte past the cap, so a runaway producer cannot make darwin slurp
  gigabytes.
- Input must decode as UTF-8 (`TextDecoder` fatal) and contain no NUL; anything else is
  refused the same way with an explicit "not UTF-8 text" message. Bytes are never sent as
  base64 or hex.
- The composed text is the one user input: it is what `runtime.send()` receives and therefore
  what the `userInput` trajectory line records (under its existing `MAX_FIELD_CHARS` cap), what
  the memory controller and Codex `UserPromptSubmit` hooks see, and there is no new field in the
  `json` / `stream-json` envelopes (they never echoed the prompt and still do not).
- The stdin read and refusal happen before the SIGINT handler swap, before any `session:`
  record, before the structured writer emits anything and before `createRuntime` — the same
  pre-protocol slot every other usage error occupies.
- Interactive mode, `darwin sessions`, `darwin trajectory …`, `--help`/`--version`: untouched.
  The reader is reachable only from `runHeadlessProcess` through an injectable dependency
  (`HeadlessRunnerDependencies.readPipedStdin`), so in-process and fixture tests can feed it.
- `parseCliArgs` stays pure (no I/O). `CLI_USAGE` gains one line naming the behaviour, and both
  reference docs quote it identically (pinned by `spike/verify-cli-args.ts`).
- `docs/user-guide/reference.md` + `reference.zh-CN.md` document the block shape, the cap, the
  refusal, and the open-pipe caveat: a parent that holds the pipe open without writing makes
  `-p` wait for EOF exactly as `cat` would; `stdio: 'ignore'` children (the developer skill's
  `bash start` jobs, `spike/verify-headless*.ts`) present `/dev/null` and are unaffected.

## Requirement → check checklist

| Requirement | Check |
|---|---|
| piped text appears exactly once in the model-facing prompt (fixture driver spawned with a real pipe) | `spike/verify-headless.ts` `pipedStdinProcessContracts()` — trace `send.input` equals `composeHeadlessPrompt(...)`, one heading, one footer |
| composed prompt is what `send()` receives → the `userInput` record (existing `send(input)` → `userInput` contract, `verify-trajectory.ts`) | same trace assertion; live: `printf 'alpha beta' \| node dist/src/cli.js -p … --max-model-calls 1` then `darwin trajectory replay` shows the block once |
| `stdio: 'ignore'` (/dev/null) run byte-identical to today | existing `verify-headless-structured.ts` fixtures all spawn with `'ignore'` and pin `send.input === 'fixture prompt'` plus exact stdout/stderr; new case pins that the `'ignore'` run and the empty-pipe run produce identical stdout/stderr/trace |
| empty / whitespace-only stdin → no block, no notice | `pipedStdinProcessContracts()` — `''` and `' \n\t\n'` piped → `send.input === 'fixture prompt'`, output identical to the `'ignore'` run |
| over-cap → usage error exit 2, empty stdout, no runtime | `pipedStdinProcessContracts()` — 256 KiB + 1 byte piped → exit 2, exact stderr, trace file never created |
| invalid UTF-8 / NUL → same refusal | unit `readPipedStdin()` over a PassThrough with `0xff` bytes and with `\0` |
| reading stops past the cap | unit — a source that yields forever is abandoned after the cap |
| TTY stdin is never iterated | unit — `isTTY: true` source whose iterator throws; `readPipedStdin` resolves `undefined` |
| block shape fixed: heading with byte count, trailing newline added only when missing | unit `composeHeadlessPrompt()` — `'x'` vs `'x\n'` both end `…x\n--- end of piped stdin ---` |
| `json` / `stream-json` envelopes unchanged apart from the composed prompt | `pipedStdinProcessContracts()` — piped `stream-json` run: same event types as the `'ignore'` run, no field carries the prompt, trace `send.input` composed |
| interactive mode never reads stdin | structural — `src/` grep: `readPipedStdin` imported only by `headless-runner.ts`; `src/cli.ts` and `src/tui/**` contain no `process.stdin` |
| grammar/docs pinned | existing `spike/verify-cli-args.ts` (CLI_USAGE byte-identical in `--help`, both reference docs) |
| gate | `pnpm typecheck`, full `pnpm test`, `pnpm build` |

## Acceptance Criteria

- [x] `spike/verify-headless.ts` covers every checklist row above and passes.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` headless scenario states the stdin
      contract (block, cap, refusal, pre-protocol slot, TTY/ignore invariance);
      `structured-headless-output.md` notes the envelopes carry no prompt field before or after.
- [x] `docs/user-guide/reference.md` and `reference.zh-CN.md` document the semantics, the cap
      and the open-pipe caveat; `CLI_USAGE` line quoted identically in both.
- [x] `pnpm typecheck` clean, full `pnpm test` green (exit 0, zero FAIL lines), `pnpm build` run.

## Verification (2026-09-02)

- `pnpm tsx spike/verify-headless.ts` — 182 passed, 0 failed (`pipedStdinUnitContracts()` and
  `pipedStdinProcessContracts()` added; the process cases spawn the real `runHeadlessProcess`
  through `spike/fixtures/headless-cli.ts` with `stdio 'ignore'` versus a real pipe, and every
  `send()` input comes from the fixture's trace file). `verify-headless-structured.ts` 18/18,
  `verify-cli-args.ts` 43/43 (both reference docs quote the new `CLI_USAGE` line),
  `verify-trajectory.ts` 290/290.
- TTY path: the fixture driver under `node-pty` exits 0 with the identical text protocol — merely
  touching `process.stdin` on a terminal neither reads nor hangs.
- Live (Host acceptance #4, built `dist/`): `printf 'alpha beta' | node dist/src/cli.js -p "echo
  back the piped text only" --yolo --max-model-calls 1` in a scratch repo → stdout `alpha beta`;
  `darwin trajectory replay` shows `you> echo back the piped text only` followed by the
  `--- piped stdin (10 bytes) ---` block once, and the session's trajectory has exactly one
  `userInput` record whose `text` is the composed prompt. `node dist/src/cli.js -p "hi"
  --max-model-calls 1 < /dev/null` → `userInput` is exactly `hi`, no block. Probe state removed.
- `pnpm typecheck` clean. Full `pnpm test`: exit 0, zero FAIL lines, 82 suites (no heartbeat
  flake this run). `pnpm build` run.
