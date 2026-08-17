# What is still unbounded in the live frame — measured

Round 1 (`archive/2026-08/08-17-live-frame-flicker`) bounded `liveText` and asserted the frame
fits. It left two things open, and both are reproduced here. No model call was made for any
number on this page; the one accidental one is described at the bottom.

## 1. The draft alone destroys the scrollback — first at 13 rows

`research/probe-chrome-paste.ts 24 80 18`, real TUI in an 80x24 pty, draft grown one row per
step through bracketed paste, counting `ESC[3J` (whole screen **and scrollback**) per step:

| draft rows | last repaint, stripped lines | `ESC[3J` this step |
|---|---|---|
| 2 … 11 | 15 … 24 | 0 |
| 12 | 24 | 0 |
| **13** | **72** | **2** |
| 14 | 122 | 2 |
| 15 | 174 | 2 |
| 16 | 228 | 2 |
| 17 | 284 | 2 |
| 18 | 342 | 2 |
| 19 | 402 | 2 |

- Startup frame in this repo: **14 rows** (header 12 including its bottom margin, blank, `you>`),
  0 clears at startup.
- The threshold is a **13-row draft**, and past it every single added row costs 2 whole-screen
  clears. There is no streaming involved at all — this is an *idle* session being typed into,
  so the flicker class is wider than "a long answer".
- The stripped line count of one repaint climbing 24 → 402 is the overflow branch re-emitting
  `fullStaticOutput` per render. Here the transcript is nearly empty; in a real session that is
  the entire history, per keystroke.

## 2. Tool details and the permission box are capped in the wrong unit

`research/measure-chrome-rows.ts 80` (pure, no Ink, no pty):

```
draft — a 200-line paste: 200 rows
draft — one 5000-character line: 68 rows
tool details — a 300-line file write: 4 logical lines, 2937 code points → 41 rows
tool details — worst case allowed by the caps (100 lines / 8000 code points): up to 102 rows,
               per active tool (activeTools.length is itself uncapped)
permission box — one detail block: 15 rows incl. its label; caps are 14 lines / 500 code points
               *per block*, plus 2 border rows for the box
```

- `layoutEditor` emits one visual row per draft row with no cap: the paste *is* the height.
- `EXPANDED_INPUT_LINES` (100) and `EXPANDED_INPUT_CODE_POINTS` (8000) bound **content**, not
  height. `ToolCallPanel` draws each line as a plain `<Text>` (no `wrap="truncate-end"`), so Ink
  word-wraps it: 4 capped lines of a JSON tool input became **41 terminal rows**.
- The tool panel is redrawn every `SPINNER_INTERVAL_MS` (90ms) whether or not anything arrives,
  so an over-tall panel clears the screen ~11 times a second on its own.
- `PermissionPrompt` bounds each detail block but not the number of blocks, and does not
  truncate rows either.
- `liveRowBudget` clamps at `MINIMUM_LIVE_BLOCK_ROWS` (4). That floor is deliberate ("a floor,
  not a fit") and it means that once the furniture reaches `rows - 5` the live block *adds* rows
  to a frame that already overflows.

## 3. A pty cannot grow a draft by writing `"\n" + text`

The first version of `probe-chrome-paste.ts` did `send("\nrow1")` and measured nothing: a
multi-character event with a leading or trailing CR/LF is the **batched-Enter** path
(`App.tsx:629`, from `08-14-fix-chunked-enter-regression`), so it submitted the draft and spent a
real model turn — the only model call in this research, and an unintended one. A bare `"\n"` is
Ctrl+J and does insert a newline; the difference is the write boundary, which a pty does not
preserve. The probe now grows the draft through bracketed paste (`ESC[200~ … ESC[201~`, parsed by
`ink/build/input-parser.js` into `usePaste`), which is both the reported trigger and the only
growth path that provably cannot submit, and it asserts the busy hint never appeared.

Consequence for the fix: paste is the trigger to reproduce, and any pty check of a tall draft
must use bracketed paste or one write per key.

## 4. What this means for the two child tasks

- `08-17-live-frame-chrome`: bounding participants one at a time is not enough — three
  individually-bounded boxes still overflow together, so the budget has to be shared, with a
  priority order, and measured in visual rows.
- `08-17-stream-into-static`: committing finished lines into `<Static>` shrinks the live region
  for line-oriented answers, but the tail stays necessary for the unbroken-paragraph shape, and
  it will invalidate the current `verify-tui.ts longAnswer` assertion that the scrolled-out
  notice appears for a `row 1..120` answer.

## 5. After the fix — the same measurements

Same probe, same terminal (`probe-chrome-paste.ts 24 80 40`):

| draft rows | `ESC[3J` per step | bytes per step |
|---|---|---|
| 2 … 41 | **0** at every step | ~1.2 KB, flat |

The frame stays 23 rows (12 header + 11 granted), the draft is drawn as a window with
`… 31 draft rows not shown (31 above)`, and no turn is submitted. Before: first clear at 13 rows,
2 per row after that, bytes climbing past 2.2 KB as the whole transcript was re-emitted.

Three things the fix turned up that the measurements above did not predict:

- **Ink's flex layout, not its word wrap, was the bigger trap.** A `<Box>` with several `<Text>`
  children lays them out as flex items and shrinks or wraps them *independently*: the permission
  box's summary row rendered as two rows and ate the `] ` after `[parent`. Rows whose height must
  be known are now **one** `<Text>` with nested spans. `verify-frame-budget.ts` catches this class
  by rendering the real components through `renderToString` and comparing height to grant — it
  found four such rows (heading, summary, decision, menu title) that arithmetic alone called one
  row each.
- **The permission box must be exempt from the share ceiling.** It is modal — the loop is blocked
  until it is answered — but the tool call it is *asking about* is active, so the ceiling halved
  its grant (21 rows of 42) and cut its last detail row. That row is where `permissionDetail` puts
  `… truncated N code points`: the line saying the value shown is not the whole value, in the one
  box where that matters. Caught by `verify-tui.ts approve`, now guarded by three assertions in
  `verify-frame-budget.ts`.
- A **windowed draft has no `you>` row** (it is one of the rows scrolled out), so the pty
  helpers that key on `you>` — `waitForIdle`, `awaitsPermission` — cannot be used while a tall
  draft is up. `tallDraftStreaming` clears the draft first for exactly this reason.
