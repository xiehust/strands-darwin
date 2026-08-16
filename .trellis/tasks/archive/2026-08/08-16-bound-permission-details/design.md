# Design — bounded permission presentation

## Boundary

The change lives entirely in TUI presentation. The permission request continues to carry its original `summary`, `details`, and raw `input`; projections are computed only when rendering the prompt.

## Projection contract

Add permission-specific projections beside the accepted line+code-point tool projection in `src/tui/tool-detail-presentation.ts`:

- Summary: head projection, one logical line, 160 Unicode code points total.
- Detail: head projection, 14 logical lines, 500 Unicode code points total.
- Untruncated input returns exactly as received, including empty and whitespace-only strings.
- Truncated output ends with an explicit marker describing omitted Unicode code points and omitted logical lines.
- The marker consumes the declared code-point and line budgets; retained content is shortened as needed to make room.

A permission-specific helper is preferable to calling `boundText()` directly because tool previews intentionally collapse blank text and currently add their marker beyond the content budget. Permission approval requires exact short-value preservation and a strict marker-inclusive cap.

## Rendering

`PermissionPrompt` renders the bounded summary after the existing source label and maps each bounded detail projection under its existing label. Heading, risk reason, queue count, source, labels, option row, and key handling remain unchanged.

## Verification

A focused pure suite validates projection invariants without Ink. The existing model-driven approve scenario requests a deliberately oversized one-line replacement, waits for the permission tail, then inspects `tui.screen` (the virtual terminal's newest frame, not accumulated raw output) for every safety-critical element before approving and checking exact disk content.

## Compatibility and rollback

No data model, SDK loop, permission semantics, persistence, or model-visible content changes. Rollback is limited to the presentation helper, prompt wiring, tests, and contract text.
