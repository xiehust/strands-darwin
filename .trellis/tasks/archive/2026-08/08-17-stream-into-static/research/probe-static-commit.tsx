/**
 * RESEARCH PROBE (task 08-17-stream-into-static) — not part of spike/.
 *
 * Question: what does committing finished lines as they arrive *cost*, next to the
 * single write at the end of the block? The PRD's requirement is that each commit is
 * an append to `<Static>` and must not trigger a whole-screen clear, a re-emission of
 * the transcript, or a per-line re-render of history — so it has to be measured, not
 * argued.
 *
 * Method: mount the real `MessageList` in a pty with filler chrome (the same shape
 * `probe-live-frame-overflow.tsx` uses), feed it a 120-line answer one line at a
 * time, and count `ESC[3J` and the bytes written.
 *
 * - default: the state the real reducer produces — finished lines in history,
 *   the newest ones live.
 * - `--single`: the previous behaviour — everything live until the block closes,
 *   then one history entry.
 *
 * No model, no agent, no network.
 *
 * Run: pnpm tsx .trellis/tasks/08-17-stream-into-static/research/probe-static-commit.tsx [--single]
 */
import path from 'node:path';
import process from 'node:process';

import { spawn } from 'node-pty';
import { Box, render, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import { frameBudget } from '../../../../src/tui/frame-budget.js';
import { MessageList } from '../../../../src/tui/MessageList.js';
import { initialTurnState, turnReducer, type TurnState } from '../../../../src/tui/turn-state.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const ROWS = 20;
const COLS = 100;
const LINES = 120;
/** Header stand-in (4 rows incl. margin) plus the input stand-in (1 row). */
const CHROME_ROWS = 5;
const single = process.argv.includes('--single');

function liveRows(): number {
  return frameBudget({
    rows: ROWS,
    headerRows: CHROME_ROWS,
    thinkingRows: 0,
    prompt: { wanted: 1, floor: 1 },
    tools: { wanted: 0, floor: 0 },
    live: { wanted: Number.MAX_SAFE_INTEGER, floor: 0 },
  }).live;
}

function textDelta(text: string): unknown {
  return {
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
  };
}

function Child(): React.JSX.Element {
  const [emitted, setEmitted] = useState(0);
  const [state, setState] = useState<TurnState>(initialTurnState);

  useEffect(() => {
    if (emitted > LINES) {
      const done = setTimeout(() => process.exit(0), 200);
      return () => clearTimeout(done);
    }
    const timer = setTimeout(() => {
      const line = `answer line ${emitted + 1}`;
      setState((current) => {
        if (emitted === LINES) {
          // The block closes: the authoritative text arrives.
          const whole = Array.from({ length: LINES }, (_, index) => `answer line ${index + 1}`).join('\n');
          if (single) {
            return {
              ...current,
              liveText: '',
              history: [...current.history, { kind: 'assistant', id: 'final', text: whole, part: 'whole' }],
            };
          }
          return turnReducer(current, {
            type: 'streamEvent',
            event: { type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text: whole } } as never,
          });
        }
        const text = emitted === 0 ? line : `\n${line}`;
        // `--single` keeps every line in the live region, which is what the answer
        // did before finished lines were committed.
        return single
          ? { ...current, liveText: current.liveText + text }
          : turnReducer(current, { type: 'streamEvent', event: textDelta(text) as never });
      });
      setEmitted((value) => value + 1);
    }, 15);
    return () => clearTimeout(timer);
  }, [emitted]);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>darwin</Text>
        <Text dimColor>probe header line</Text>
        <Text dimColor>probe header line</Text>
      </Box>
      <MessageList history={state.history} liveText={state.liveText} columns={COLS} maxLiveRows={liveRows()} />
      <Text dimColor>you&gt; </Text>
    </Box>
  );
}

if (process.env['DARWIN_PROBE_CHILD'] === '1') {
  render(<Child />, { patchConsole: false });
} else {
  const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, ...process.argv.slice(2)], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: REPO_ROOT,
    env: { ...process.env, DARWIN_PROBE_CHILD: '1', FORCE_COLOR: '1' },
  });

  let raw = '';
  child.onData((data) => {
    raw += data;
  });

  child.onExit(({ exitCode }) => {
    const clears = raw.split('\u001b[3J').length - 1;
    console.log(`mode: ${single ? 'single write at the end (before)' : 'progressive commit (after)'}`);
    console.log(`viewport: ${COLS}x${ROWS}, answer lines: ${LINES}, child exit: ${exitCode}`);
    console.log(`full-screen clears (ESC[3J): ${clears}`);
    console.log(`bytes written to the terminal: ${raw.length}`);
    console.log(`static writes (lines committed above the live region): ${raw.split('answer line').length - 1} line mentions`);
  });
}
