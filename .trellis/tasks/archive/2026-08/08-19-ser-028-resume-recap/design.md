# Design — SER-028 resumed-session human recap

## Data flow

1. `AgentRuntime.create()` remains the sole Agent assembly and restores the SDK snapshot exactly
   as before.
2. Interactive CLI startup checks `runtime.info.resumed`. Only then it calls a trajectory-only
   recap loader with `projectRoot`, the resolved `sessionId`, and whether recording is currently
   disabled.
3. The loader opens that exact session's trajectory with `readTrajectory`, chooses the last
   `turnEnded` in record order (turn ordinals restart in each recorder run), and reconstructs only
   that turn with `replayRecords` so the existing reducer remains the authority for assistant text.
4. It projects the selected user/assistant text plus honest source notices into a bounded
   `HistoryItem[]`. The CLI passes those items to `App` as startup history.
5. `App` uses that history only as the initial `turnReducer` state. Existing `MessageList` and
   `<Static>` render it once; `/clear`'s existing reducer action and Static epoch remove it.

## Projection and degradation

- Always label a successful recap and state that earlier transcript is omitted.
- Request and answer each have fixed code-point and logical-line caps. A marker is included inside
  those caps and reports omitted code points/lines.
- Assistant pieces from the selected replay turn are concatenated in replay order. Tool rows are
  intentionally not shown.
- Reader damage uses `describeDamage`; replay payload drops and record `trunc` metadata are counted
  and stated. A selected completed turn with no recoverable request/answer says so.
- A currently disabled trajectory says `trajectory recording is disabled`. An absent/unreadable
  file says no readable record exists and names pre-recording/disabled history as normal causes.
  No completed `turnEnded` is a separate explicit state.

## Non-effects by construction

The loader imports the trajectory reader/replay and TUI history type only: no runtime, Agent,
Model, session manager, writer or provider. It performs one read and returns immutable display
data. It never calls `send`, `saveSnapshot`, `writePointer`, `markResumable`, or a recorder. Fresh
sessions skip the loader entirely.
