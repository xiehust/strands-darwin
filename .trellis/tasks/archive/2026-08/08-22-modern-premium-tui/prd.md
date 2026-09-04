# Modern premium TUI redesign

## Goal

Make Darwin’s existing Ink coding-agent interface feel premium, modern, calm, and intentionally designed while preserving the speed and clarity of its terminal-native conversational workflow.

## Confirmed repository evidence

- Darwin is a single-screen, scrollback-first conversational TUI. Completed user, assistant, tool, and notice entries are committed through Ink `<Static>`; only the live answer, active tools, queue, permission prompt, header, and composer redraw.
- The TUI already has a centralized semantic vocabulary in `src/tui/visual-language.ts`, stable non-color markers, a compact status-first header, an animated pre-App startup surface, responsive prompt/completion rendering, and a rounded permission modal.
- The live frame has a load-bearing shared row budget. New permanent rows or uncounted wrapping can trigger Ink whole-screen clears and destroy scrollback. Only the header is measured; all other live surfaces must use the existing claims/planners and one counted `<Text>` per visual row.
- Existing frontend contracts require color to remain optional, critical states to survive ANSI stripping, `mode:` to appear exactly once, cache/effort to stay on the model line, and the baseline header to remain at most eight visual rows at 80 columns.
- Existing interactions, cursor geometry, completion/recall precedence, permission decisions, queue behavior, and `<Static>` transcript ownership are extensively covered by deterministic render, frame-budget, and real-PTY suites.
- Prior SER-016 work established the current visual language; SER-034 improved informational contrast and SER-035 added the responsive startup screen. This redesign must build on those accepted surfaces rather than replacing their architecture.

## Requirements

- Preserve Darwin’s scrollback-first conversational shell and apply evolutionary polish rather than introducing a structurally different application shell.
- Establish a more restrained, cohesive visual hierarchy across startup, ready header, transcript, composer, completion menus, active/completed tools, queued work, and permission states.
- Give Darwin a modern welcome header when an interactive session first becomes ready: a hand-maintained geometric block `DARWIN` wordmark above the initial prompt, rather than a dashboard-style front page. Wide terminals show the approved five-line wordmark, medium terminals use a compact three-line form, and narrow/short terminals fall back to `◆ DARWIN`; no variant may wrap or truncate.
- Commit the welcome header exactly once to terminal scrollback when the ready App mounts, then keep only the compact header in the redrawn live frame. The wordmark must never consume the ongoing frame budget or disappear through an Ink frame handoff.
- Show the welcome wordmark once per interactive process startup for both fresh and `--resume` launches. Do not repeat it when `/clear` creates a successor session inside the same process; on resume, retain the existing read-only recap after the welcome.
- Use a monochrome-first palette with one primary accent plus semantic success/warning/error roles; never rely on color alone and remain legible on dark and light terminal themes.
- Improve spacing, alignment, labels, emphasis, and component rhythm without decorative border proliferation or visual noise.
- Preserve all existing workflows, keybindings, content, safety information, responsive behavior, frame-budget guarantees, and terminal scrollback semantics unless explicitly approved otherwise.
- Keep semantic presentation centralized and components composable; do not introduce product-domain state into visual helpers.
- Add no dependency, model/network call, raw terminal renderer, configurable theme system, or unrelated behavior change.
- Provide before/after terminal mockups in the technical design and update deterministic visual assertions plus the executable frontend specification.

## Acceptance Criteria

- [x] At representative ready, streaming/tool, completion, permission, and transcript states, the primary action/content is visually dominant and secondary metadata is consistently subdued.
- [x] Each fresh or resumed interactive process startup shows one large responsive `DARWIN` wordmark in scrollback before the initial prompt; it is absent from the redrawn live frame, precedes the existing resume recap when present, and does not repeat during ordinary turns or `/clear`.
- [x] ANSI-stripped output still distinguishes every critical role/state and preserves all required text and decisions.
- [x] The redesign adds no baseline header rows, no unbudgeted live rows, and no frame reaching terminal height across existing frame-budget checks.
- [x] Composer focus, completion selection, active work, warnings/errors, and permission decisions remain unmistakable with and without color.
- [x] Narrow and short terminals degrade truthfully without overflow, hidden controls, or cursor drift.
- [x] Existing free real-PTY interaction scenarios and focused startup/visual/frame suites pass unchanged except for intentional presentation assertions.
- [x] `pnpm typecheck`, `pnpm test`, Trellis validation, and `git diff --check` pass.
- [x] Frontend specs and user-facing visual examples reflect the accepted design.

## Out of scope

- Changing the SDK loop, domain behavior, command semantics, permission policy, trajectory/replay bytes, or session lifecycle.
- A multi-pane dashboard, alternate-screen transcript replacement, mouse-required interaction, or web-style navigation unless explicitly brought into scope.
- User-configurable themes, custom keybindings, new commands, or a framework migration.
