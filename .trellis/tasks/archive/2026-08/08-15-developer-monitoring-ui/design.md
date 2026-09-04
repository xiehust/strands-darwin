# Design — concise background bash rendering

## Boundary

Change only the TUI projection of existing SDK tool lifecycle events. The background manager, `bash` tool result contract, developer skill, SDK loop, and model-visible results remain unchanged.

```text
SDK before/afterToolCallEvent
  → pure background-bash presentation helpers
  → turn reducer (compact or expanded policy)
  → live ActiveToolCalls / static MessageList
```

The model still receives complete tool results. Compact mode is a display decision after the call completes, never a mutation of tool output.

## Background-call classification

Treat only `bash` inputs whose `mode` is `start`, `list`, `status`, `output`, or `stop` as background lifecycle calls. `execute` and `restart` keep ordinary tool rendering.

Add a small TUI presentation module that owns:

- guarded recognition of background bash mode from unknown input;
- short task-id and bounded command summaries using existing `task-format` helpers;
- compact summaries for active and completed calls; and
- extraction of the `output` string from a successful `output` result without exposing offsets or filesystem paths.

The helper must fail safely: an unexpected result shape falls back to the existing full preview rather than silently hiding information.

## Compact and expanded policies

`TurnState` owns one session-local `backgroundDetailsExpanded` boolean, initially `false`.

### Compact mode

- In-flight lifecycle calls remain in the live tool panel as one spinner row with a bounded summary.
- Successful `status` polls add no immutable history entry. Terminal transitions remain visible through the manager's existing completion notice.
- Successful `output` calls add a tool entry only when their extracted child output is non-empty; the preview is the child text, not cursor/path metadata.
- Successful `start`, `list`, and `stop` calls add one concise result row without raw JSON. Start/stop rows include short task identity/state when available; list reports a count/state summary.
- Failed or denied calls always use the existing full diagnostic preview.

### Expanded mode

Completed background lifecycle calls use the existing rendering unchanged, including full result previews. This applies to calls completing after the mode is enabled. Ink `<Static>` output already written to terminal scrollback is immutable and is not rewritten.

Active tools retain both ordinary and compact summaries so toggling can update the current live row immediately.

## Keyboard interaction

Handle `Ctrl+B` in `App` after the permission-prompt ownership branch and before editor commands. This preserves the rule that a permission prompt owns all keyboard input. Otherwise the chord is accepted while idle or streaming, does not touch the draft/cursor, and dispatches one reducer action that both flips the mode and appends a notice:

```text
background details: expanded
background details: compact
```

No setting is persisted; every new TUI session starts compact.

## Compatibility and failure behavior

- Foreground bash and non-bash tools follow the existing path byte-for-byte.
- `/tasks` remains the explicit complete user-facing task report and works during streaming.
- Parsing is presentation-only. Unknown/malformed successful payloads render fully rather than disappear.
- No manager, process cleanup, permission, or conversation/session identity behavior changes.
- Preserve unrelated working-tree edits by limiting changes to the reducer, tool panel/list props, App keyboard wiring, focused tests, and documentation.

## Verification

- Add a network-free pure suite for recognition, compact summaries/result extraction, repeated-status suppression, output visibility, malformed fallback, failure preservation, expanded behavior, and foreground compatibility.
- Add a zero-model real-pty scenario proving `Ctrl+B` toggles both ways and preserves an existing draft.
- Run the existing background task, task-format, and TUI task scenarios, then `pnpm typecheck` and `pnpm test`.
