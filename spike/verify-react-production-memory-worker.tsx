/** Worker for verify-react-production-memory.ts; run only in a constrained child. */
import React from 'react';
import { render, Text } from 'ink';
import { Writable } from 'node:stream';

const TICKS = Number(process.env['DARWIN_MEMORY_TICKS'] ?? 20_000);
let resolveDone!: () => void;
const done = new Promise<void>((resolve) => { resolveDone = resolve; });

class Sink extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;

  override _write(_chunk: unknown, _encoding: unknown, callback: () => void): void {
    callback();
  }
}

function BusyFrame(): React.JSX.Element {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), 0);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => {
    if (frame >= TICKS) resolveDone();
  }, [frame]);
  return <Text>{`working ${frame % 8}`}</Text>;
}

const instance = render(<BusyFrame />, {
  stdout: new Sink() as never,
  exitOnCtrlC: false,
  maxFps: 10_000,
});
await done;
global.gc?.();
const memory = process.memoryUsage();
const measures = performance.getEntriesByType('measure').length;
instance.unmount();
await instance.waitUntilExit();
process.stdout.write(JSON.stringify({ heapUsed: memory.heapUsed, rss: memory.rss, measures }));
