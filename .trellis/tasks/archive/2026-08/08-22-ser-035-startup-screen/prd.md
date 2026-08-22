# SER-035 responsive animated startup screen

## Goal

Render a bounded animated pre-App startup surface during runtime and resume initialization, then hand off cleanly without delaying readiness.

## Requirements

- Render an Ink-owned startup surface before `AgentRuntime.create()` begins and keep it live through resumed-session recap loading.
- Show a compact Darwin/evolution motif whose changing frames truthfully mean initialization is still pending; switch the text to recap restoration only when that work begins.
- Replace the startup surface on the same Ink instance with the ordinary `App` immediately after real initialization finishes. Do not add a minimum display delay or modify the settled App frame.
- Keep the startup frame below terminal height and provide a one-row narrow/short fallback. Colour may enhance, but stable text/symbols must communicate identity and state without ANSI.
- Clean up the animation interval on handoff, startup failure, and unmount. The startup component must not register input handlers or write raw terminal bytes.
- Preserve existing configuration and missing-session error semantics, runtime shutdown ownership, resume recap behavior, trajectory/session bytes, and free offline operation.

## Acceptance Criteria

- [x] Deterministic component coverage observes multiple distinct bounded frames, wide and narrow/short layouts, stable non-colour state markers, and interval cleanup after unmount/handoff.
- [x] A delayed-runtime real-pty fixture sees startup output before runtime readiness, sees motion while pending, and sees no startup marker after handoff.
- [x] The settled pty has exactly one ordinary ready header and one usable prompt; submitted local input still works.
- [x] Offline pty error and resumed-session paths cleanly remove startup, preserve existing error/recap behavior, make no provider call, and leave trajectory/session fixtures byte-identical.
- [x] Focused startup, frame-budget, visual-language, and applicable free pty startup/completion/clear/resume checks pass.
- [x] `pnpm typecheck` and one final full `pnpm test` pass after source settles.

## Non-goals

- No permanent ready-header animation, new settled-frame row, splash transcript entry, raw terminal renderer, provider progress claim, or configurable theme/duration.
- No live model/provider call, dependency addition, SDK-loop change, or unrelated visual redesign.
