# Current Darwin TUI audit

## Scope inspected

- `src/tui/App.tsx`, `StartupScreen.tsx`, `MessageList.tsx`, `InputBox.tsx`, `PermissionPrompt.tsx`, `ToolCallPanel.tsx`, `QueuedMessages.tsx`, `visual-language.ts`
- `.trellis/spec/frontend/live-frame.md` and `tui-testing.md`
- `docs/architecture/load-bearing-decisions.md` § TUI frame budget and adjacent visual contracts
- `spike/verify-visual-language.tsx`, `verify-frame-budget.ts`, `verify-startup-screen.tsx`, and `verify-startup-pty.ts`
- Archived SER-016, SER-034, and SER-035 task artifacts
- TUI design references for visual hierarchy, color, interaction, components, responsive behavior, and state feedback

## Baseline assessment

| Area | Score | Evidence |
| --- | ---: | --- |
| Visual hierarchy | 4/5 | Explicit role markers, status-first header, and semantic warnings are strong; green assistant, blue tool, and cyan identity/selection create more competing accents than the content needs. |
| Layout and resilience | 5/5 | One measured header plus a shared row budget protects scrollback; prompt, tools, queue, answer, and modal have truthful bounded projections. |
| Interaction | 5/5 | Keyboard ownership, completion, recall, queue take-back, real cursor, and modal decisions are explicit and tested. |
| State feedback | 4/5 | Loading, busy, tool, permission, warning, and error states are clear. The settled first impression remains the same compact operational header as every later frame. |
| Accessibility | 4/5 | Stable textual markers survive ANSI stripping and named ANSI colors avoid theme assumptions. Heavy inverse styling in the composer and completion row is visually loud and dependent on terminal reverse-video treatment. |
| Architecture | 5/5 | Domain/runtime state, pure geometry, reducers, presentation helpers, and Ink components already have strong boundaries. |

The redesign should not replace this architecture. Its highest-value opportunities are a deliberate ready-state welcome, a single brand accent, and calmer focus styling.

## Load-bearing constraints

1. Completed transcript belongs to `<Static>`; the ongoing live frame must stay below terminal height.
2. The large welcome cannot become measured header furniture. It must be a one-shot static projection owned by the initial App mount.
3. `/clear` swaps the runtime without remounting App; the welcome must be a presentation-only first item in `MessageList`'s initial `<Static>` epoch, then omitted when the successor epoch remounts that owner.
4. Resume recap is initial `MessageList` history. Prefixing the shared Static item list with the welcome gives the intended welcome → recap → prompt order without adding trajectory or replay records.
5. Critical distinctions must remain in text: `you>`, `darwin>`, `tool ·`, notice markers, `❯`, permission kind/reason/source, and decision keys.
6. Named ANSI colors only; no truecolor assumptions, background fills, or color-only meaning.
7. Prompt geometry stays five columns and selection/key ownership does not change.

## Recommended visual direction

- **Brand:** cyan as the sole non-semantic accent for identity, assistant, tool identity, active work, selection, and informational markers.
- **Semantic states:** green only for success/addition, yellow for warning/permission/denial, red for error/removal.
- **Focus:** textual markers plus bold/accent; remove reverse-video blocks from the composer prefix and selected completion to reduce visual weight and avoid background-theme variance.
- **Spacing:** preserve existing row counts and margins. Improve rhythm through consistent emphasis, not added blank rows or borders.
- **Welcome:** hand-maintained five-line geometric `DARWIN` at wide sizes, compact three-line wordmark at medium sizes, `◆ DARWIN` at narrow/short sizes. One muted tagline and one blank margin may accompany it only when the selected size fits.
- **Operational header:** remain compact and status-first. Do not duplicate the large wordmark or add rows after startup.
- **Permission:** retain the rounded modal and yellow heading because it is a real safety interruption; keep body neutral and decisions explicit rather than adding decorative treatment.

## Proposed before / after

### Ready state — before

```text
◆ DARWIN · ready
bedrock/us.anthropic.claude-sonnet-4-6 · session session-… · cache 5m · effort high
mode: auto · 2 allow rules
AGENTS.md: loaded (4.0 KB)
loaded: 3 skills · 2 commands · 2 agents · 2 MCP servers · type / for commands
/ for actions · @ for paths · ctrl+c cancels · /exit quits

you>
```

### Ready state — after initial handoff

```text
██████╗  █████╗ ██████╗ ██╗    ██╗██╗███╗   ██╗
██╔══██╗██╔══██╗██╔══██╗██║    ██║██║████╗  ██║
██║  ██║███████║██████╔╝██║ █╗ ██║██║██╔██╗ ██║
██║  ██║██╔══██║██╔══██╗██║███╗██║██║██║╚██╗██║
██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║██║ ╚████║
              coding through iteration

◆ DARWIN · ready
bedrock/us.anthropic.claude-sonnet-4-6 · session session-… · cache 5m · effort high
mode: auto · 2 allow rules
AGENTS.md: loaded (4.0 KB)
loaded: 3 skills · 2 commands · 2 agents · 2 MCP servers · type / for commands
/ for actions · @ for paths · ctrl+c cancels · /exit quits

you>
```

The wordmark is committed once. Subsequent redraws and turns contain only the compact operational header.

### Completion focus — before / after

```text
before: inverse `you> ` block and inverse `❯ /mode` row
after : cyan bold `you> ` marker and cyan bold `❯ /mode`, with no background inversion
```

The textual markers remain identical, but focus becomes calmer and more consistent across light and dark terminal themes.

## Verification impact

- Extend deterministic visual coverage with welcome variants, line-width bounds, one-accent forced-color assertions, and no-inverse composer/selection assertions.
- Extend real-PTY startup coverage to prove welcome ordering, settled-frame absence, once-only behavior after local commands, resume ordering, and no repeat after `/clear`.
- Re-run frame arithmetic/render checks and all free interaction scenarios affected by header/composer/startup rendering.
