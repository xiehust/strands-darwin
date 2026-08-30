/**
 * Reproduction probe for the occasional final-reply duplication
 * (`.trellis/tasks/08-28-persistent-final-reply-duplication/`).
 *
 * Drives the real TUI in a pty with `final-reply-burst-cli.ts` — the recorded
 * session-20260830-110550523 reply tail streamed as bursts with no pause
 * before the closing `contentBlockEvent` — across several geometries and many
 * turns, then reconstructs the terminal buffer and counts each turn's unique
 * paragraph markers. Any marker seen more than once in visible scrollback is
 * the reported bug; the raw bytes are saved for forensics.
 *
 * Usage: pnpm tsx spike/probe-final-reply-duplication.ts [turnsPerSession]
 * No model calls; free to run.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
import { reconstructTerminalLines } from './terminal-state.js';

const WORK_DIR = '/tmp/darwin-dup-probe';
const OWNED_HOME = '/tmp/darwin-dup-probe-home';
const REAL_HOME = os.homedir();
process.env['HOME'] = OWNED_HOME;
process.env['AWS_CONFIG_FILE'] ??= path.join(REAL_HOME, '.aws', 'config');
process.env['AWS_SHARED_CREDENTIALS_FILE'] ??= path.join(REAL_HOME, '.aws', 'credentials');

const TURNS = Number(process.argv[2] ?? 8);
const GEOMETRIES = [
  { cols: 60, rows: 20 },
  { cols: 90, rows: 30 },
  { cols: 120, rows: 45 },
  { cols: 200, rows: 50 },
];

async function reset(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await rm(OWNED_HOME, { recursive: true, force: true });
  await mkdir(path.join(OWNED_HOME, '.darwin'), { recursive: true });
  await writeFile(
    path.join(OWNED_HOME, '.darwin', 'config.json'),
    `${JSON.stringify({ permissionMode: 'yolo', trajectory: false }, null, 2)}\n`,
    'utf8',
  );
}

async function waitForIdle(tui: TuiSession, timeoutMs: number): Promise<void> {
  await tui.waitUntil((screen) => screen.lastIndexOf('you>') > screen.lastIndexOf('working…'), {
    timeoutMs,
    label: 'an idle prompt',
    settleMs: 400,
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let failures = 0;

async function runGeometry(cols: number, rows: number): Promise<void> {
  await reset();
  const entry = path.join(REPO_ROOT, 'spike/fixtures/final-reply-burst-cli.ts');
  const tui = startTui({ cwd: WORK_DIR, entry, cols, rows });
  const label = `${cols}x${rows}`;

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const before = tui.mark();
      tui.submit(`turn ${turn}`);
      await tui.waitFor(`【T${turn}】：SER-045`, { timeoutMs: 30_000, from: before });
      await waitForIdle(tui, 30_000);
    }
    tui.submit('/exit');
    await tui.exitedWithin(30_000);

    // Visible terminal buffer: scrollback + final screen, erase-aware.
    const terminal = reconstructTerminalLines(tui.raw, rows).join('\n').replace(/\s+/gu, '');
    let geometryDuplicates = 0;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      // The held tail at close time: the 验证 marker and the 文档 marker.
      for (const [name, needle] of [
        ['验证', `**验证**【T${turn}】：`.replace(/\s+/gu, '')],
        ['文档', `**文档/spec**【T${turn}】：SER-045`.replace(/\s+/gu, '')],
        ['bullet', `-【T${turn}】\`expandSlashCommand\``.replace(/\s+/gu, '')],
        // The final Static checklist projection: before the fix the mid-array
        // insert made <Static> swallow it entirely (0 occurrences).
        ['checklist', `[>]turn${turn}implement`],
      ] as const) {
        const count = countOccurrences(terminal, needle);
        if (count !== 1) {
          geometryDuplicates += 1;
          failures += 1;
          console.log(`DUPLICATE ${label} turn ${turn} ${name}: seen ${count} times`);
        }
      }
    }
    if (geometryDuplicates === 0) {
      console.log(`ok ${label}: ${TURNS} turns, every marker exactly once`);
    } else {
      const dump = path.join('/tmp', `dup-probe-${label}.raw`);
      await writeFile(dump, tui.raw, 'utf8');
      console.log(`raw bytes saved to ${dump}`);
    }
  } finally {
    tui.kill();
  }
}

for (const { cols, rows } of GEOMETRIES) {
  await runGeometry(cols, rows);
}

console.log(failures === 0 ? '\nno duplication reproduced' : `\n${failures} duplicated markers`);
process.exit(failures === 0 ? 0 : 1);
