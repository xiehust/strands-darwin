/** SER-116 real offline pty: local idle/busy rename, usage/rejection zero-write,
 * no send/queue, status, completion/help, durable resume/clear display isolation.
 * Uses production CLI/runtime with only a scripted local model transport.
 * Run: pnpm tsx spike/verify-rename-pty.ts
 */
import { strict as check } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { userProjectSessionsDir } from '../src/paths.js';
import { sessionLabelPath } from '../src/agent/session-label.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

process.umask(0o002); // Ordinary umask-created directories inside a private owned HOME.
const home = ownPrivateHome('rename-pty');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'darwin-rename-pty-'));
await mkdir(path.join(home, '.darwin'), { recursive: true, mode: 0o700 });
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ memory: false,
  models: [{ enable: true, provider: 'bedrock', model: 'fake.rename', region: 'us-west-2' }],
}));
let tui: TuiSession;
function start(args: string[] = []): TuiSession {
  return startTui({ cwd, cols: 120, rows: 36, args,
    entry: path.join(REPO_ROOT, 'spike/fixtures/rename-cli.ts'),
    env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
  });
}
async function local(command: string, notice: string | RegExp): Promise<string> {
  const mark = tui.mark();
  tui.submit(command);
  await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 });
  return tui.screen.slice(mark);
}
async function requests(): Promise<string[]> {
  return (await readFile(path.join(cwd, 'model-requests'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
}
async function coreFiles(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await coreFiles(file));
    else if (entry.isFile() && entry.name !== 'label.json') result[file] = await readFile(file, 'utf8');
  }
  return result;
}
async function quit(): Promise<void> {
  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
}


header('SER-116 — idle/busy local rename through production TUI');
tui = start();
try {
  await tui.waitFor('you>');
  await local('/rename', 'Usage: /rename <label>');
  const store = userProjectSessionsDir(cwd);
  const ids = (await readdir(store)).filter((name) => name.startsWith('session-'));
  check.equal(ids.length, 1);
  const id = ids[0]!;
  const file = sessionLabelPath(cwd, id);
  const beforeIdle = await coreFiles(store);
  await local('/rename   idle 中😀 $HOME  ', 'Session label set: "idle 中😀 $HOME"');
  check.equal(JSON.parse(await readFile(file, 'utf8')).label, 'idle 中😀 $HOME');
  check.deepEqual(await coreFiles(store), beforeIdle);
  check.equal((await requests()).length, 0);
  await local('/status', 'label: "idle 中😀 $HOME"');
  await local('/help', /\/rename.*set this session/);
  const mark = tui.mark();
  tui.send('/rena');
  await tui.waitFor('/rename', { from: mark, settleMs: 150 });
  tui.send('\t');
  await tui.waitUntil(() => /you> \/rename\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 150 });
  tui.send('\u0015');
  await tui.waitUntil(() => /you>\s*$/m.test(tui.frame), { timeoutMs: 30_000, settleMs: 150 });
  await local('/rename ' + '😀'.repeat(81), 'Session label exceeds 80 Unicode code points');
  // Bracketed paste preserves literal line breaks; Enter is a separate settled event.
  tui.send('\u001b[200~/rename bad\nline\u001b[201~');
  await tui.waitUntil(() => tui.frame.includes('/rename bad') && tui.frame.includes('line'), { timeoutMs: 30_000, settleMs: 150 });
  tui.send('\r');
  await tui.waitFor('Session label must be single-line', { timeoutMs: 30_000, settleMs: 150 });
  await local('/rename bidi \u202econtrol', 'Session label must be single-line');
  check.equal(JSON.parse(await readFile(file, 'utf8')).label, 'idle 中😀 $HOME');
  check.deepEqual(await coreFiles(store), beforeIdle);
  const turnMark = tui.mark();
  tui.submit('hold ordinary prompt');
  await tui.waitFor('rename fixture working', { from: turnMark, settleMs: 150 });
  const beforeBusy = await coreFiles(store);
  await local('/rename busy label', 'Session label set: "busy label"');
  await local('/rename', 'Usage: /rename <label>');
  await local('/rename ' + 'x'.repeat(81), 'Session label exceeds 80 Unicode code points');
  await local('/rename bidi \u202econtrol', 'Session label must be single-line');
  await local('/status', 'label: "busy label"');
  check.ok(tui.frame.includes('working…'));
  check.ok(!tui.frame.includes('queued'));
  check.ok(!tui.frame.includes('busy label')); // Labels stay in Static notices, not a new live row.
  check.deepEqual(await coreFiles(store), beforeBusy);
  check.equal((await requests()).length, 1);
  await writeFile(path.join(cwd, 'release-model'), '');
  await tui.waitFor('rename fixture complete', { from: turnMark });
  await tui.waitUntil(() => !tui.frame.includes('working…'), { timeoutMs: 30_000, settleMs: 250 });
  await local('/status', 'label: "busy label"');
  check.equal((await requests()).length, 1);
  check.ok(!(await readFile(path.join(store, id, 'trajectory.jsonl'), 'utf8')).includes('/rename'));
  check.ok(!(await requests()).join('\n').includes('busy label'));
  assert('idle/busy usage, Unicode literal, invalid input and status are local; no extra invocation, queue, core-state write or trajectory label', true);
  const predecessorLabel = await readFile(file);
  await quit();
  tui = start(['--resume', id]);
  await tui.waitFor('you>');
  await local('/status', 'label: "busy label"');
  check.equal((await requests()).length, 1);
  await local('/clear', 'cleared — new session');
  const statusMark = tui.mark();
  await local('/status', 'status — this session');
  check.ok(!tui.screen.slice(statusMark).includes('label:'));
  check.deepEqual(await readFile(file), predecessorLabel);
  check.equal((await requests()).length, 1);
  assert('same-ID TUI resume exposes label; clear is unnamed and preserves predecessor; completion/help canonical', true);
  await quit();
} catch (error) {
  console.error(tui.screen.slice(-8000));
  throw error;
} finally {
  tui.kill();
  await rm(cwd, { recursive: true, force: true });
}
report();
