/** SER-103: real pty, idle and held model stream, no provider. Anchored waits;
 * call log + persisted trajectory prove local commands never enter another turn.
 * Run: pnpm tsx spike/verify-list-agents-pty.ts
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownPrivateHome } from './shared.js';
import { startTui, REPO_ROOT } from './tui-driver.js';
import { projectKey, userDarwinDir, userProjectSessionsDir, userSessionsDir } from '../src/paths.js';
import { crowdedProject, digest, directoryOrder } from './list-agents-fixtures.js';
import { MAX_AGENT_PROJECT_ENTRIES, MAX_AGENT_ROWS } from '../src/list-agents.js';

const HOME = ownPrivateHome('list-agents-pty');
const project = await crowdedProject(HOME);
const callsFile = path.join(HOME, 'calls');
const releaseFile = path.join(HOME, 'release');

assert((await directoryOrder(userSessionsDir())).indexOf(projectKey(project)) >= MAX_AGENT_PROJECT_ENTRIES);
await writeFile(path.join(userDarwinDir(), 'config.json'), JSON.stringify({
  model: 'us.anthropic.claude-sonnet-4-6', region: 'us-west-2', permissionMode: 'default', memory: false,
}));
const tui = startTui({
  cwd: project, entry: path.join(REPO_ROOT, 'spike/fixtures/list-agents-tui.ts'), cols: 160, rows: 40,
  env: { HOME, LIST_AGENTS_CALLS: callsFile, LIST_AGENTS_RELEASE: releaseFile,
    AWS_EC2_METADATA_DISABLED: 'true', DARWIN_MODEL_PRICES_FETCH: 'off' },
});

async function local(command: string, expected: string): Promise<string> {
  const from = tui.mark();
  // Trailing space makes Enter submit, rather than merely accept completion.
  tui.submit(`${command} `);
  await tui.waitFor(expected, { from, timeoutMs: 15_000, settleMs: 150 });
  return tui.screen.slice(from);
}

try {
  await tui.waitFor('you>', { timeoutMs: 30_000, settleMs: 200 });
  // More live historical rows than the report can show, all owned fixture data.
  for (let index = 0; index < MAX_AGENT_ROWS + 1; index++) {
    const directory = path.join(userProjectSessionsDir(project), `historical-${index}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'lease.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: '2026-09-26T05:11:10.000Z' }));
  }
  const beforeList = await digest(userSessionsDir());
  const idle = await local('/list-agents', 'Listing does not enable communication.');
  assert(idle.includes('(current process)') && idle.includes('PROJECT KEY (not cwd)'));
  assert(idle.replace(/\s/g, '').includes(projectKey(project)), 'current workspace is visible beyond the ordinary project prefix');
  assert(idle.includes('live holders beyond row limit'), 'fixture exceeds the shared row budget');
  assert(idle.includes(`project-entry scan limit ${MAX_AGENT_PROJECT_ENTRIES}`));
  assert.equal(await digest(userSessionsDir()), beforeList, 'idle TUI inventory makes no state changes');
  assert(!existsSync(callsFile), 'idle listing never calls the model');
  await local('/list-agents extra', '/list-agents takes no arguments');
  await local('/list-agents\textra', '/list-agents takes no arguments');
  await local('/agents', 'subagent dispatches');
  await local('/agents extra', 'usage: /agents cancel <dispatch-id>');
  assert(!existsSync(callsFile), 'idle local commands never call the model');

  const from = tui.mark();
  tui.submit('hold one offline turn');
  await tui.waitFor('LIST_AGENTS_BUSY', { from, timeoutMs: 30_000 });
  const busy = await local('/list-agents', 'Listing does not enable communication.');
  assert(busy.includes('(current process)'));
  assert(busy.replace(/\s/g, '').includes(projectKey(project)));
  assert(!busy.includes('LIST_AGENTS_FINISHED'), 'listing returns before the held turn settles');
  assert(!tui.frame.includes('queued'), 'listing creates no queued prompt');
  await local('/list-agents extra', '/list-agents takes no arguments');
  await local('/agents', 'subagent dispatches');
  assert(!tui.frame.includes('queued'), '/agents retains its pre-queue behavior');
  assert.equal(await readFile(callsFile, 'utf8'), 'model-call\n');

  const finish = tui.mark();
  await writeFile(releaseFile, 'release');
  await tui.waitFor('LIST_AGENTS_FINISHED', { from: finish, timeoutMs: 30_000 });
  await tui.waitUntil(() => !tui.frame.includes('working…'), { timeoutMs: 15_000, settleMs: 300 });
  tui.submit('/exit ');
  assert.equal(await tui.exitedWithin(15_000), 0);
  assert.equal(await readFile(callsFile, 'utf8'), 'model-call\n', 'exactly the one explicitly requested offline turn');
  const directory = userProjectSessionsDir(project);
  let prompts: string[] = [];
  for (const id of await readdir(directory)) {
    const file = path.join(directory, id, 'trajectory.jsonl');
    if (!existsSync(file)) continue;
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    prompts = prompts.concat(records.filter(record => record.type === 'userInput').map(record => record.text));
  }
  assert.deepEqual(prompts, ['hold one offline turn'], 'no local command reaches trajectory or a later queued turn');
  console.log('PASS real idle/busy /list-agents beyond the project prefix with crowded rows and zero-write hashes; local misuse and /agents unchanged; exactly one requested model turn, no queue or recorded local prompts');
} finally {
  tui.kill();
}
