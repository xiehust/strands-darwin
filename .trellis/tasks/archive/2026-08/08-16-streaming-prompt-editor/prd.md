# Make streaming prompt visibly editable

## Goal

Make the TUI prompt visibly and genuinely editable while a model turn streams, without changing the one-turn-at-a-time agent contract, permission ownership, or explicit no-queue behavior.

## Background

`src/tui/App.tsx` deliberately accepts typing and local report commands during streaming, but currently passes `disabled=true` to `InputBox`. `InputBox` then hides the terminal cursor, dims the draft, and advertises ARIA disabled state. The interface therefore contradicts the input behavior. Explicit compaction has a separate accepted contract: its editor remains disabled while conversation state is being rewritten.

## Requirements

- Replace the ambiguous input presentation flag with an explicit editability contract.
- While streaming, render normal draft text, advertise an enabled textbox, and keep the terminal cursor active at the editor cursor position.
- Preserve all cursor movement, insertion, deletion, multiline, completion, and paste behavior while streaming.
- Keep `/usage`, `/effort`, `/tasks`, `/agents`, `/context`, and `/trajectory` ahead of the busy guard so they still execute locally mid-turn.
- Pressing Enter on agent-bound text while streaming must keep the exact draft, show the existing `still working` notice, and start or queue no second turn.
- When the original turn ends, the retained draft must remain idle until explicitly submitted, then start a normal second turn.
- A permission prompt must continue to own every keyboard and paste event while visible; input sent to it must not mutate the hidden preexisting draft.
- Compaction must be truly non-editable: after global controls, permission ownership, and display-only controls, ignore editor keyboard and paste input until compaction ends.
- Keep the SDK loop, runtime send path, permission gate/queue, and model-visible input unchanged.
- Do not add dependencies, component mocks, a prompt queue, or a second invocation path.

## Acceptance Criteria

- [x] A real model-driven streaming frame shows the edited draft with a terminal-observable active cursor.
- [x] Cursor movement plus insertion during streaming changes the draft at the selected position.
- [x] A local `/usage` report executes before the active turn completes.
- [x] Busy Enter shows `still working`, preserves the exact agent-bound draft, and starts no second turn automatically after the first reaches idle.
- [x] Explicitly pressing Enter after idle starts and completes a real second turn from the retained draft.
- [x] Input sent while a permission prompt is visible leaves a preexisting hidden draft unchanged after approval, while SER-009 latest-frame and exact-write assertions remain intact.
- [x] A focused compacting check proves keyboard and paste do not mutate the disabled draft.
- [x] Cursor, multiline, chunked Enter, completion, usage, and approve pty scenarios pass.
- [x] Focused prompt/compact checks, `pnpm typecheck`, `pnpm test`, `git diff --check`, and Trellis validation pass.

## Out of Scope

- Prompt queuing, parallel parent turns, or any SDK agent-loop change.
- Changing which commands are local or their ordering relative to the busy guard.
- Making compaction cancellable or editable.
- Changes to `docs/research/**` or `docs/iteration-log.md`.
