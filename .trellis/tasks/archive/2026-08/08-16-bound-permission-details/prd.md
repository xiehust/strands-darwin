# Bound permission details by rendered size

## Goal

Keep every permission decision reachable and truthful in a 120×50 terminal by bounding untrusted permission summaries and detail values by logical lines and Unicode code points, with explicit omission text.

## Background

`src/tui/PermissionPrompt.tsx` currently limits detail values to 14 LF-delimited lines. A minified command, JSON value, or replacement line can therefore wrap into unbounded terminal rows and push the `allow?` decision row out of the live frame. Bash summaries repeat the untrusted first command line and need the same class of presentation bound.

## Requirements

- Bound permission detail values to 14 logical lines and 500 Unicode code points.
- Bound permission summaries to one logical line and 160 Unicode code points.
- Preserve short projected values textually unchanged, including empty and whitespace-only strings.
- Preserve complete Unicode code points at truncation boundaries.
- Make every truncation explicit and state omitted code points and, when applicable, omitted logical lines.
- Keep the truncation marker itself inside the declared line and code-point caps.
- Keep the source label, bounded summary, detail labels and prefixes, `allow?`, y/n keys, and both available rule options visible together in the settled newest frame of a real 120×50 pty permission prompt.
- Keep the change presentation-only. Do not change `PermissionGate`, `PermissionQueue`, decision keys, persisted allow rules, or raw/model-visible tool input.
- Keep approval and denial semantics unchanged.

## Acceptance Criteria

- [ ] A focused pure projection suite covers a huge single line, many lines, composed bounds, Unicode boundaries, explicit omission text, marker-inclusive caps, bounded summaries, and unchanged short/empty/whitespace details.
- [ ] `spike/verify-tui.ts approve` inspects the settled newest 120×50 permission frame and proves source plus bounded summary, detail prefix plus explicit marker, `allow?`, y/n, and both rule options coexist.
- [ ] Pressing `y` in that pty scenario writes the exact requested file content.
- [ ] Existing direct permission tests continue to prove denial leaves the call blocked.
- [ ] `pnpm typecheck`, `pnpm test`, the focused pure test, the approve pty scenario, `git diff --check`, and Trellis task validation pass.

## Out of Scope

- Permission risk classification, queuing, keyboard ownership, decision semantics, and rule persistence.
- Model-visible or raw tool input mutation.
- Additional model-driven denial scenarios.
- Changes to `docs/research/**` or `docs/iteration-log.md`.
