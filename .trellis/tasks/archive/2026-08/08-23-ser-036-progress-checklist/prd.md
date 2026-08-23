# SER-036 structured progress checklist

## Goal

Give the parent agent a bounded structured progress checklist that tells the user what it believes is pending, active, and complete during a multi-tool turn, without creating a second durable state channel.

## Requirements

- Add a parent-only `update_plan` SDK tool. Every call supplies the complete replacement list.
- Accept 1–20 unique items. Each item has exactly `item` and `status`, where status is `pending`, `in_progress`, or `completed`; item text is trimmed, non-empty, at most 200 Unicode code points, and the whole list is at most 2,000 item-text code points.
- Validation is strict and local. The advisory non-I/O tool is statically safe and never asks permission, writes files/config/session state, or reaches child-agent catalogues.
- Derive the TUI's latest checklist from ordinary parent tool stream events. During the turn, render it as a participant in the shared frame budget; state every hidden item count and use one `Text` per granted row.
- At turn end, append one final bounded checklist projection to existing `Static` history, then clear live checklist state before another turn. If no valid update occurred, append nothing.
- Status markers must remain meaningful after ANSI stripping.
- Keep ordinary before/after tool records as the sole trajectory/replay evidence. Add no trajectory record kind, persistence, config, dependency, or child transcript surface.

## Acceptance Criteria

- [ ] An offline real SDK Agent executes valid and invalid calls and proves replacement plus all schema bounds and duplicate rejection.
- [ ] Tests prove no project, config, or session writes; parent catalogue presence; child catalogue absence; and no permission prompt in every mode.
- [ ] Reducer/component tests prove the latest valid list wins during a multi-tool turn, bounded live rows fit their grant and state hidden count, final projection enters history exactly once, and live state is absent at the next turn.
- [ ] A free pty scenario observes the live checklist, bounded hidden count, final Static projection, no stale live projection in the next turn, and ANSI-stable markers.
- [ ] Trajectory/replay tests prove only ordinary tool call/result evidence exists.
- [ ] Focused suites, `pnpm typecheck`, one complete `pnpm test` after source settles, `pnpm build`, Trellis validation, and diff checks pass.
