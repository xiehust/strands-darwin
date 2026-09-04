# SER-040 design

## Change boundary

The current gap is that Darwin persists only `snapshot_latest`, so it can resume the end state but cannot authoritatively restore a prior prompt boundary. The behavior belongs at the SDK `SessionManager`/`AgentRuntime` boundary, not in trajectory or the renderer.

Expected product-code changes:

- `src/agent/session.ts`: bounded checkpoint catalogue paths/schema plus a storage wrapper that observes SDK immutable writes without altering snapshot bytes.
- `src/agent/runtime.ts`: checkpoint lifecycle, catalogue projection, strict fresh-successor restore, and existing `/clear` resource inheritance/retirement reuse.
- `src/tui/rewind-search.ts` and `src/tui/App.tsx`: bounded chooser, stale selection validation, editor restoration, refusal and omission notice.
- `src/commands/custom-commands.ts`, `src/tui/help-format.ts`, `src/tui/InputBox.tsx`, `src/tui/prompt-queue.ts`: command discovery/help/frame/busy contracts.
- Focused offline and pty tests plus specs/load-bearing docs/backlog evidence.

Explicitly not included: any filesystem snapshot, Git operation, workspace mutation, source-session copy/truncation, trajectory reconstruction, automatic prompt resend, provider call or dependency change.

## Boundary model

For prompt `P[n]`, the authoritative branch point is the Agent state immediately before invoking `P[n]`. `AgentRuntime.send()` first uses public `SessionManager.listSnapshotIds({ limit: 100 })`; while room remains it writes one immutable snapshot before `Agent.stream(P[n])` and identifies the new opaque SDK id with a one-row cursor listing. At capacity it skips capture but still runs `P[n]`. The prompt text is held in bounded process memory while the turn runs.

Only a normal `agentResultEvent` with `stopReason: endTurn` promotes that pending `(snapshotId, prompt)` into the bounded per-session catalogue. Failed, cancelled, abandoned and consumer-interrupted turns leave an immutable SDK snapshot but no selectable catalogue row, and therefore consume the same hard snapshot capacity. This keeps model-state authority in the SDK while making selection eligibility honest.

The first prompt in a fresh session therefore gets an empty-conversation checkpoint. A resumed runtime may create future checkpoints, but historical prompts from older processes are not invented: immutable snapshots lacking catalogue metadata remain unmapped and unavailable.

## Bounds and persistence

- Create at most 100 rewind-owned immutable snapshots per session. The capacity probe and post-save identification use public bounded listings only; no unbounded history listing is allowed.
- Retain at most 100 catalogue rows. Failed/cancelled captures can make the catalogue shorter than snapshot capacity because eligibility and retention are separate.
- Prompt text is accepted only when it is no more than 4,000 Unicode code points; oversized prompts still run but are not selectable.
- Catalogue parsing is strict and bounded by file bytes, entry count and field lengths; damage degrades to an honest local refusal.
- Immutable snapshot files are SDK-owned and never deleted or rewritten. At capacity, later ordinary turns continue and update `snapshot_latest`, but create no immutable checkpoint or catalogue row; `/rewind` warns while keeping existing rows usable.
- The catalogue is Darwin metadata only and never model input. The source catalogue is not pruned or rewritten during branch selection.

## Fresh successor restore

`startRewind(checkpoint)` validates that the opaque id and prompt still match the current bounded catalogue, then creates a brand-new runtime with a fresh session id through `AgentRuntime.create()`. Creation uses a restore descriptor naming the source session/snapshot. After `Agent.initialize()` assembles the fresh Agent, `SessionManager.restoreSnapshot({snapshotId})` restores the authoritative source state into it; Darwin then refreshes current learned-memory projection, working context and final cache point in the same order as ordinary resume.

The successor persists its restored state as its own `snapshot_latest` only after successful validation/refresh. Source latest, immutable snapshots, catalogue, trajectory and pointer are read-only throughout. On any error the predecessor remains live. On success the predecessor retires with `/clear` semantics while live permission mode, MCP clients and background-task manager transfer to the successor.

## TUI behavior

`/rewind` is idle-only and takes no arguments. It opens a bounded, synchronous chooser over the runtime catalogue. Up/Down navigate; Enter/Tab branches; Escape cancels. Acceptance revalidates the row against the live runtime before changing ownership, refusing stale or already-in-progress selections.

After success the transcript is reset like `/clear`, the selected prompt is inserted at the end-cursor without submission, and one warning notice states:

- source and successor session ids;
- source remains saved/resumable;
- workspace unchanged;
- workspace files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files were not rewound.

The existing frame-budget search rows are reused through a compatible bounded projection. `/rewind` joins the commands that refuse busy queueing.

## Failure semantics

- no catalogue/checkpoints: local notice, no mutation;
- resumed session with only unmapped historical SDK snapshots: explicitly says no completed prompts are available in this run/catalogue;
- damaged/unreadable catalogue: warn and refuse;
- stale selected id/prompt or missing immutable snapshot: refuse without creating/retiring a successor;
- busy turn, permission, shell command, compaction or concurrent branch assembly: refuse/retain safely;
- successor assembly/restore failure: shut down the failed successor through existing unwind, restore diagnostics sink, keep predecessor usable;
- source bytes and workspace are never compensation targets because they are never changed.
