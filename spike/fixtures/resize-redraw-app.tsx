/**
 * Fixture for `spike/verify-resize-redraw.ts`: the shape of darwin's busy frame under
 * plain Ink — a `<Static>` transcript, a shimmering `◆ DARWIN · working` header row
 * (the 90 ms spinner tick keeps frames coming), one long wrapped header row and one
 * `truncate-end` row that fills the terminal exactly. No runtime, model or network.
 *
 * Run by hand in a reflowing terminal (tmux, iTerm2, Terminal.app, kitty, xterm.js)
 * and drag it narrower: with the pinned Ink patch the frame is redrawn once from a
 * cleared screen; without it every resize event leaves the top rows of the previous
 * frame behind as a stale copy.
 */
import { Box, render, Static, Text } from 'ink';
import React, { useEffect, useState } from 'react';

const LABEL = 'working';
const LONG = 'bedrock/global.anthropic.claude-fable-5-1 · session session-20260908-145610413 · cache 1h · effort high';

function App(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 90);
    return () => clearInterval(timer);
  }, []);
  const active = frame % LABEL.length;
  return (
    <>
      <Static items={[1, 2, 3, 4, 5, 6]}>
        {(item) => <Text key={item}>history line {item}</Text>}
      </Static>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="cyan" bold>◆ DARWIN</Text>
          <Text dimColor>
            {' · '}
            {[...LABEL].map((letter, index) => (
              <Text key={index} {...(index === active ? { color: 'cyan', bold: true } : {})}>
                {letter}
              </Text>
            ))}
          </Text>
        </Text>
        <Text dimColor>{LONG}</Text>
        <Text dimColor>mode: yolo</Text>
      </Box>
      <Text>you&gt;</Text>
      <Text dimColor wrap="truncate-end">
        working… · 13m 56s · ↑18 ↓5.6k tokens /tasks lists jobs · /agents lists dispatches · /usage reports tokens · ctrl+c cancels this turn
      </Text>
    </>
  );
}

render(<App />, { exitOnCtrlC: true });
