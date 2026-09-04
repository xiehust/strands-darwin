# PRD — Permission approval modes: default / auto / yolo

## Background

Today the `PermissionGate` (`src/agent/permission.ts`) has exactly one behavior:
`read` calls run silently, every `write`/`execute` call prompts the user. There is no
notion of "how much confirmation do I want" — a user running a trusted refactor gets the
same prompt storm as a user auditing an unknown repo.

## Requirement

Introduce a **permission mode** with three levels, selected via `.darwin/config.json`
and overridable on the CLI:

| Mode | Behavior |
|------|----------|
| `default` | Static rules decide safety. Calls that are *provably safe* run without asking; everything else (dangerous or unknown) prompts the user. |
| `auto` | Same static rules first; calls the rules cannot clear are judged by a **model-based safety classifier**. Classifier says safe → run; says dangerous, errors, or times out → prompt the user (fail-closed). |
| `yolo` | Everything runs without prompting. Tool calls still render in the TUI as usual. |

`default` is the out-of-the-box mode (config absent / key absent).

## Definitions

**"Provably safe" (static rules, fail-closed — anything not on this list is dangerous):**
- All `read`-classified calls (current behavior, unchanged).
- `fileEditor` writes whose resolved path is inside the project root AND not a sensitive
  location (`.git/` internals, `.env*` files, `.darwin/config.json` — the agent must not
  silently rewrite its own permission mode).
- `bash` commands where *every* segment (split on `&&`, `||`, `;`, `|`, newline) starts
  with a read-only allowlisted command (`git status/log/diff/show/branch`, `ls`, `cat`,
  `head`, `tail`, `grep`, `rg`, `find`, `pwd`, `which`, `wc`, `echo`) and the command
  contains no redirection/substitution metacharacters (`>`, `<`, `` ` ``, `$(`).
- Unknown tools (all MCP tools) are never provably safe.

## Constraints

- The SDK agent loop is never forked; everything stays inside the existing
  `InterventionHandler.beforeToolCall` seam.
- `PermissionBridge` contract is unchanged (TUI `PermissionQueue` keeps working as-is).
- Denial semantics unchanged: `InterventionActions.deny(...)`, never `confirm()`.
- Classifier failure must degrade to *asking*, never to silent approval
  (per `.trellis/spec/backend/error-handling.md` fail-closed convention).
- Config validation follows the existing `ConfigError` style: bad `permissionMode`
  refuses to start with a fix hint.
- The classifier call happens inside `beforeToolCall` (awaited serially by the SDK), so
  it must be bounded by a timeout and only invoked for calls static rules cannot clear.

## Acceptance criteria

1. `pnpm typecheck` and `pnpm test` pass; new fast suite `spike/verify-permission-modes.ts`
   (no model calls) covers: risk classification table (bash allowlist, path containment,
   sensitive paths, unknown tools) and gate decisions per mode with a fake bridge/classifier.
2. `default` mode: `git status` via bash and an in-project `fileEditor str_replace` run
   without prompting; `rm -rf /tmp/x` and any MCP tool prompt.
3. `auto` mode: a static-unsafe call goes to the classifier; classifier-safe verdict runs
   without prompting; classifier-unsafe / thrown / timed-out verdicts prompt the user.
4. `yolo` mode: nothing prompts.
5. Invalid `permissionMode` in config → startup fails with a `Configuration problem:`
   message naming the valid values.
6. CLI: `--permission-mode <m>` and `--yolo` override the config value.
7. TUI header shows the active mode; the prompt box shows why a call was flagged.
8. Pty scenarios `approve` / `deny` still pass after adaptation: under the new `default`
   semantics an in-project file edit no longer prompts, so these scenarios must gate on
   a call that *is* dangerous under `default` (e.g. a non-allowlisted bash command).
