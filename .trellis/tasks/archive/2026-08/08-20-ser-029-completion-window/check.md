# Check — SER-029 completion selection window

## Implementation review

- `completionWindow` is a pure contiguous projection of the original candidate array around the normalized full-list selection; it neither sorts nor copies candidate identities.
- `InputBox` uses the existing `planPromptBox.completionItems` grant, draws one selected row, and spends the existing single overflow row on truthful total/above/below counts.
- Up/Down still wrap over the complete candidate array. An immediate selection ref and acceptance-time re-derivation from the immediate editor mirror keep batched terminal events aligned with the visible `❯` identity.
- No completion cap, frame claim, path scan/matcher, command ordering, keyboard branch order, dependency, or unbudgeted surface changed.
- Governing live-frame, prompt-completion, and TUI-testing specs now state the window, omission, acceptance, and verification contracts.

## Verification

Focused development checks:

- `pnpm tsx spike/verify-frame-budget.ts` — 75 passed, 0 failed; includes pure/render first, middle, last, wrapped, one-row, order, marker, omission, and full render-matrix checks.
- `pnpm tsx spike/verify-tui.ts completion` — 52 passed, 0 failed; overflowing slash Down+Tab and wrapped Up+Enter accept the visibly selected rows.
- `pnpm tsx spike/verify-tui.ts pathCompletion` — 23 passed, 0 failed; overflowing path Down+Tab and wrapped Up+Enter accept the visibly selected rows.
- `pnpm tsx spike/verify-tui.ts cursor` — 5 passed, 0 failed.
- `pnpm tsx spike/verify-tui.ts recall` — 20 passed, 0 failed.
- `pnpm tsx spike/verify-tui.ts recallEmpty` — 4 passed, 0 failed.
- `pnpm tsx spike/verify-tui.ts queue` — 17 passed, 0 failed.

Final gate after source/spec changes settled:

- `pnpm typecheck && pnpm test` — exit 0; complete project gate passed, including the 75-check frame-budget suite and all prompt/path/recall/queue pure suites.
- `git diff --check` — exit 0.
- `python3 ./.trellis/scripts/task.py validate 08-20-ser-029-completion-window` — passed; only the established warning that `tui-testing.md` exceeds the context-injection byte cap.

No provider, network, or live-model test was run.
