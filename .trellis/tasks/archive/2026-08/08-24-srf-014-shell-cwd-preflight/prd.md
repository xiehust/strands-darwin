# SRF-014 foreground shell cwd preflight

## Goal

Make the persistent foreground bash shell's effective cwd visible and prevent the narrow, evidenced class of accidental project-root-relative path launches after shell cwd has persisted elsewhere.

## Requirements

- Every foreground `execute` result reports the shell's effective cwd after the command; restart reports the reset cwd. Exit/replacement failures retain truthful cwd alongside existing metadata.
- The session project root comes from `AgentRuntime`'s verified `projectRoot` option, never a new Darwin-side `process.cwd()` call.
- Before launching a likely project-root-relative command path, refuse non-mutatingly only when the first relevant relative path is absent under effective cwd and present under the session project root. Name cwd, both resolved paths, and an actionable root-relative correction.
- Keep preflight deliberately narrower than shell parsing: cover the evidenced simple `cd relative/path` and command-position `./path` or `path/with/slash` shapes; fail open for compound/quoted/escaped commands, options, redirections, substitutions, absolute paths, bare PATH commands, and unrelated arguments.
- Existing cwd-relative paths still execute. Paths absent in both locations retain ordinary shell errors. A preflight refusal neither writes to the shell nor mutates persistent state.
- Preserve ordinary shell persistence, per-Agent foreground serialization, raw permission/hook input, execute/restart compatibility, exit-0 replacement, nonzero/signal metadata, background modes/wait, and process-group/runtime cleanup.
- Add no dependency and use no model/network call for acceptance.

## Acceptance Criteria

- [x] Real foreground bash/Agent coverage proves cwd after initial execution, after `cd`, and after restart.
- [x] A root-existing/cwd-missing `cd backend`, `./start.py`, or slash-containing command path is refused before launch with cwd, both locations, and a correction; a side-effect canary proves no launch/mutation.
- [x] Existing cwd-relative paths execute; missing-in-both paths produce ordinary bash output; absolute paths, PATH commands, unrelated arguments, quotes, options, redirections, substitutions, and background modes remain unintercepted.
- [x] Restart, exit-0 replacement, nonzero/signal metadata, foreground serialization, permissions/hooks raw input, background wait/modes, and process cleanup remain green.
- [x] The pinned SDK patch, TypeScript declarations, runtime assembly, SDK/error contracts, architecture rationale/index, focused offline suite, task artifacts, and journal are updated.
- [x] Focused checks, typecheck, one full `pnpm test`, `pnpm build`, and Trellis validation pass before commit/archive.
