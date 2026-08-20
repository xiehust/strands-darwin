# Implementation plan — SER-029 completion selection window

## Extension seam

- Add one pure completion-window planner beside `InputBox`, where bounded menu presentation already lives.
- Keep `App`'s selected index and acceptance over the complete candidate array; pass that index unchanged to presentation.
- Feed the existing `planPromptBox` entry grant into the window planner. Its one existing overflow row states omitted counts in both directions.

## Steps

1. Add the pure window/notice projection and use it in `InputBox` rendering.
2. Add pure/render coverage for first, middle, last, wrapped, short-grant, ordering, marker identity, and row bounds.
3. Extend free slash and path pty scenarios with overflowing Up/Down plus Tab/Enter acceptance.
4. Update `live-frame.md`, `prompt-completion.md`, and `tui-testing.md` with the executable contract.
5. Run focused checks while editing, then typecheck, then one complete project gate after source settles. Record final checks in `check.md` and commit all task artifacts with the implementation.
