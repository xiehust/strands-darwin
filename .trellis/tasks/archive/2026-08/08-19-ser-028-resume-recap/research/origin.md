# SER-028 source notes

- Research run: `docs/research/research_2026-08-19.md`, `2026-08-19T14:12:37Z`.
- Backlog: `docs/research/backlog_index.md`, SER-028.
- Peer evidence: Claude Code one-line resume recap (S1); Codex/OpenCode saved-chat resume
  workflows (S2/S5); DeepSeek append-only replay projection (S3).
- Repository fit: `AgentRuntime.create()` restores SDK messages; `App` starts from
  `initialTurnState`; `replayRead` already reconstructs `HistoryItem` through `turnReducer`;
  trajectory readers are tolerant, read-only observers.
