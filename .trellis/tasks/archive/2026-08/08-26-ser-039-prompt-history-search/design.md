# Design — SER-039 prompt-history search

## Data flow

`trajectory.jsonl` → existing bounded `readPromptHistory(projectRoot)` → cached `PromptHistory` in `App` → pure search snapshot/filter/navigation → counted `InputBox` projection → accept only mutates the local editor.

## State ownership

Create `src/tui/prompt-history-search.ts` for immutable state and transitions. State snapshots opening `EditorValue`, the reader entries/note, query, selected index, loading state, and a bounded visible result set. `App.tsx` keeps an immediate ref mirror, starts/reconciles async history reads by project-root generation, and routes keys before ordinary completion/editor handling only while search is open.

`InputBox.tsx` receives a precomputed bounded search projection. `frame-budget.ts` counts exactly the rows the projection may draw and drops/states hidden matches within its grant. The ordinary completion, recall, hint, permission, tool, queue, plan, and live-answer participants are not structurally changed.

## Key contract

- `Ctrl+R` while idle opens search, then advances to the next match.
- Search mode owns printable query edits, Backspace/Delete, `Ctrl+U`, `Ctrl+R`, `Up`, `Down`, `Enter`, `Tab`, and `Escape`.
- `Enter`/`Tab` accept the selected result; `Escape` restores the exact opening editor snapshot.
- Permission handling remains before search. Compaction returns before search. Search is unavailable while non-idle, matching editor ownership.
- Opening search ends sequential recall without changing its draft; cancel restores that exact editor snapshot.

## Bounds

The reader remains authoritative for disk/session/entry/code-point bounds. The search query has a code-point cap, filtering examines only the reader's bounded entries, and the rendered match list has a fixed maximum plus a one-row omission statement. Every rendered row truncates rather than wraps.
