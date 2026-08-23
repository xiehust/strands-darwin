# SER-037 Escape prompt UI dismissal

## Goal

Let `Escape` dismiss transient prompt completion and recall UI without changing the prompt draft or disturbing modal input ownership.

## Requirements

- With an idle/editable prompt, `Escape` closes the currently visible slash-command or workspace-path completion menu while preserving the exact draft and cursor.
- Completion suppression applies only to the current query generation. A relevant edit or new query re-arms completion, including batched terminal input that arrives before React renders.
- `Escape` ends an active prompt-recall walk while retaining the currently recalled prompt. Later arrows use ordinary cursor movement and recall eligibility.
- A pending permission prompt continues to own `Escape` and deny the request. Compaction continues to own and ignore editor input, including `Escape`.
- Dismissal is UI-only: it causes no submission, queue mutation, model call, trajectory write, notice, runtime mutation, or new frame participant/row.
- Update bounded `/help`, English and Chinese user references, and the prompt completion/recall/TUI testing specs.
- Preserve the origin research report and the in-progress SER-037 backlog row without re-scoring or closing it.

## Acceptance Criteria

- [ ] Slash and path menus close on first `Escape`; draft and cursor are unchanged; a second `Escape` is inert.
- [ ] Editing/changing the completion query reopens the corresponding menu.
- [ ] `Escape` ends active recall while retaining its current draft, and later arrows follow ordinary eligibility.
- [ ] Permission `Escape` still denies and compaction still ignores editor `Escape`.
- [ ] Dismissal emits no submission, queue/model/trajectory/runtime side effect, notice, or frame row.
- [ ] Focused pure/render suites and free real-pty completion, path-completion, recall, recall-empty, and compaction coverage pass.
- [ ] `pnpm typecheck`, one complete `pnpm test`, and `pnpm build` pass.
