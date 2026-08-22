import { Box, Text, useWindowSize } from 'ink';
import React, { useEffect, useState } from 'react';

import { visualColor, visualMarker } from './visual-language.js';

export type StartupPhase = 'runtime' | 'resume';

export interface StartupScheduler {
  set(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clear(timer: ReturnType<typeof setInterval>): void;
}

const startupScheduler: StartupScheduler = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (timer) => clearInterval(timer),
};

export const STARTUP_INTERVAL_MS = 140;
const MOTION = ['·', '∙', '●', '∙'] as const;
const EVOLUTION = ['seed', 'adapt', 'evolve'] as const;
const FULL_MIN_COLUMNS = 34;
const FULL_MIN_ROWS = 5;

export function startupText(
  phase: StartupPhase,
  frame: number,
  columns: number,
  rows: number,
): readonly string[] {
  const motion = MOTION[frame % MOTION.length];
  const state = phase === 'resume' ? 'restoring session' : 'initializing';
  if (columns < FULL_MIN_COLUMNS || rows < FULL_MIN_ROWS) {
    if (columns >= 24) return [`${visualMarker.identity} darwin ${motion} ${state}`];
    if (columns >= 8) return [`D ${motion} ${phase === 'resume' ? 'res' : 'init'}`];
    return [`D${motion}${phase === 'resume' ? 'r' : 'i'}`];
  }

  const evolution = EVOLUTION[frame % EVOLUTION.length];
  return [
    `${visualMarker.identity} DARWIN`,
    `${motion} ${state}`,
    `  ${evolution} · selection in progress`,
  ];
}

/**
 * Pre-App terminal ownership while real initialization is pending.
 *
 * Motion means only that the awaited work has not settled. This component owns no
 * input and writes nothing outside Ink; replacing it with App unmounts it and
 * clears the sole interval before the ready frame becomes interactive.
 */
export function StartupFrame({
  phase,
  frame,
  columns,
  rows,
}: {
  readonly phase: StartupPhase;
  readonly frame: number;
  readonly columns: number;
  readonly rows: number;
}): React.JSX.Element {
  const lines = startupText(phase, frame, columns, rows);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text
          key={index}
          color={index === 0 ? visualColor.identity : index === 1 ? visualColor.active : visualColor.muted}
          bold={index === 0}
          dimColor={index === 2}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function StartupScreen({
  phase,
  scheduler = startupScheduler,
}: {
  readonly phase: StartupPhase;
  readonly scheduler?: StartupScheduler;
}): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = scheduler.set(() => setFrame((value) => value + 1), STARTUP_INTERVAL_MS);
    return () => scheduler.clear(timer);
  }, [scheduler]);

  return <StartupFrame phase={phase} frame={frame} columns={columns} rows={rows} />;
}
