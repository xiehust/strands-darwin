# Design — streaming prompt editability

## Boundary

Keep turn ownership in `App.submit()` and input presentation in `InputBox`. Streaming changes only whether the editor is presented as editable; it does not make the busy agent available for another turn. Compaction remains a distinct non-editable state.

## Editor contract

`InputBox` receives an explicit `editable` boolean. When true, it renders normal prompt styling, exposes `aria-state.disabled=false`, and calls Ink `setCursorPosition` after box metrics exist. When false, it dims the draft, exposes disabled state, and hides the terminal cursor.

`App` passes `editable={effectiveStatus !== 'compacting'}` whenever no permission prompt replaces the input box. A pending permission still replaces the editor entirely and therefore retains ownership without sharing input.

## Input ownership

The `useInput` precedence remains:

1. global exit and interrupt controls;
2. pending permission decisions;
3. display-only controls such as Ctrl+B;
4. compacting guard;
5. editor and submission handling.

The compacting guard makes the accepted visual state truthful by ignoring all editor keyboard operations. `usePaste` similarly ignores paste for either pending permission or compaction. Streaming has no editor guard and continues through the existing editing branches.

`submit()` remains unchanged in architecture: local reports run before the busy check; every agent-bound command reaches the existing `status !== 'idle'` refusal, which leaves the editor mirror untouched and appends `still working`.

## Terminal verification

Use Ink's emitted DEC private cursor controls as the direct terminal observation. The pty driver scans raw output in order and exposes whether the latest `ESC[?25h` or `ESC[?25l` control leaves the terminal cursor visible. This is deterministic because Ink emits show when `setCursorPosition` owns a render and hide before rewrites or when the position is cleared.

The streaming usage scenario edits a draft at a moved cursor, asserts the settled frame and terminal cursor, refuses Enter without clearing it, waits for the first turn to become idle, observes a quiet interval with no second `working…`, then explicitly submits and waits for a second real turn.

Compaction coverage uses a real pty plus the existing local `/compact` path. Because compaction itself calls a model, the scenario types and pastes while its busy hint is present, then verifies the empty editor returns after completion. Runtime compaction semantics remain covered by the focused offline suite.

## Compatibility and rollback

No runtime, SDK, permission, config, session, or dependency change. Rollback is confined to App/InputBox presentation and input guards, pty observations, tests, and the frontend contract.
