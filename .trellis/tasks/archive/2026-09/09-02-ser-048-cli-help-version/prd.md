# SER-048 CLI `--help`/`-h` and `--version`/`-V` as bounded local output

## Goal

`darwin --help`, `darwin -h`, `darwin --version` and `darwin -V` today fall through
`parseCliArgs` as `Unknown argument` (exit 2). Make them bounded local answers that resolve like
`sessions`/`trajectory` — before argument parsing and before any runtime, config, model or Ink
work — and make every `CliUsageError` stderr report point the user at `darwin --help`.

Origin: `docs/research/backlog/directions-061-080.md` § SER-048 (Notes subsection is the
contract); report `docs/research/research_2026-09-02.md` (run 02:29:40Z).

## Requirements

- One exported grammar constant (`CLI_USAGE`) is the single source of the usage text: the
  `--help` output prints it, the `src/cli.ts` header comment points at it instead of repeating it,
  and `docs/user-guide/reference.md` / `reference.zh-CN.md` quote it verbatim (test-pinned).
- `--help`/`-h` → `CLI_USAGE` on stdout, empty stderr, exit 0.
- `--version`/`-V` → `darwin <DARWIN_VERSION>` on stdout, empty stderr, exit 0; the version equals
  `package.json`'s.
- Either flag anywhere in argv wins over everything else (help before version), including the
  `sessions`/`trajectory` subcommand routes and `-p`.
- Handled before `parseCliArgs`, before `sessions`/`trajectory` routing, with no file write and no
  network; the module answering them (`src/cli-usage.ts`) imports nothing from the runtime, the
  SDK or Ink — only `src/version.ts`.
- Every `CliUsageError` handler (TUI/headless parse, `sessions`, `trajectory`) keeps its exact
  `error: <message>` line and exit 2, and appends exactly one hint line naming `darwin --help`.
  `CliUsageError.message` strings are unchanged (`parseCliArgs` tests pin them).
- Out of scope: a `help` subcommand, per-subcommand help pages, coloured output, any TUI change,
  making `cli.ts`'s existing static imports lazy.

## Requirement → check checklist

| Requirement | Check |
|---|---|
| `--help`, `-h` exit 0, stdout = `CLI_USAGE`, stderr empty | `spike/verify-cli-args.ts` spawns `src/cli.ts` |
| `--version`, `-V` exit 0, stdout = `darwin <package.json version>`, stderr empty | same, compares against `package.json` read directly |
| help wins over other flags / subcommands / version | same: `--yolo --help`, `-p x -h`, `sessions --help`, `--version --help` |
| version wins over other flags | same: `--resume --version` |
| unknown flags still exit 2 with the original message plus the hint (TUI, headless, trajectory paths) | same: exact stderr assertions |
| `parseCliArgs` messages unchanged | existing `usageError(...)` assertions stay |
| `src/cli-usage.ts`/`src/version.ts` import no runtime/SDK/Ink module | import-graph scan in `spike/verify-cli-args.ts` (style of `spike/verify-trajectory.ts`) |
| no file write | private HOME has no `.darwin/` after `--help`/`--version` |
| docs quote `CLI_USAGE` verbatim and name the hint | `spike/verify-cli-args.ts` reads both reference files |
| gate | `pnpm typecheck`, full `pnpm test` |

## Acceptance Criteria

- [x] `pnpm tsx src/cli.ts --help|-h|--version|-V` exit 0 with expected stdout, empty stderr.
- [x] `spike/verify-cli-args.ts` covers every checklist row above and passes.
- [x] `docs/user-guide/reference.md`, `reference.zh-CN.md` document the flags and the hint;
      `README.md`/`README.zh-CN.md` list `darwin --help` / `darwin --version`.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` CLI grammar and
      `.trellis/spec/backend/error-handling.md` usage-error row state the flags and hint.
- [x] `pnpm typecheck` clean, full `pnpm test` green, `pnpm build` run.

## Verification (2026-09-02)

- `pnpm tsx spike/verify-cli-args.ts` — 43 passed, 0 failed (was 12). The four doc assertions
  failed before the docs were written and passed after, so the pin discriminates.
- `pnpm tsx spike/verify-headless.ts` — 98 passed, 0 failed (its `-p` usage-failure regex now
  expects the hint line; no other suite pinned usage-error stderr).
- `pnpm typecheck` clean; full `pnpm test` exit 0, zero FAIL lines; `pnpm build` clean and
  `node dist/src/cli.js --version|-h|--bogus` behave as `src/cli.ts` does.
- Live: `--help`, `-h`, `--version`, `-V` exit 0 with empty stderr; `--version` prints
  `darwin 0.0.1` = `package.json`; `--yolo --help`, `sessions --help`, `trajectory search --help`,
  `--version --help` print the grammar; `--resume --version` prints the version; `--unknown`,
  `-p x --unknown`, `trajectory bogus`, `sessions extra`, `-p` exit 2 with the original message
  plus exactly one `Run \`darwin --help\` for usage.` line.
- Import graph: `src/cli-usage.ts` imports only `./version.js`; `src/version.ts` only `node:*`.
