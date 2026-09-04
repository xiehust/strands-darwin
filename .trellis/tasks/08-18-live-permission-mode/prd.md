# Switch the permission mode inside a running session (SER-013)

## Goal

The approval mode is **live session state**, not a launch argument. The user can switch it mid-run
(`/mode <name>`), the effective mode is always visible in the header's existing row, and no decision
that was already in flight is ever resolved under a mode that would not have asked for it.

Explicitly *not* this task: persisting the mode, a per-tool permission editor, user deny-rules, or a
headless surface for changing enforcement.

## Background — what the code was before

- `ApprovalMode = default | auto | plan | yolo` was fixed at `Agent` construction: it arrived from
  `config.permissionMode` or `--permission-mode`/`--yolo` (`src/cli-args.ts`), was handed to
  `PermissionGate` once, and every decision read `this.options.mode`. `rg 'setMode|changeMode'`
  found only `AgentRuntime.changeModel`.
- So the plan denial that tells the model to "ask the user to run outside plan mode before changing
  or executing anything" could only be obeyed by killing the process.
- Three independent peers treat approval policy as runtime state with a persistent indicator
  (Claude Code `Shift+Tab` + mode indicator, Codex `/permissions` + `/status`, OpenCode palette
  toggle) — sources S1–S4, S7, S8 in `docs/research/research_2026-08-18.md` (run `01:25:31Z`).
- Darwin already changes session-scoped policy live in three shapes: `/effort` →
  `Model.updateConfig()`, `/model` → `AgentRuntime.changeModel`, `/clear` → successor runtime.

## Requirements

1. **User-only.** No tool, no config read-back, no model output can change the mode. The two entry
   points are the TUI submit handler and the dev REPL input loop, both fed by the keyboard.
2. **Session-scoped.** Nothing is written to `~/.darwin/config.json`. Unlike `/effort`, this changes
   *enforcement*, and a persisted widening is what the allow-rule exemptions exist to prevent. A
   fresh process starts from configured/CLI policy again.
3. **Plan ordering untouched.** The plan guard still runs before configured Pre hooks, allow-rules,
   the `auto` classifier and the bridge, for parent *and* child agents, when plan is entered
   mid-session. Unknown/MCP tools stay fail-closed as `execute`.
4. **No in-flight decision resolved under a mode that would not have asked** (see decisions below).
5. **No added frame row.** The header's existing mode row moves; nothing is added.
6. No regression of SER-001 plan mode, SER-010 keyboard ownership, the `/clear` successor contract,
   or the shared-intervention subagent contract.

## Decisions

- **Surface: `/mode [name]`**, an eleventh built-in (`MAX_COMPLETIONS` 10 → 11 so every built-in
  stays visible). Bare reports and lists the modes; a valid name switches; an unusable argument
  changes nothing, names the valid values, and never falls through to the model — the `/effort`
  and `/model` style. Handled **before** the busy check, like `/effort`: mid-turn is exactly when
  enforcement needs changing, and it sends nothing and rebuilds nothing. No key binding: a
  `Shift+Tab`-style cycle would have to be live while the permission box owns the keyboard
  (SER-010), and a second way to do the same thing is a second thing to keep true.
- **Where the value lives: the gate.** `PermissionGate.mode` / `setMode()`; `AgentRuntime`
  exposes `permissionMode` and `changePermissionMode()` as a thin delegation. The gate stays the
  single decision point, so the intervention shared with children sees the new value with no
  further plumbing. `info.permissionMode` keeps its old meaning — the effective *startup* mode,
  which is what the trajectory run record and the headless report state.
- **In flight — a classifier verdict:** *discarded*, and the call re-decided from the top under the
  new mode. The verdict answers "may `auto` skip the prompt", a question only `auto` asks. Claude
  Code documents the same rule (S1).
- **In flight — a prompt on screen or queued:** *withdrawn*. `AssessedPermissionRequest.withdrawn`
  is an `AbortSignal`; `PermissionQueue` drops the entry so the question cannot stay on screen, and
  the gate re-decides the call. A bridge that ignores the signal is not unsafe — the gate discards
  the answer either way — it merely leaves a stale question up.
- **One rule for every transition**, not a table of benign ones: `default → auto` could also have
  been left alone, but "which transitions are safe to keep" is where the bug would live.
- **The mode in force when the decision is *applied* is the mode that decided.** An answer that
  settles in the same tick as the switch is discarded too, which is why the race re-checks
  `aborted` after the promise settles. In the TUI the two cannot collide: the permission box owns
  the keyboard, so `/mode` is not typable while a prompt is up.
- **A tool already executing is not retroactively stopped**, and a Pre hook that already ran is not
  un-run. Entering plan mid-flight guarantees the tool body does not run and no further call gets
  past the guard.
- **Bounded by construction:** 16 re-decisions of one call, then a deny that says why. Every restart
  costs a deliberate keystroke, so this is unreachable; it exists so the loop is not bounded by an
  argument about human behaviour.
- **`/clear` carries the live mode into the successor.** Restoring the startup policy would be a
  *widening* the user never asked for; a fresh process still reads config/CLI.
- **Reachable in the dev REPL, not in headless.** The REPL is how the runtime is exercised without
  Ink, and enforcement is worth exercising there. Headless is one-shot and non-interactive: the
  only actor able to type is the model, which is exactly who may not change the mode.
- The classifier is now built for **every** run, since `/mode auto` can arrive mid-session. It was
  already free — the closure defers building its model to the first call.

## Acceptance Criteria

- [x] The mode is switchable mid-session from user input and from nowhere else; a model-driven
      attempt changes nothing and is gated.
- [x] Every transition shows in the existing header row, with no added frame row
      (`spike/verify-tui.ts approve` at 120x50, plus `mode`'s own row/height assertions).
- [x] Entering `plan` mid-session denies a write/execute before hooks, rules, the classifier and the
      bridge, for parent and child.
- [x] Leaving `plan` mid-session puts the call back through the ordinary gate.
- [x] A queued prompt and an in-flight classifier check are never resolved under a mode that would
      not have asked — proven in `spike/verify-permission-mode-switch.ts`.
- [x] Nothing is written to `~/.darwin/config.json`.
- [x] `pnpm typecheck`, `pnpm test`, the focused permission suites, `spike/verify-tui.ts mode`,
      `completion`, `clear` and `approve` all pass.
