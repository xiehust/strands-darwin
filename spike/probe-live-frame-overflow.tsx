/**
 * Diagnostic: why does a long streaming answer make the TUI flicker?
 *
 * Ink 7 repaints the live (non-`<Static>`) region by erasing exactly the lines it
 * wrote last time. That only works while the region fits the viewport: in
 * `ink/build/ink.js`, `shouldClearTerminalForFrame()` returns true as soon as the
 * frame is taller than `rows`, and the overflow branch writes
 * `clearTerminal + fullStaticOutput + outputToRender` **straight to stdout**,
 * bypassing the throttled log. So one over-tall frame costs a whole-screen clear
 * (`ESC[2J ESC[3J ESC[H` — including the scrollback) plus a re-emission of the
 * entire transcript, per render, at delta rate. That is the flicker.
 *
 * This probe mounts the real `MessageList` (plus header/input filler rows, so the
 * chrome height matches `App`) in a pty and grows `liveText` one line at a time,
 * counting the clear-terminals. `--bounded` renders only the tail that fits, which
 * is what the fix does.
 *
 * No model, no agent, no network.
 *
 * Run: pnpm tsx spike/probe-live-frame-overflow.ts
 *      pnpm tsx spike/probe-live-frame-overflow.ts --bounded
 */
import path from 'node:path';
import process from 'node:process';

import { spawn } from 'node-pty';
import { Box, render, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import { frameBudget } from '../src/tui/frame-budget.js';
import { MessageList } from '../src/tui/MessageList.js';
import type { HistoryItem } from '../src/tui/turn-state.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROWS = 24;
const COLS = 80;
/** Lines of streamed answer text; comfortably over ROWS. */
const LINES = 60;
const bounded = process.argv.includes('--bounded');

/**
 * Rows the fix leaves for streaming text here: viewport minus the filler chrome
 * below, minus the spare row. `Number.MAX_SAFE_INTEGER` reproduces the
 * unbounded live region this project had before the fix.
 */
function maxLiveRows(): number {
  if (!bounded) return Number.MAX_SAFE_INTEGER;
  // The filler rows below stand in for the prompt region, so they are what the
  // answer has to share the frame with.
  return frameBudget({
    rows: ROWS,
    headerRows: CHROME_ROWS,
    thinkingRows: 0,
    prompt: { wanted: 1, floor: 1 },
    tools: { wanted: 0, floor: 0 },
    live: { wanted: Number.MAX_SAFE_INTEGER, floor: 0 },
  }).live;
}

/** Header stand-in (4 rows incl. margin) plus the input stand-in (1 row). */
const CHROME_ROWS = 5;

function Child(): React.JSX.Element {
  const [lines, setLines] = useState(0);
  const [history] = useState<readonly HistoryItem[]>([
    { kind: 'user', id: 'u1', text: 'print a long answer' },
  ]);

  useEffect(() => {
    if (lines >= LINES) {
      // Let the last frame settle, then leave.
      const done = setTimeout(() => process.exit(0), 200);
      return () => clearTimeout(done);
    }
    const timer = setTimeout(() => setLines((value) => value + 1), 20);
    return () => clearTimeout(timer);
  }, [lines]);

  const text = Array.from({ length: lines }, (_, index) => `answer line ${index + 1}`).join('\n');

  return (
    <Box flexDirection="column">
      {/* Stand-in for Header: same three rows plus its bottom margin. */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>darwin</Text>
        <Text dimColor>bedrock/probe · session probe</Text>
        <Text dimColor>probe header row</Text>
      </Box>
      <MessageList history={history} liveText={text} liveCodeOpen={false} columns={COLS} maxLiveRows={maxLiveRows()} staticEpoch={0} />
      {/* Stand-in for InputBox. */}
      <Text dimColor>you&gt; </Text>
    </Box>
  );
}

if (process.env['DARWIN_PROBE_CHILD'] === '1') {
  render(React.createElement(Child), { exitOnCtrlC: false });
} else {
  const child = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [import.meta.filename, ...process.argv.slice(2)], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: REPO_ROOT,
    env: { ...process.env, DARWIN_PROBE_CHILD: '1' },
  });

  let raw = '';
  child.onData((data) => {
    raw += data;
  });

  const code = await new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => resolve(exitCode));
  });

  const clears = raw.split('\u001b[3J').length - 1;
  const bytes = raw.length;
  console.log(`mode: ${bounded ? 'bounded live region (the fix)' : 'unbounded live region (today)'}`);
  console.log(`viewport: ${COLS}x${ROWS}, streamed lines: ${LINES}, child exit: ${code}`);
  console.log(`full-screen clears (ESC[3J): ${clears}`);
  console.log(`bytes written to the terminal: ${bytes}`);
  console.log(
    clears === 0
      ? 'no whole-screen repaint: the live region stayed inside the viewport'
      : 'each clear wipes the screen *and the scrollback*, then reprints every static line',
  );
}
