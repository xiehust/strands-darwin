/** Deterministic component contracts for the pre-App startup surface. */
import { renderToString } from 'ink';
import React from 'react';

import {
  StartupFrame,
  StartupScreen,
  startupText,
  type StartupScheduler,
} from '../src/tui/StartupScreen.js';
import { assert, header, report } from './shared.js';

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ANSI, '');
const renderFrame = (frame: number, columns = 80, rows = 24, phase: 'runtime' | 'resume' = 'runtime') =>
  plain(renderToString(
    <StartupFrame phase={phase} frame={frame} columns={columns} rows={rows} />,
    { columns },
  ));

header('startup screen — bounded honest motion');
const frames = [0, 1, 2, 3].map((frame) => renderFrame(frame));
assert('multiple deterministic frames visibly differ while initialization is pending', new Set(frames).size === 4);
assert('every frame keeps stable identity and an honest pending state',
  frames.every((frame) => frame.includes('◆ DARWIN') && frame.includes('initializing')));
assert('motion never invents completion or numeric progress',
  frames.every((frame) => !/ready|complete|\d+%/i.test(frame)));
assert('the full motif stays bounded to three rows', frames.every((frame) => frame.split('\n').length === 3));

header('startup screen — narrow and short fallback');
const narrow = renderFrame(1, 24, 24);
const short = renderFrame(2, 80, 3);
assert('narrow terminals use one compact row', narrow.split('\n').length === 1 && narrow === '◆ darwin ∙ initializing');
assert('short terminals use the same one-row fallback', short.split('\n').length === 1 && short.includes('● initializing'));
assert('very narrow layouts retain compact identity, motion, and state markers without truncation',
  renderFrame(2, 12, 2) === 'D ● init' && renderFrame(1, 7, 1, 'resume') === 'D∙r');
assert('resume work is stated only by the resume phase',
  renderFrame(0, 80, 24, 'resume').includes('restoring session') &&
  !renderFrame(0).includes('restoring session'));
assert('pure layout never exceeds the supplied short-terminal budget',
  startupText('runtime', 0, 20, 1).length <= 1 && startupText('runtime', 0, 80, 4).length <= 4);

header('startup screen — interval ownership and cleanup');
let callback: (() => void) | undefined;
let sets = 0;
let clears = 0;
const timer = { fixture: true } as unknown as ReturnType<typeof setInterval>;
const scheduler: StartupScheduler = {
  set(next, intervalMs) {
    sets += 1;
    callback = next;
    assert('the component requests one positive animation cadence', intervalMs > 0);
    return timer;
  },
  clear(received) {
    clears += 1;
    assert('cleanup clears the timer returned by its scheduler', received === timer);
  },
};
const rendered = renderToString(<StartupScreen phase="runtime" scheduler={scheduler} />, { columns: 80 });
assert('mount schedules exactly one interval', sets === 1 && callback !== undefined);
callback?.();
assert('the installed interval callback can advance state without throwing after mount', sets === 1);
assert('synchronous renderer cleanup clears exactly that interval', clears === 1);
assert('the stateful component renders the same bounded initial motif', plain(rendered).split('\n').length === 3);

header('startup screen — no terminal side channel or input ownership');
const source = await import('node:fs/promises').then(({ readFile }) =>
  readFile(new URL('../src/tui/StartupScreen.tsx', import.meta.url), 'utf8'));
assert('the component contains no raw stdout/stderr/process write', !/process\.(?:stdout|stderr)|\.write\s*\(/.test(source));
assert('the component registers no input or paste hook', !/useInput|usePaste|useStdin/.test(source));

report();
