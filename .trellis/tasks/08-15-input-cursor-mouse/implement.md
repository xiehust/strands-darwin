# Implementation plan — Editable input cursor and mouse positioning

## Ordered checklist

1. Add pure prompt-editor helpers for grapheme boundaries, cell width, visual rows, cursor movement, insertion/deletion, and click hit-testing.
2. Add a focused offline verification script covering ASCII, explicit LF rows, terminal wrapping, resize, CJK, emoji, combining sequences, Home/End, preferred-column Up/Down, and click clamping.
3. Replace `App`'s draft-only mutation with atomic draft/cursor state and route keyboard, paste, continuation, completion, and clearing through it.
4. Change `InputBox` to render computed visual rows and place Ink's real terminal cursor at the computed output coordinates.
5. Add the SGR click adapter with TTY-gated setup/cleanup, report consumption, primary-button filtering, and input-row coordinate mapping.
6. Extend `spike/tui-driver.ts` only as needed to inspect raw control sequences and send clicks; add a zero-model cursor/mouse scenario to `spike/verify-tui.ts`.
7. Update `.trellis/spec/frontend/tui-testing.md` with the executable editor/mouse contract learned by the implementation.

## Validation commands

```bash
pnpm typecheck
pnpm test
pnpm tsx spike/verify-tui.ts cursor
pnpm tsx spike/verify-tui.ts multiline
pnpm tsx spike/verify-tui.ts chunkedEnter
pnpm tsx spike/verify-tui.ts completion
```

Run `pnpm build` if source module structure or package imports change.

## Risk and rollback points

- **Mouse teardown:** a missed cleanup leaves the shell emitting escape reports. Prove both enable and disable sequences through the real PTY before considering the feature complete.
- **Ink input parser:** Ink passes SGR reports to `useInput` without the initial ESC. Consume the exact complete report before printable input handling; malformed/partial reports must not mutate the draft.
- **Geometry drift:** `<Static>` output changes the viewport origin. Restrict click mapping to the bottom-anchored live input rows and verify after history exists, not only at startup.
- **Unicode width:** movement uses grapheme boundaries while geometry uses display cells. Keep both in one pure layout contract and test narrow, wide, combining, and joined emoji cases.
- **Regression surface:** Enter and Up/Down already have special completion/multiline semantics. Existing PTY scenarios are mandatory, not optional smoke tests.
