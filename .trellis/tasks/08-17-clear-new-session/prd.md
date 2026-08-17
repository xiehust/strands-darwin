# Add `/clear`: start a new session without losing the old one

## Goal

`/clear` in the interactive TUI **starts a brand-new session**. The session that was live up to that
moment stays fully on disk — snapshot, `trajectory.jsonl`, `offload/`, `background/` — resumable and
inspectable. The live conversation continues in a new, empty session, and the screen is reset (that
is what the name promises), with exactly one notice naming both session ids so the saved session
stays discoverable.

Explicitly *not* this task: wiping a session, deleting anything, or a headless (`darwin -p`) feature.

## Background — measured, not assumed

- **Session identity is fixed at `Agent` construction; it cannot be swapped in place.**
  `SessionManager` is an SDK *plugin*: `Agent`'s constructor puts it in the `PluginRegistry`
  (`agent.js` ~L287) and `initialize()` calls `PluginRegistry.initialize(agent)`, which invokes
  `SessionManager.initAgent(agent)` — that is where its `AfterInvocationEvent` /
  `MessageAddedEvent` callbacks are registered. `_sessionId` is `private readonly`, the registry
  exposes no removal, and darwin never keeps the `HookCleanup` returns. So assigning a second
  `SessionManager` to `agent.sessionManager` would leave the **first** one's hooks registered:
  at the end of the next turn it would write the *cleared* conversation into the *previous*
  session's `snapshot_latest.json`, destroying exactly what this feature must preserve.
  → A new session therefore requires a new `Agent`, i.e. a second `AgentRuntime.create()`.
- **Sharing an `McpClient` with a second `Agent` is safe and spawns nothing.**
  `Agent.initialize()` only calls `client.listTools()`, and `McpClient.connect()` returns
  immediately when `_state !== 'disconnected'` (`mcp/client.js` L135). It also assigns
  `client.onToolsChanged`, a **single-slot** callback — the last agent initialized owns tool-change
  updates, which is correct as long as the predecessor is retired immediately.
  Re-spawning stdio servers instead would cost latency *and* put server banners on stdout in the
  middle of an Ink frame.
- **The foreground shell is per-`Agent`, not per-process.** The vended bash tool keys sessions in a
  `WeakMap` on `context.agent` (`vended-tools/bash/bash.js` L252). A new `Agent` therefore gets a
  fresh shell (spawned lazily on the next command), and the predecessor's shell must be reaped at
  hand-over or it keeps the event loop alive and the process never exits.
- **Background jobs are owned by `BackgroundBashManager`, not by the Agent** — so handing the same
  manager instance to the successor keeps running jobs alive, listable by `/tasks`, and reaped at
  exit. Its `outputDirectory` is fixed at construction from the session id.
- **`<Static>` cannot be recalled, and Ink caches every byte it ever wrote.**
  `Ink.fullStaticOutput` accumulates the whole transcript and is re-emitted on any later
  `clearTerminal` frame — so clearing the screen without dropping it would make the old transcript
  reappear on the next overflow. `reconciler.js` L98-L103 fires `onStaticChange` when the `<Static>`
  node identity changes, and `handleStaticChange` sets `fullStaticOutput = ''`: **remounting
  `<Static>` with a new React key is the supported reset.**
  `useStdout().write()` routes through `Ink.writeToStdout` (`log.clear()` → write →
  `restoreLastOutput()`, which replays only the live frame), which is the sanctioned way to put an
  escape sequence on the terminal without fighting the frame.

## Requirements

1. `/clear` is a 10th built-in: `BUILTIN_COMMAND_NAMES`, `BUILTIN_COMMAND_DESCRIPTIONS`,
   reserved against project/custom commands, and `MAX_COMPLETIONS` grown to 10 so no built-in falls
   off behind the "… n more" row.
2. `/clear` sits **below** the busy check in `App.tsx`'s submit callback: it replaces conversation
   state, so it must never run under a streaming turn. `/clear <anything>` is rejected the same way
   `/tasks`, `/context`, `/trajectory` and `/compact` reject arguments.
3. The switch is `AgentRuntime.startNewSession()` in `src/agent/runtime.ts` — the only place that
   constructs `Agent` — which creates its successor through the existing `create()` factory with
   `session: { kind: 'new' }`, then retires itself. `cli.ts` keeps owning shutdown: it tracks the
   current runtime so the exit path reaps the live one.
4. Hand over (not duplicate, not kill): the live `AppConfig` (so `/model` and `/effort` do not
   silently revert), the MCP clients and their load metadata, and the `BackgroundBashManager`.
   Rebuild everything session-scoped: `SessionManager`, `TrajectoryRecorder`, `DiagnosticsLog`,
   `ContextOffloader` storage, `SkillsPlugin`, `PermissionGate`, `SubagentDispatchRegistry`, usage
   meter, message history.
5. Retirement releases only what the successor did not take: the predecessor's per-agent bash shell,
   its subagent tool, its trajectory recorder (flushed — bytes already written are never rewritten)
   and its diagnostics log. It must **not** disconnect MCP clients, stop background jobs, or clear
   the process-global SDK verbose tap (the successor installed its own).
6. A failed switch is a survivable degradation: the predecessor stays live, its SDK verbose tap is
   restored, and the failure is reported as an `error` notice.
7. The resume pointer is **not** written at `/clear`. `markResumable()`'s existing invariant — an
   unused session never displaces a useful one — is what keeps `--resume` on the pre-clear
   conversation until the new session has actually produced a turn.
8. The UI resets: `<Static>` history dropped and remounted, live text and tool state cleared, one
   full-screen clear written once (never per render), the per-session notice latches
   (context-pressure, trajectory problem, diagnostics problem) reset, and exactly one notice naming
   both session ids.

## Acceptance criteria

- [ ] `pnpm typecheck`, `pnpm test`.
- [ ] `pnpm tsx spike/verify-tui.ts completion` — `/clear` visible, every other built-in still
      visible.
- [ ] `pnpm tsx spike/verify-clear-session.ts` (free, added to `pnpm test`): a real `AgentRuntime`
      switch proves a different new id, the predecessor's snapshot still holding its own conversation
      after the successor saves its own, the predecessor's `trajectory.jsonl` bytes untouched, an
      inherited background job still running and listable, and the resume pointer unmoved.
- [ ] `pnpm tsx spike/verify-tui.ts clear` (free): header session id changes, one notice names both
      ids, the screen is cleared once, the old transcript is gone from the frame, `/clear extra` is
      rejected without starting a turn, and `/clear` appears in the completion menu.

## Notes

A recorded trajectory turn cannot be produced without a model call, so the "prior bytes intact"
assertion is made over bytes the check writes into the predecessor's `trajectory.jsonl` itself (a
canary standing in for a recorded turn) plus the real snapshot written by the SDK's own
`SessionManager`. Stated in the check's own comments rather than implied.
