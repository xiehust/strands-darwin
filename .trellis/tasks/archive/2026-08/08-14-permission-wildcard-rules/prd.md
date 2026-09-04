# Permission wildcard rules persisted to config

## Goal

Let the user answer a permission prompt with "always allow calls like this one" instead of
only y/n. The choice is stored as a wildcard rule in `.darwin/config.json`, so matching
calls proceed without a prompt in this and every later session.

## Requirements

### Rule format (`permissionRules.allow: string[]`)

- `"<toolName>:<pattern>"` — pattern matched per tool:
  - `bash:pnpm *` — matched against the command, `*` = any run of characters.
  - `fileEditor:src/**` — glob on the path (`**` crosses `/`, `*` does not).
- `"<toolName>"` (no colon) — every call of that tool. The only option offered for
  unknown/MCP tools, which have no parseable structure.
- Trailing ` *` also matches the bare prefix: `pnpm typecheck *` matches `pnpm typecheck`.

### Where rules are consulted

In `PermissionGate.beforeToolCall`, after the static `safe` check and **before** the
`auto`-mode classifier (a rule should save the model call, not just the prompt). `yolo` is
unaffected. A matched rule proceeds with reason `allowed by rule <rule>`.

### Safety boundaries (deliberate, not incidental)

1. No rule can allow a `fileEditor` write to `.darwin/config.json` or to an `.env*` file.
   Otherwise a broad rule lets the agent grant itself more rules.
2. A `bash` pattern rule is matched per chained segment (`&&`, `||`, `;`, `|`, newline);
   every segment must match, or the call still asks. And a command containing redirection
   or substitution (`>`, `<`, backtick, `$(`) never matches a pattern rule — same
   fail-closed reasoning as `assessBashRisk`.
   (Known limit: a bare `bash` whole-tool rule is the user asking for exactly that, and is
   not segment-checked. It is the yolo-for-bash option and is labelled as such.)

### Suggestions shown in the prompt

The gate attaches at most two suggestions to the request, specific first:

- `bash`: first word of the command + ` *`; for subcommand-style drivers (`git`, `pnpm`,
  `npm`, `npx`, `yarn`, `cargo`, `docker`, `go`, `uv`, `pip`, `python`, `python3`, `node`,
  `make`, `gh`, `kubectl`, `aws`, `poetry`) the first two words when the second is not a flag.
- `fileEditor`: the file's directory + `/**` (relative to the project root when inside it).
- unknown tools: none.

Plus the whole-tool suggestion, always last.

### UI

- `PermissionPrompt` keeps `allow? y / n` on one line and appends the options:
  `a always: pnpm *` and `A always: all bash calls`. One line only — the header shares the
  live frame with this box and one extra row pushes it off a 50-row terminal.
- `a` takes the specific suggestion, `A` the whole-tool one. With only one suggestion, only
  `a` is offered.
- After answering with a rule, the transcript gets a notice naming the rule and the file it
  was written to (or the failure).

### Persistence

- `appendAllowRule(projectRoot, rule)` in `src/config.ts`: read the raw JSON (missing file =
  `{}`), append to `permissionRules.allow` (dedupe, preserving every other key verbatim),
  write back with 2-space indent. Never serialize `AppConfig`, which would freeze today's
  defaults into the user's file.
- A rule takes effect in memory immediately (`PermissionGate.addAllowRule`), so a failed
  write costs the persistence, not the session. The failure is surfaced as a notice.
- Malformed `permissionRules` in the config is a `ConfigError` (config is explicit intent —
  same row as every other invalid value).

## Acceptance Criteria

- [ ] `spike/verify-permission-modes.ts` covers: rule match/non-match per tool, the
      segment and metacharacter rules for bash, the `.darwin/config.json` and `.env`
      exclusions, suggestion derivation, and that a rule is consulted before the classifier.
- [ ] `spike/verify-config.ts` covers: `permissionRules` load + validation errors, and an
      `appendAllowRule` round-trip that preserves unrelated keys and dedupes.
- [ ] `pnpm typecheck` and `pnpm test` pass.
- [ ] `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve` still passes — it is the
      only check that sees the header and the permission box in one frame.
- [ ] `.trellis/spec/backend/error-handling.md` gains the degradation rows for a failed rule
      write and an invalid `permissionRules`.

## Notes

- Not in scope: deny rules, per-session-only rules, dropping already-queued prompts that a
  new rule would match (they still ask; the rule applies to later calls).
