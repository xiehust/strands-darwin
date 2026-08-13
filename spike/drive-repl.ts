/**
 * End-to-end check of the dev REPL through its real CLI entry point.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/drive-repl.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runRepl } from './repl-driver.js';
import { assert, header, report } from './shared.js';

const WORK_DIR = '/tmp/darwin-repl';
const GREET_PATH = path.join(WORK_DIR, 'greet.js');

const BUGGY_GREET = `function greet(name) {
  return "Hello, " + nam + "!";
}
module.exports = { greet };
`;

async function resetWorkDir(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(GREET_PATH, BUGGY_GREET, 'utf8');
}

async function main(): Promise<void> {
  await resetWorkDir();

  header('REPL run 1 — approve an edit through the real CLI');
  const first = await runRepl({
    cwd: WORK_DIR,
    args: [],
    turns: [
      `Fix the bug in ${GREET_PATH}: the variable \`nam\` should be \`name\`. ` +
        `Do not run any shell commands.`,
      '/exit',
    ],
    permissionAnswer: 'y',
    timeoutMs: 240_000,
  });

  const greetAfter = await readFile(GREET_PATH, 'utf8');
  console.log(`\n  greet.js now: ${greetAfter.replace(/\n/g, ' ').trim()}`);

  assert('REPL exited cleanly', first.exitCode === 0);
  assert('permission prompt was shown', first.transcript.includes('allow? [y/N]'));
  assert('prompt showed the file path', first.transcript.includes(GREET_PATH));
  assert('prompt showed the replacement text', first.transcript.includes('With:'));
  assert('tool activity was rendered', first.transcript.includes('calling fileEditor'));
  assert('approved edit was applied to disk', greetAfter.includes('+ name +'));
  assert('the bug is gone', !greetAfter.includes('+ nam +'));

  header('REPL run 2 — --resume recalls the previous session');
  const second = await runRepl({
    cwd: WORK_DIR,
    args: ['--resume'],
    turns: ['Which file did you edit a moment ago? Answer with just the path.', '/exit'],
    permissionAnswer: 'n',
    timeoutMs: 240_000,
  });

  assert('REPL exited cleanly', second.exitCode === 0);
  assert('session was reported as resumed', second.transcript.includes('(resumed)'));
  assert('restored history was reported', /restored : [1-9]\d* message/.test(second.transcript));
  assert('agent recalled the file from the previous session', second.transcript.includes('greet.js'));

  report();
}

await main();
