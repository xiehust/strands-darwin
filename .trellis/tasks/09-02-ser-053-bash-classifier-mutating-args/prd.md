# SER-053: close mutating escapes in the static read-only bash classifier

## Goal

`assessBashRisk` (`src/agent/permission.ts`) proves a bash command statically `safe` by
looking only at each segment's first word (and `git` subcommand). It never looks at
arguments, so `find … -delete`, `find … -exec rm {} \;`, `git branch -D main`,
`git branch -m main old`, `git diff --output=/tmp/x.patch` and `git log --output=/tmp/log.txt`
all classify `safe — read-only command` and run without a prompt in `default` and `auto`.
Close those escapes with a per-command mutating-argument rule while keeping the whitelist
principle intact.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-053 (Priority 74).

## Requirements

- R1. Keep the whitelist principle exactly: the metacharacter check, per-segment evaluation,
  `SAFE_BASH_COMMANDS` and `SAFE_GIT_SUBCOMMANDS` stay as they are. No new commands are added
  to either set.
- R2. A segment whose first word is whitelisted is still `dangerous` — with a `riskReason`
  naming the offending option — when any argument is a known mutating option for that command:
  - `find`: `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`
  - `git branch`: `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `-u`, `--set-upstream-to` (also
    `--set-upstream-to=…`), `--unset-upstream`, `--edit-description`, `--delete`, `--move`,
    `--copy`; combined short flags such as `-Df` / `-fD` count as mutating
  - `git log`, `git diff`, `git show`: `--output` and `--output=…`
- R3. The argument rule is applied per segment: each `|`/`&&`/`||`/`;` segment is checked on
  its own, so one mutating segment makes the whole command `dangerous`.
- R4. Every currently-safe read-only form stays `safe`, at minimum: `ls -la`, `cat <file>`,
  `rg foo | head -5`, `git log --oneline -5`, `git branch --show-current`, `git branch -a`,
  `git branch --list`, `git diff --stat`, `git show HEAD --stat`, `find . -name '*.ts'`,
  `find . -type f -newer x`.
- R5. Wildcard allow-rules (`src/agent/permission-rules.ts`) are user-authored and keep their
  exact matching behaviour; the `auto` classifier path, `plan` denial and all other permission
  logic are unchanged.
- R6. The user guide (`docs/user-guide/permissions.md`, `permissions.zh-CN.md`) and the
  static-safety contract in `.trellis/spec/backend/strands-sdk-contracts.md` state the argument
  rule where they describe the read-only allowlist (existing sections, no new section).
- R7. Verification is offline: the covering suite is in `pnpm test` and makes no model or
  network call.

## Acceptance Criteria

- [ ] AC1. The six probe commands classify `dangerous` and the reason names the option.
- [ ] AC2. Every still-safe form in R4 classifies `safe`.
- [ ] AC3. Combined short flags (`-Df`, `-fD`) and the `=`-joined spellings
  (`--set-upstream-to=x`, `--output=x`) are caught.
- [ ] AC4. A mutating option in a later piped/chained segment makes the command `dangerous`.
- [ ] AC5. Docs and spec state the argument rule.
- [ ] AC6. `pnpm typecheck` clean; `pnpm test` exit 0 with zero FAIL lines.
- [ ] AC7. Commits follow the repository convention; task archived; `git status --porcelain`
  clean.

## Requirement-to-test checklist

| Requirement | Proof |
|---|---|
| R1 whitelist sets unchanged | `git diff src/agent/permission.ts` shows no edit to `SAFE_BASH_COMMANDS` / `SAFE_GIT_SUBCOMMANDS`; existing `staticRules()` asserts in `spike/verify-permission-modes.ts` (safe list + `git push`, chained write, redirection, substitution, backticks, not-allowlisted, empty) stay green |
| R2 six probes dangerous, reason names option (AC1) | `spike/verify-permission-modes.ts` `staticRules()`: new `mutatingArgs` table asserting `risk === 'dangerous'` and `riskReason.includes(option)` |
| R2 combined short flags + `=` spellings (AC3) | Same table: `git branch -Df x`, `git branch -fD x`, `git branch --set-upstream-to=origin/main`, `git diff --output=/tmp/x.patch`, `git log --output=/tmp/log.txt`, `git show --output=/tmp/s.txt HEAD` |
| R3 per-segment (AC4) | Same table: `ls \| find . -delete`, `git status && git branch -D main` |
| R4 still-safe forms (AC2) | `safeBash` list in `staticRules()` extended with every R4 form |
| R5 rules/classifier unchanged | Unchanged `spike/verify-permissions-command.ts`, `spike/verify-permission-mode-switch.ts`, rule assertions in `verify-permission-modes.ts`, all in `pnpm test`; `permission-rules.ts` untouched (`git diff --stat`) |
| R6 docs + spec (AC5) | `rg -n "\-delete" docs/user-guide/permissions.md docs/user-guide/permissions.zh-CN.md .trellis/spec/backend/strands-sdk-contracts.md` shows the rule in the static-safety sections |
| R7 offline (AC6) | `verify-permission-modes.ts` is already in `spike/run-tests.ts`; `pnpm test` runs with no network |
| AC7 | `git log --oneline`, `python3 .trellis/scripts/task.py archive`, `git status --porcelain` |

## Constraints

- Mutations limited to `src/agent/permission.ts`, `spike/verify-permission-modes.ts`,
  `docs/user-guide/permissions*.md`, `.trellis/spec/**`, `.trellis/tasks/**`,
  `.trellis/workspace/**`, and (if needed) `docs/architecture/load-bearing-decisions.md`.
- No new dependencies; no SDK patch changes; no `docs/research/**` / `docs/iteration-log.md`.
- `spike/verify-classifier.ts` is a live (model-calling) suite, so the offline assertions go
  into `spike/verify-permission-modes.ts`, which already exercises `assessRisk` static safety.
