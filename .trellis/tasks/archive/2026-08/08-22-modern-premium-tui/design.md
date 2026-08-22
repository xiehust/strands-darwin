# Design

## Design intent

Evolve Darwin’s existing scrollback-first shell instead of replacing it. The redesign has two layers:

1. a one-shot branded welcome committed to terminal scrollback at interactive App handoff;
2. a calmer, single-accent treatment of the existing operational surfaces.

No domain state, key ownership, command behavior, frame participant, or transcript byte contract changes.

## Visual system

`src/tui/visual-language.ts` remains the only semantic palette and marker vocabulary.

| Role | Treatment |
| --- | --- |
| Brand / identity | cyan + bold, stable `◆` or wordmark text |
| User focus | cyan + bold `you>` marker, real cursor; no inverse background |
| Assistant | cyan + bold `darwin>` marker; answer body remains normal intensity |
| Tools | cyan `tool ·`; result icon carries success/warning/error semantics |
| Active/selection/info | cyan + bold/textual marker (`❯`, spinner, `info ·`) |
| Success / additions | green, always paired with `✓` or `+ ` |
| Warning / permission / denial | yellow, paired with text or `⊘` |
| Error / removals | red, paired with `✗`, `error !`, or `- ` |
| Metadata / hints | default foreground with dim emphasis |

This removes green assistant identity and blue tool identity as competing decorative colors. It also removes reverse-video blocks from the composer prefix and selected completion: focus remains explicit through stable text, cyan, bold, and the real terminal cursor.

## Welcome projection

Add an isolated `WelcomeHeader` component and pure `welcomeLayout(columns, rows)` helper.

### Variants

- **Wide:** when the terminal can safely show the complete 47-column wordmark and enough vertical context, render the approved five-line geometric block logo.
- **Medium:** render a hand-maintained three-line `DARWIN` wordmark.
- **Compact:** render one line, `◆ DARWIN`.
- Every line is chosen before rendering and uses one `<Text wrap="truncate-end">`; display-width thresholds guarantee the selected line fits, so truncation is defensive rather than expected. The initial layout value is captured once at App mount so terminal resize cannot mutate Static output already committed to scrollback.
- Wide/medium variants include one muted `coding through iteration` tagline and one closing margin. Compact mode has no extra line.

### Ownership and lifecycle

`App` supplies `WelcomeHeader` as the first presentation-only item in `MessageList`'s existing Ink `<Static>` owner. Verification confirmed that two adjacent `<Static>` owners do not commit independently during the handoff, so the reviewed rollback shape is the implementation. The welcome remains a dedicated component and typed layout value, not a turn-state or trajectory kind. Therefore:

- the welcome is written once when the ready App mounts;
- it is terminal output, not a turn-state `HistoryItem`, trajectory record, replay item, or model message;
- it precedes resume recap history because it is the first item in the shared static list;
- it is not measured by `headerRef` and never enters `frameBudget`;
- `/clear` changes `MessageList`'s static epoch and omits the welcome from the successor list, so it cannot repeat (the explicit terminal clear may remove the earlier scrollback bytes);
- ordinary state changes and spinner ticks do not redraw it;
- interactive startup still uses the same Ink instance and pre-App `StartupScreen`; headless mode remains unchanged.

## Component polish

### Compact operational header

Keep its current content, order, and row count. Use the unified accent for identity and leave status/metadata dim. No large logo appears here after initial commit.

### Transcript

Keep all existing markers and `<Static>` ownership. Identity markers become one accent; answer body and informational report bodies remain normal intensity. Success/warning/error colors remain semantic only.

### Composer and completion menu

Preserve the five-column `you> ` geometry, real cursor, draft windowing, menu planning, and textual `❯`. Remove `inverse` from the active prompt prefix and selected candidate; cyan + bold supplies focus without imposing a terminal background color.

### Tools, queue, and busy state

Keep row geometry, summaries, spinner, elapsed suffix, diff markers, and queued text unchanged. Tool identity uses the brand accent; semantic status stays on its icon. Queue and busy hints remain subdued until active content requires attention.

### Permission modal

Keep its rounded border, warning accent, exact information, geometry helpers, and decision row. This is intentionally the strongest interruption because it blocks the loop and protects a machine-changing action. No additional border, row, or background fill is introduced.

## Responsive before / after

### Wide startup handoff

Before:

```text
◆ DARWIN · ready
bedrock/us.anthropic.claude-sonnet-4-6 · session session-… · cache 5m · effort high
mode: auto · 2 allow rules
AGENTS.md: loaded (4.0 KB)
loaded: 3 skills · 2 commands · 2 agents · 2 MCP servers · type / for commands
/ for actions · @ for paths · ctrl+c cancels · /exit quits

you>
```

After initial handoff:

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

Only the compact block from `◆ DARWIN · ready` onward remains in the redrawn frame.

### Medium handoff

```text
█▀▄  ▄▀█  █▀█  █ █ █  █  █▄ █
█ █  █▀█  ██▄  █▄█▄█  █  █ ▀█
▀▀   ▀ ▀  ▀ ▀   ▀ ▀   ▀  ▀  ▀
       coding through iteration
```

### Narrow / short handoff

```text
◆ DARWIN
```

### Focus polish

```text
before  inverse you> /m
        inverse ❯ /mode

after   you> /m
        ❯ /mode
```

In the actual terminal the after-state markers are cyan and bold, while the draft and descriptions retain normal/muted intensity.

## Compatibility and rollback

- No dependency or config migration.
- No provider/model/network work.
- No headless output change.
- No trajectory, replay, export, or session-store change.
- `TERM=dumb`/no-color remains readable because wordmark and markers are text.
- Reverting `WelcomeHeader` and the small visual token/style changes restores the previous presentation without data migration.

## Verification design

1. Pure layout tests for wide/medium/compact welcome variants, exact row counts, and line widths.
2. Deterministic Ink rendering tests for welcome static output, unified accent, stable markers, and absence of reverse-video focus.
3. Existing frame-budget render/arithmetic suite proves no live-frame growth.
4. Offline real-PTY startup proves loading motion → one welcome → ready prompt, welcome absent from settled frame, local command does not repeat it, resume order is welcome then recap, and `/clear` does not repeat it.
5. Existing completion, path completion, recall, clear, mode, mcp, queue, bang, and tall-draft scenarios protect interaction ownership and responsive behavior.
