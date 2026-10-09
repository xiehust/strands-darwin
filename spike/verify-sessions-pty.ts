/** SER-117 registered offline production CLI pty. Real saved-session store and a
 * file-held local model transport: idle/busy list and arguments never send/queue,
 * switch runtime, connect MCP, or mutate snapshot/trajectory/pointer/lease/label.
 * Semantic waits, including settled empty composer after Ctrl+U.
 * Run: pnpm tsx spike/verify-sessions-pty.ts
 */
import { strict as check } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionPaths, snapshotPath, trajectoryPath } from '../src/agent/session.js';
import { sessionLabelPath } from '../src/agent/session-label.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('sessions-pty');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'darwin-sessions-pty-'));
await mkdir(path.join(home, '.darwin'), { recursive: true, mode: 0o700 });
const config = path.join(home, '.darwin/config.json');
await writeFile(config, JSON.stringify({ memory: false,
  models: [{ enable: true, provider: 'bedrock', model: 'fake.rename', region: 'us-west-2' }],
}));
const saved = 'saved-session';
const snapshot = snapshotPath(cwd, saved, 'darwin');
await mkdir(path.dirname(snapshot), { recursive: true });
await writeFile(snapshot, JSON.stringify({ sessionId: saved, messages: [] }));
const trajectory = trajectoryPath(cwd, saved);
await mkdir(path.dirname(trajectory), { recursive: true });
await writeFile(trajectory, JSON.stringify({ v: 1, seq: 1, t: new Date().toISOString(), turn: 1, type: 'userInput', text: 'saved first prompt' }) + '\n');
await writeFile(sessionLabelPath(cwd, saved), JSON.stringify({ version: 1, label: 'saved display label' }), { mode: 0o600 });
await writeFile(sessionPaths(cwd).pointerFile, JSON.stringify({ sessionId: saved, updatedAt: new Date().toISOString() }));
const store = sessionPaths(cwd).stateDir;
const tui: TuiSession = startTui({ cwd, cols: 120, rows: 44,
  entry: path.join(REPO_ROOT, 'spike/fixtures/rename-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
async function local(command: string, notice: string | RegExp): Promise<string> {
  const mark = tui.mark();
  tui.submit(command);
  await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 });
  await tui.waitUntil(() => /you>\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 150 });
  return tui.screen.slice(mark);
}
async function requests(): Promise<string[]> {
  return (await readFile(path.join(cwd, 'model-requests'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
}
async function bytes(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await bytes(file));
    else if (entry.isFile()) result[file] = (await readFile(file)).toString('base64');
  }
  return result;
}

header('SER-117 production TUI local idle/busy discovery');
try {
  await tui.waitFor('you>');
  const configBefore = await readFile(config);
  const idleBefore = await bytes(store);
  const listing = await local('/sessions', 'resume one by ID with: darwin --resume <id>');
  check.ok(listing.includes(saved) && listing.includes('saved first prompt') && listing.includes('label: "saved display label"') && listing.includes('(last)'));
  check.ok(listing.includes('without a restorable snapshot not listed')); // Fresh current lease has no snapshot yet.
  await local('/sessions extra', '/sessions takes no arguments');
  await local('/sessions --resume saved-session', '/sessions takes no arguments');
  check.deepEqual(await bytes(store), idleBefore);
  check.equal((await requests()).length, 0);
  check.ok(!tui.frame.includes('queued') && !tui.frame.includes(saved));
  await local('/help', /\/sessions.*saved resumable sessions/);
  const completionMark = tui.mark();
  tui.send('/sess');
  await tui.waitFor('/sessions', { from: completionMark, settleMs: 150 });
  tui.send('\t');
  await tui.waitUntil(() => /you> \/sessions\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 150 });
  tui.send('\u0015');
  await tui.waitUntil(() => /you>\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 150 });
  assert('idle report and argument refusals preserve all store bytes, make zero sends, expose completion/help and add no live row', true);

  const turnMark = tui.mark();
  tui.submit('hold ordinary prompt');
  await tui.waitFor('rename fixture working', { from: turnMark, settleMs: 150 });
  const busyBefore = await bytes(store);
  await local('/sessions', 'resume one by ID with: darwin --resume <id>');
  await local('/sessions extra', '/sessions takes no arguments');
  check.ok(tui.frame.includes('working…') && !tui.frame.includes('queued') && !tui.frame.includes(saved));
  check.deepEqual(await bytes(store), busyBefore);
  check.deepEqual(await readFile(config), configBefore);
  check.equal((await requests()).length, 1);
  await writeFile(path.join(cwd, 'release-model'), '');
  await tui.waitFor('rename fixture complete', { from: turnMark });
  await tui.waitUntil(() => !tui.frame.includes('working…') && /you>\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 250 });
  const settledBefore = await bytes(store);
  const live = (await readdir(store)).find(name => name.startsWith('session-'))!;
  const settled = await local('/sessions', 'resume one by ID with: darwin --resume <id>');
  check.ok(settled.includes(live) && settled.includes('(open in pid '));
  check.equal((await requests()).length, 1); // No queued /sessions drains after the ordinary turn.
  check.deepEqual(await bytes(store), settledBefore);
  check.ok(!(await requests()).join('\n').includes('/sessions'));
  check.ok(!(await readFile(trajectoryPath(cwd, live), 'utf8')).includes('/sessions'));
  check.ok(!tui.frame.includes('queued'));
  assert('busy listing/refusal stays local, leaves invocation running; no queue drains, runtime switch, config/store mutation or trajectory command', true);
  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
} catch (error) {
  console.error(tui.screen.slice(-8000));
  throw error;
} finally {
  tui.kill();
  await rm(cwd, { recursive: true, force: true });
}

report();
