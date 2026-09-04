# Implementation notes — SER-027 prompt queue

## Decisions (as built, matching prd.md D1–D8)

- **Delivery: sequential, one entry per idle** — a `useEffect` drain in `App.tsx`
  (latched by a `draining` ref, re-armed by `drainCycle`) resubmits the oldest
  entry through the ordinary `submit()` path. Joined-as-one was rejected: the
  queue can hold prompts, `!` commands and slash expansions, which no single
  joined string preserves; sequential also makes trajectory honesty structural.
- **`!` mid-turn queues** (Claude Code peer shape) and runs at drain time through
  the same `submit()` shell branch — proved free in `tui bang` (a queued
  `!echo QUEUED_AFTER` runs after the running command finishes).
- **`/clear`, `/compact`, `/model`, `/exit`, `/quit` refuse** with a
  `… does not queue` notice, draft retained (`refusesToQueue` in
  `src/tui/prompt-queue.ts`) — the deliberate SER-010 remnant, stated everywhere.
- **Cancel/failure returns the queue to the editor unsent** (`turnAborted` ref set
  by Ctrl+C and the turn-error catch; `returnQueuedToEditor` shared with the `Up`
  gesture). A `!` timeout is not a cancel and drains normally.
- **`Up` precedence**: menu → take-back (queue non-empty, no open walk, cursor on
  first visual row) → recall → `moveVertical`. One press takes the whole queue
  back, entries one per line ahead of typed text.
- **Frame budget**: `queued` is a fourth claim (after tools, before live, floor
  0), one `queued ·` row per entry via `QueuedMessages.tsx`, cut stated by
  `… n more queued`; busy hint carries ` · N queued` on both busy rows.
- Permission pending holds the queue (keyboard ownership unchanged); `/clear`
  drops it; nothing recorded until send time.

## Verification run

- `pnpm typecheck` — clean.
- `pnpm test` — exit 0, all suites 0 failed (includes new
  `spike/verify-prompt-queue.ts`, 28 checks).
- Free pty: `verify-tui.ts` `queue` 17/17 (new), `bang` 19/19 (flipped to the new
  contract), plus `completion`, `pathCompletion`, `recall`, `recallEmpty`,
  `mode`, `clear`, `multiline`, `chunkedEnter`, `cursor`, `tallDraft`, `model`,
  `mcp` — all 0 failed.
- Live (AWS_REGION=us-west-2): `approve` 29/29 at 120x50; `usage` 23/23 with the
  mid-turn half flipped (queued prompt listed, counted, auto-sent as its own
  turn, recorded as `userInput` at send time).
- One `approve` failure during the run was a pre-existing pty coalescing race
  (`\u0015` + `/exit\r` in one event submits `/exit` inside the draft); hardened
  with an anchored wait per `tui-testing.md`, unrelated to the queue (queue was
  empty for the whole scenario; trajectory confirmed).
