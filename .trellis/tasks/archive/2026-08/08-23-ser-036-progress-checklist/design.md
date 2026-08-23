# Design

## Boundary and data flow

`update_plan` is a normal SDK custom tool assembled only into the parent catalogue. Its strict Zod schema validates a whole list, and its callback returns a bounded acknowledgement without I/O. The parent agent emits the ordinary `beforeToolCallEvent` / `afterToolCallEvent` pair already observed by trajectory.

The pure TUI reducer recognizes only successful `update_plan` completion and replaces `TurnState.livePlan` with the validated input. Failed calls leave the previous valid list intact. `turnEnded` appends one bounded `plan` history entry and clears `livePlan`; the following `userInput` therefore cannot inherit live state. Replay continues reducing its existing ordinary tool records and receives no new record shape.

A shared formatter converts statuses to stable ASCII markers (`[ ]`, `[>]`, `[x]`) and computes bounded rows. The live component receives the exact frame-budget grant and emits exactly one `Text` per row, including a hidden-item row when needed. The final history projection uses the same bounded formatter inside existing `Static` ownership.

## Catalogue and permission boundary

Construct `update_plan` after the runtime snapshots `childTools`, then register it directly on the initialized parent registry before registering `subagent`. This preserves the current parent/child split. Add an explicit read classification so default/auto run silently and plan mode allows the advisory tool while unknown tools still fail closed.

## Non-goals

No plan store, resume restoration, config, command, trajectory event, replay reconstruction beyond ordinary tool rows, child exposure, or semantic verification of completion claims.
