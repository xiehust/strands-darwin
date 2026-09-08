/**
 * Terminal narrowing redraws the live frame from a cleared screen (pinned Ink patch).
 *
 * Ink's standard renderer repaints by erasing exactly the number of lines it wrote
 * last time. When the terminal gets narrower, reflowing terminals (tmux, iTerm2,
 * Terminal.app, kitty, xterm.js) rewrap the rows of the previous frame that no longer
 * fit, so the frame occupies more rows than that count — and stock Ink 7.1.1's
 * `resized` handler only does `log.clear()` on width decrease, which erases the stale
 * count and leaves the top rows behind. In darwin that is the `◆ DARWIN · working`
 * header row (plus the model line) repeated once per resize event, each frozen at a
 * different shimmer letter. The patch (`patches/ink@7.1.1.patch`) makes the frame after
 * a width decrease take Ink's own overflow path — `clearTerminal + fullStaticOutput +
 * frame`, then `log.sync` — and cancels any throttled write of the pre-resize frame.
 *
 * A pty has no screen model, so the reflow itself cannot be observed here (the fixture's
 * header comment says how to see it by hand in tmux). What this suite pins is the byte
 * contract that makes the redraw correct on any terminal:
 *
 * - one width decrease emits exactly one `clearTerminal`, followed by the full
 *   `<Static>` transcript and then the current frame — in that order, once;
 * - the frames after it go back to the incremental erase (no repeated clears at the
 *   spinner rate);
 * - a width increase and a height-only change emit no clear at all (unchanged Ink
 *   behaviour: Ink-wrapped rows end in a hard newline, so widening does not reflow them).
 *
 * No model, no network. Run: pnpm tsx spike/verify-resize-redraw.ts
 */
import path from 'node:path';

import { assert, header, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/resize-redraw-app.tsx');
const CLEAR_TERMINAL = '\u001b[2J\u001b[3J\u001b[H';
/** The standard renderer's per-frame erase: `eraseLine` then `cursorUp`, repeated. */
const INCREMENTAL_ERASE = '\u001b[2K\u001b[1A';
const occurrences = (value: string, needle: string): number => value.split(needle).length - 1;

async function main(): Promise<void> {
  header('resize redraw — a narrower terminal gets one clean redraw, wider and taller none');
  const tui = startTui({ cwd: REPO_ROOT, entry: ENTRY, cols: 110, rows: 30 });
  try {
    await tui.waitFor('working… · 13m 56s', { timeoutMs: 20_000, settleMs: 300 });
    assert('the fixture renders at 110 columns without any screen clear',
      occurrences(tui.raw, CLEAR_TERMINAL) === 0 && tui.screen.includes('history line 6'));

    // Narrower: the busy row is truncated at 78 columns, so its new tail is the marker
    // that the post-resize frame has been drawn.
    const beforeNarrow = tui.raw.length;
    tui.resize(78, 30);
    await tui.waitFor('/agents lists dispa…', { timeoutMs: 10_000, settleMs: 400 });
    const narrowed = tui.raw.slice(beforeNarrow);
    const clearAt = narrowed.indexOf(CLEAR_TERMINAL);
    assert('one width decrease emits exactly one clearTerminal (2J 3J H)', occurrences(narrowed, CLEAR_TERMINAL) === 1);
    const afterClear = narrowed.slice(clearAt + CLEAR_TERMINAL.length);
    const staticAt = afterClear.indexOf('history line 1');
    const headerAt = afterClear.indexOf('DARWIN');
    assert('the redraw re-emits the full static transcript before the frame',
      staticAt !== -1 && headerAt !== -1 && staticAt < headerAt && afterClear.indexOf('history line 6') < headerAt);
    assert('the redrawn frame is the narrow layout (truncated at 78 columns)',
      afterClear.includes('/agents lists dispa…') && !afterClear.includes('lists dispatches'));
    assert('later spinner frames use the incremental erase again, not repeated clears',
      afterClear.includes(INCREMENTAL_ERASE) && occurrences(afterClear, CLEAR_TERMINAL) === 0);
    assert('the transcript is drawn once by the redraw, not once per spinner frame',
      occurrences(afterClear, 'history line 1') === 1);

    // Wider: unchanged Ink behaviour — the incremental path, no clear.
    const beforeWiden = tui.raw.length;
    tui.resize(100, 30);
    await tui.waitFor('/usage reports…', { timeoutMs: 10_000, settleMs: 400 });
    const widened = tui.raw.slice(beforeWiden);
    assert('a width increase emits no clearTerminal', occurrences(widened, CLEAR_TERMINAL) === 0);
    assert('a width increase does not re-emit the static transcript', !widened.includes('history line 1'));
    assert('a width increase repaints through the incremental erase', widened.includes(INCREMENTAL_ERASE));

    // Height only: no reflow, no clear (the frame still fits in 20 rows).
    const beforeShorten = tui.raw.length;
    tui.resize(100, 20);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const shortened = tui.raw.slice(beforeShorten);
    assert('a height-only change emits no clearTerminal and no transcript re-emission',
      occurrences(shortened, CLEAR_TERMINAL) === 0 && !shortened.includes('history line 1'));
    assert('the spinner is still running after the resizes', shortened.includes(INCREMENTAL_ERASE));
  } finally {
    tui.kill();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    assert('resize redraw suite completed', false);
  })
  .finally(() => {
    report();
  });
