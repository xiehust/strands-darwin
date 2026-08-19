# PRD — SER-027: queue messages typed while a turn runs

## Origin

Backlog direction SER-027 (`docs/research/backlog_index.md` row 70), **reopened by explicit user
product decision on 2026-08-19** (`docs/research/research_2026-08-19.md`, addendum `02:01:06Z`).
This deliberately **supersedes SER-010's no-queue busy-submit contract** — every spec, comment and
suite that pins "retained, never queued" is updated to the new contract as part of this task, with
the supersession stated.

Peer evidence: Claude Code queues messages typed while it works, lists them above the input box,
sends them when the turn ends, `Up` from the first line takes them back into the editor; Codex
`Tab` queues a follow-up for the next turn. Scope decision already made: **next-turn-only
delivery** — no mid-turn injection into a running SDK stream.

## The contract (decisions, each deliberate)

- **D1 — What queues.** A submission while `status` is `streaming` or `shell` is **queued**, not
  refused: the entry leaves the editor and joins a visible FIFO queue. Exceptions, each stated:
  - Local report/control commands (`/usage`, `/effort`, `/mode`, `/permissions`, `/tasks`,
    `/agents`, `/context`, `/trajectory`, `/export`, `/mcp`, `/status`) keep running immediately
    mid-turn, exactly as today — they never queue.
  - `/clear`, `/compact`, `/model`, `/exit`, `/quit` **refuse** mid-turn with the existing
    still-working notice (draft retained). Running a session-replacing command minutes later,
    unprompted, is worse than asking for a second Enter. This is the one place SER-010's
    retention shape survives, and it is stated as a deliberate exception.
  - `!` shell commands **queue** like prompts (the Claude Code peer shape: shell commands are
    held until the turn ends and run one at a time). A drained `!` runs through the ordinary
    submit path — same record, same panel, same report-held-for-next-prompt semantics.
  - Compaction still owns the keyboard entirely (`useInput` returns early), so nothing can be
    typed, let alone queued, while compacting. The pre-queue refusal branch stays for safety.
- **D2 — Delivery: sequential, one entry per idle.** When the session returns to idle, the queue
  drains **one entry at a time through the ordinary `submit()` path** — each queued prompt becomes
  its own turn (the Claude Code "each as a separate message" shape), each queued `!` its own run.
  Chosen over joined-as-one-prompt because the queue may hold a mix of prompts, `!` commands and
  slash-expansions, which cannot be joined into one string without changing what they mean; and
  because re-submitting through `submit()` makes trajectory honesty structural (D6).
- **D3 — Listing: visible, counted, bounded.** Queued entries are listed above the input box
  (below the tool panel), one `queued · <text>` row per entry, oldest (next to send) first. The
  rows are a new **counted** frame-budget participant (`queued` claim, granted after tools and
  before the live answer, floor 0); when cut, the head entries stay and one
  `… N more queued` row states the rest. Every row is one `<Text wrap="truncate-end">`. The block
  stays visible while a permission prompt is up.
- **D4 — Take-back: `Up` joins the existing chain without eating anything.** Precedence, in
  `useInput` order: completion menu → **queue take-back** → prompt recall → `moveVertical`.
  Take-back fires only when the queue is non-empty, no recall walk is open, and the cursor sits on
  the **first visual row** of the draft (the empty draft included) — every other keypress falls
  through unchanged. One `Up` takes the whole queue back: entries land in the draft one per line,
  **ahead of any typed text**, cursor at the end; the queue empties, so recall becomes reachable
  again on the next `Up`. An open recall walk keeps its `Up` semantics untouched (a walk can only
  open while the queue is empty, and the guard makes that structural).
- **D5 — Cancel and failure never silently send the queue.** Ctrl+C during a streaming turn (or a
  running `!`) marks the busy state user-aborted; when it ends, queued entries are **returned to
  the editor unsent** (same insertion as take-back) with a notice saying so. A turn that fails
  with an error does the same — auto-resending into an error is how retry loops start. `/clear`
  drops the queue with the conversation (D1 makes it idle-only, but the drop is explicit).
- **D6 — Trajectory honesty is structural.** Enqueueing dispatches nothing and records nothing.
  A drained entry goes through `submit()` at send time: its `userInput` transcript row and
  trajectory line are written exactly as sent, when sent. An entry taken back, returned on
  cancel, or dropped by `/clear` was never sent and leaves no record. Prompt recall reads only
  sent prompts — no change needed, verified.
- **D7 — Nothing invisible accumulates.** The busy hint states the queue count
  (` · N queued`, riding behind the live readout, ahead of the static hints) for both the
  `working…` and `running ! command…` hints. The count and the listing come from the same state.
- **D8 — Permission prompts hold the queue untouched.** While a permission decision is pending
  the prompt owns the keyboard (unchanged), so the queue can neither grow nor drain; the listing
  stays visible. The drain effect also refuses to fire while a permission is pending or while
  `/clear` is assembling a successor.

## Non-goals

- No mid-turn injection into a running SDK stream (scope decision from the backlog row).
- No persistence: the queue is live-session state, gone with the process.
- No new key beyond `Up` (no Codex-style `Tab` queue toggle).

## Implementation shape

- `src/tui/prompt-queue.ts` — new pure module: row projection (`queueRowText`), take-back draft
  composition (`takeBackDraft`), hint segment, marker.
- `src/tui/frame-budget.ts` — `queued` claim in `frameBudget` (optional, default none),
  `queueListWanted`, `planQueueList`, `hiddenQueuedNotice`.
- `src/tui/QueuedMessages.tsx` — the listed rows, one `<Text>` per counted row.
- `src/tui/App.tsx` — queue state (+ ref mirror), enqueue branch replacing the busy refusal,
  drain effect, take-back in the `Up` chain, abort return, `/clear` drop, hint count.
- `spike/verify-prompt-queue.ts` — new free suite (state machine + rendered listing), in
  `pnpm test`.
- `spike/verify-tui.ts` — new free `queue` scenario (uses a slow `!` command as the busy state,
  like `bang`); `usage` and `bang` scenarios' retained-never-queued assertions flipped to the new
  contract deliberately.
- Spec/doc updates: `.trellis/spec/frontend/live-frame.md` (new queue contract section),
  `.trellis/spec/frontend/prompt-recall.md` (Up precedence), `AGENTS.md` (busy/`!` rows + new
  row, stays < 32 KiB), `docs/architecture/load-bearing-decisions.md`, README busy line.

## Verification before commit

- `pnpm typecheck`; `pnpm test` (all suites, 0 failed).
- Free: `spike/verify-tui.ts` `queue`, `completion`, `recall`, `recallEmpty`, `mode`, `clear`,
  `multiline`, `cursor`, `bang`.
- Live (AWS_REGION=us-west-2): `spike/verify-tui.ts approve` at 120x50.
