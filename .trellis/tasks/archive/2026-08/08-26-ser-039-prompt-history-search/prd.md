# PRD — SER-039: bounded reverse prompt-history search

## Origin

Backlog direction `SER-039` from `docs/research/research_2026-08-26.md`; backlog status is already host-owned and in progress. Peer behavior: Claude Code and Codex CLI `Ctrl+R` prompt-history filtering.

## Goal

Add a bounded, project-only `Ctrl+R` reverse search over the existing newest-first, duplicate-collapsed trajectory prompt history. Search is an editor mode: typing filters, `Ctrl+R`/`Up`/`Down` navigates, `Enter` or `Tab` accepts the selected prompt into the editor, and `Escape` cancels to the exact opening draft and cursor.

## Contracts

1. Reuse `readPromptHistory(projectRoot)` as the only source. No new store, scope selector, trajectory mutation, model-visible message, model call, or network access.
2. Preserve every existing reader bound and degradation answer: absent/damaged records, session/stat/tail/entry/byte bounds, skipped overlong prompts, and project-only lookup.
3. Filtering is incremental, case-insensitive, Unicode-safe, newest-first, and bounded. Results retain reader order; the reader remains the duplicate-collapse authority.
4. Search state is pure and synchronously testable. It snapshots the opening draft/cursor and the history generation so cancel and stale async/batched keys are deterministic.
5. Key ownership stays explicit: permission modal first; compaction owns input; completion and queue take-back behavior remains unchanged outside search; ordinary sequential `Up`/`Down` recall and cursor motion remain intact.
6. Search renders only through the counted prompt region. Its query/status and bounded match rows are truncated one-`Text` rows; omissions and reader degradation are stated without wrapping or a permanent header row.
7. Help and user/spec documentation name the shipped binding. Built-in slash-command inventory is unchanged.

## Acceptance criteria

- [ ] Pure tests cover open, loading, empty/damaged/bounded history, incremental case-insensitive filtering, order, navigation, accept, exact cancel restoration, Unicode/code-point bounds, and stale/batched-key safety.
- [ ] A free PTY scenario covers open/filter/navigate/accept/cancel and empty history without model calls, and intentional key ownership alongside completion, queue take-back, permission Escape, compaction, and ordinary recall/cursor behavior.
- [ ] Focused suites, `pnpm typecheck`, one complete `pnpm test`, and `pnpm build` pass after source settles.
- [ ] Task/spec/docs records validate; `git diff --check` passes; `AGENTS.md` stays below 32 KiB; final implementation is committed with a clean tree.

## Non-goals

All-project/session scope, a new history database, fuzzy ranking, persistence of search state, trajectory repair, a model/tool request, new slash commands, or refactoring unrelated editor behavior.
