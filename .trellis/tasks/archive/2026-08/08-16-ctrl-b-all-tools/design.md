# Design — Ctrl+B for all tool details

## Boundary and Data Flow

Keep this as a TUI-only projection over existing SDK `beforeToolCallEvent` / `afterToolCallEvent` data:

```text
beforeToolCallEvent
  → retain full raw input on ActiveTool
  → live panel selects compact or expanded projection

afterToolCallEvent
  → retain presentation-safe input text and full textual result on HistoryItem
  → stamp the mode selected at completion
  → Ink <Static> writes that selected representation once
```

Do not alter tool execution, model-visible blocks, SDK events, permissions, headless output, session snapshots, or trajectory records.

## State and Naming

Generalize:

- `backgroundDetailsExpanded` → `toolDetailsExpanded`
- `toggleBackgroundDetails` → `toggleToolDetails`
- notice text → `tool details: expanded|compact`

The boolean remains session-local and defaults to compact. `Ctrl+B` stays after permission ownership and before editor commands.

`ActiveTool` retains the raw input for every tool, not only background calls. It already retains ordinary and optional compact summaries. The active renderer:

- compact: current summary behavior;
- expanded: ordinary summary plus bounded serialized `Input` detail;
- background specialized compact summary remains active only in compact mode.

A completed tool `HistoryItem` gains presentation fields needed to render independently after the active row disappears: bounded-source input text and whether expanded mode was selected at completion. This is display state, not a second tool/result contract.

## Bounded Text Projection

Create pure presentation helpers near `ToolCallPanel` (or a focused sibling if this keeps concerns clearer) with constants as the single source of truth:

| Mode/field | Code-point cap | Logical-line cap |
|---|---:|---:|
| Compact result | 2,000 | 4 |
| Expanded input | 8,000 | 100 |
| Expanded result | 32,000 | 200 |

Count Unicode code points (`[...text]`), not UTF-16 code units. Count logical newlines independently. Apply both caps and add an explicit marker with omitted code-point and/or line counts.

Status direction remains:

- success: keep the head;
- error: keep the tail;
- denied: keep the first `DENIED:` line plus the tail.

This fixes minified JSON/base64/long-log lines in compact mode while preserving the existing diagnostic priorities. Expanded mode is larger, not unbounded.

Serialize tool input with a non-throwing JSON projection. If serialization fails, show a bounded string fallback. Media/binary results continue through `previewToolResult` as type labels rather than dumping bytes/base64.

## Background Lifecycle Compatibility

Keep `background-tool-presentation.ts` as the owner of semantic compact projections:

- successful status/empty output suppression;
- concise start/list/stop rows;
- child output without metadata;
- malformed result fallback;
- failures/denials preserved.

Only rename the shared display flag and helper argument. In expanded mode, lifecycle calls bypass compact projection as today, then use the general expanded input/result renderer.

## Static History Constraint

Ink `<Static>` output is immutable. The mode selected when `afterToolCallEvent` reduces the call is stored on the resulting item. A later `Ctrl+B`:

- immediately changes active tool rows;
- changes subsequent completed calls;
- appends one notice;
- does not mutate, duplicate, or redraw prior history.

## Verification

Extend the offline TUI projection suite to prove:

- minified single-line JSON is code-point truncated in compact mode;
- line and character limits compose;
- success/error/denied directionality;
- Unicode truncation never splits a code point;
- expanded input/result bounds and markers;
- active ordinary tools change immediately;
- background semantic compact behavior is unchanged;
- immutable completed items retain their stamped mode.

Update the free pty `backgroundDetails` scenario/name to tool details and retain draft/no-model assertions. Run `pnpm typecheck`, focused suites, full `pnpm test`, and the free pty scenario.

## Rollback

Revert the generalized state/item fields and renderer helpers. No persisted state, migration, dependency, or external protocol needs rollback.
