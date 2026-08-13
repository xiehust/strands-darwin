/**
 * Final acceptance for PRD criterion 1: in a REAL git repository, the agent
 * reads code, fixes a bug (gated write), and runs the test command (gated
 * execute) to prove the fix — all through the real TUI in a pty.
 *
 * Differs from verify-tui.ts on purpose: prompts are approved by a generic
 * loop rather than a scripted sequence, because the model chooses its own tool
 * order (it may run the failing test first, or fix first).
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startTui, type TuiSession } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const REPO = '/tmp/darwin-acceptance';
const GREET = path.join(REPO, 'greet.js');

const BUGGY = `function greet(name) {
  return 'Hello, ' + nam + '!';
}
module.exports = { greet };
`;

const TEST = `const { greet } = require('./greet.js');
const got = greet('Darwin');
if (got !== 'Hello, Darwin!') {
  console.error('FAIL: got ' + got);
  process.exit(1);
}
console.log('PASS');
`;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

async function setUpRepo(): Promise<void> {
  await rm(REPO, { recursive: true, force: true });
  await mkdir(REPO, { recursive: true });
  await writeFile(GREET, BUGGY, 'utf8');
  await writeFile(path.join(REPO, 'test.js'), TEST, 'utf8');
  git('init', '--quiet');
  git('config', 'user.email', 'acceptance@test.local');
  git('config', 'user.name', 'Acceptance');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'buggy greet');
}

interface Tail {
  promptPending: boolean;
  idle: boolean;
}

/** Classifies the newest frame: permission box up, or an editable idle prompt. */
function readTail(screen: string): Tail {
  const tail = screen.trimEnd().slice(-400);
  const promptPending = tail.includes('allow?') && !/you>\s*$/.test(tail);
  const idle =
    /you>\s*$/.test(tail) && screen.lastIndexOf('you>') > screen.lastIndexOf('working…');
  return { promptPending, idle };
}

/**
 * Approves every permission prompt until the turn finishes, recording each
 * prompt's kind. Returns the kinds in the order they appeared.
 */
async function approveUntilIdle(tui: TuiSession, timeoutMs: number): Promise<string[]> {
  const kinds: string[] = [];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    await tui.waitUntil(
      (screen) => {
        const { promptPending, idle } = readTail(screen);
        return promptPending || idle;
      },
      {
        timeoutMs: deadline - Date.now(),
        label: 'a permission prompt or an idle prompt',
        // Both states are read off the newest frame, and a frame arrives in
        // pieces: a busy frame caught between its prompt line and its `working…`
        // hint reads as idle, which would end the loop mid-turn.
        settleMs: 400,
      },
    );

    const { promptPending } = readTail(tui.screen);
    if (!promptPending) {
      return kinds;
    }

    // Match against the whole screen and take the last hit: a long details block
    // (a big file body, say) pushes the box header out of any fixed-size tail
    // window, which would misread every kind as "unknown".
    const matches = [...tui.screen.matchAll(/permission required\s*\((\w+)\)/g)];
    kinds.push(matches.at(-1)?.[1] ?? 'unknown');

    tui.send('y');
    await tui.waitUntil((screen) => !readTail(screen).promptPending, {
      timeoutMs: deadline - Date.now(),
      label: 'the permission box to close',
    });
  }
}

async function main(): Promise<void> {
  header('Acceptance — real git repo: read, fix, run the test to prove it');
  await setUpRepo();

  const tui = startTui({ cwd: REPO });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const turnStart = tui.mark();
    tui.submit(
      `node test.js in this repo currently fails. Find the bug, fix it, ` +
        `then run \`node test.js\` yourself to confirm it passes.`,
    );

    // The idle predicate compares `you>` against `working…`, so it reads as idle
    // until the first busy frame is drawn. Wait for the turn to actually start.
    await tui.waitFor('working…', { timeoutMs: 60_000, from: turnStart });

    const kinds = await approveUntilIdle(tui, 600_000);
    const turn = tui.screen.slice(turnStart);
    console.log(`  approved prompts, in order: ${kinds.join(', ') || '(none)'}`);

    assert('at least one write was gated', kinds.includes('write'));
    assert('at least one command run was gated', kinds.includes('execute'));
    assert('assistant streamed text during the turn', /agent/.test(turn));
    assert('the test command was surfaced to the user', turn.includes('node test.js'));
    assert('a bash run completed with a success mark', /✓ bash/.test(turn));
    assert('the passing test output reached the screen', turn.includes('PASS'));

    const fixed = await readFile(GREET, 'utf8');
    console.log(`  greet.js now: ${fixed.replace(/\n/g, ' ').trim()}`);
    assert('the bug is gone from disk', !fixed.includes('nam +'));

    const verify = execFileSync('node', ['test.js'], { cwd: REPO, encoding: 'utf8' });
    assert('node test.js passes when run independently', verify.includes('PASS'));

    const diff = git('diff', '--stat');
    console.log(`  git diff --stat: ${diff.trim()}`);
    assert('the fix shows up as a real git diff', diff.includes('greet.js'));

    tui.submit('/exit');
    const code = await tui.exitedWithin(30_000);
    assert('TUI exited cleanly', code === 0);
  } finally {
    tui.kill();
  }

  report();
}

await main();
