/**
 * SER-125 TUI checklist: production CLI/App/runtime, local deterministic model (no provider).
 * T1 local grammar/scopes + completion/help; T2 no model/trajectory/history/shell-report/state effect;
 * T3 busy refusal never queues (model and shell); T4 permission/search/editor ownership;
 * T5 overlapping invocations, cancel/exit/session replacement reap and cannot publish stale output.
 * Real temporary Git repository + executable Git wrapper; no mocked APIs.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT, startTui } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-diff-pty-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
const bin = path.join(root, 'bin');
for (const dir of [home, cwd, bin]) await mkdir(dir);
await mkdir(path.join(home, '.darwin'));
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ diagnostics: true }));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Keep runner Git/LFS configuration out of fixture setup and the real executable.
// The viewer deliberately strips GIT_*, so passing these only to the TUI is insufficient.
const gitConfig = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const xdg = path.join(root, 'xdg');
await mkdir(path.join(xdg, 'git'), { recursive: true });
const ambientConfig = '[filter "runner"]\n\tclean = false\n';
await writeFile(path.join(home, '.gitconfig'), ambientConfig);
await writeFile(path.join(xdg, 'git/config'), ambientConfig);
const git = (...args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8',
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, ...gitConfig } });
git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
await writeFile(path.join(cwd, 'tracked'), 'PTY-HEAD\n'); git('add', '.'); git('commit', '-qm', 'base');
await writeFile(path.join(cwd, 'tracked'), 'PTY-INDEX\n'); git('add', '.');
await writeFile(path.join(cwd, 'tracked'), 'PTY-WORKTREE-PRIVATE\n');
const launches = path.join(root, 'launches');
const hold = path.join(root, 'hold');
await writeFile(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2);
const viewer = args.includes('core.fsmonitor=false') && args.includes('diff');
if (viewer) fs.appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
function run() { const child = cp.spawn(${JSON.stringify(realGit)}, args, {
  stdio: 'inherit', env: { ...process.env, ...${JSON.stringify(gitConfig)} },
}); child.on('exit', code => process.exit(code ?? 1)); }
if (viewer && fs.existsSync(${JSON.stringify(hold)})) setInterval(() => {}, 1000);
else run();
`);
await chmod(path.join(bin, 'git'), 0o755);
const editor = path.join(bin, 'editor');
await writeFile(editor, `#!${process.execPath}
process.stdout.write('DIFF-EDITOR-READY\\n'); process.stdin.setRawMode(true);
process.stdin.on('data', data => { if (data.toString().includes('\\r')) process.exit(0); });
`);
await chmod(editor, 0o755);
const tui = startTui({ cwd, cols: 100, rows: 30,
  entry: path.join(REPO_ROOT, 'spike/fixtures/external-editor-cli.ts'),
  env: { HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${bin}:${process.env['PATH'] ?? ''}`, VISUAL: editor,
    AWS_EC2_METADATA_DISABLED: 'true', DARWIN_MODEL_PRICES_FETCH: 'off' },
});
const draft = () => [...tui.frame.matchAll(/you> ?([^\r\n]*)/g)].at(-1)?.[1]?.trimEnd();
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 30_000, settleMs: 150, label });
const idle = () => draft() === '' && !tui.frame.includes('working…') && !tui.frame.includes('running !') && !tui.frame.includes('allow?');
async function command(text: string, result: string): Promise<void> {
  const mark = tui.mark(); tui.submit(text);
  await tui.waitFor(result, { from: mark, timeoutMs: 30_000, settleMs: 150 });
}
async function calls(): Promise<Array<{ text: string }>> {
  return (await readFile(path.join(cwd, 'editor-model-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function pids(): Promise<number[]> { return (await readFile(launches, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number); }
async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(name));
    else result[name] = (await readFile(name)).toString('base64');
  }
  return result;
}
async function durable(): Promise<Record<string, string>> { return snapshot(path.join(home, '.darwin/sessions')); }
async function launchHeld(): Promise<number> {
  await writeFile(hold, '');
  const n = (await pids()).length;
  tui.submit('/diff ');
  const deadline = Date.now() + 10_000;
  while ((await pids()).length === n && Date.now() < deadline) await delay(20);
  assert.equal((await pids()).length, n + 1);
  return (await pids()).at(-1)!;
}
try {
  await settled(() => draft() === '', 'ready');
  tui.send('/di');
  await settled(() => tui.frame.includes('local Git diff'), 'completion');
  tui.send('\t');
  await settled(() => draft() === '/diff', 'completion inserts command');
  await command('', 'PTY-WORKTREE-PRIVATE');
  assert.deepEqual(await calls(), []);
  await command('/help ', '/diff — local Git diff');
  await command('seed', 'local answer'); await settled(idle, 'seed done');
  const before = await durable();
  const workspace = await snapshot(cwd);
  const config = await readFile(path.join(home, '.darwin/config.json'));
  const callsBefore = await calls();
  for (const [input, output] of [
    ['/diff ', 'unstaged: worktree versus index'],
    ['/DIFF --staged', 'staged: index versus HEAD'],
    ['/diff HEAD', 'Usage: /diff or /diff --staged'],
    ['/diff --staged tracked', 'Usage: /diff or /diff --staged'],
    ['/diff --cached', 'Usage: /diff or /diff --staged'],
  ]) await command(input!, output!);
  assert.deepEqual(await durable(), before, 'sessions/trajectory/diagnostics remain byte-identical');
  assert.deepEqual(await snapshot(cwd), workspace, 'workspace/index/config remain byte-identical');
  assert.deepEqual(await readFile(path.join(home, '.darwin/config.json')), config);
  assert.deepEqual(await calls(), callsBefore, 'no model call');
  assert(tui.frame.split('\n').length <= 30);
  assert(tui.frame.includes('mode: default'), 'permission mode unchanged');
  assert(!tui.frame.includes('PTY-WORKTREE-PRIVATE'), 'diff is Static, not a live row');
  await command('probe', 'local answer'); await settled(idle, 'probe done');
  assert.equal((await calls()).at(-1)?.text, 'probe', 'diff never became a pending shell report');
  // Real pending shell report survives the viewer unchanged.
  await command('!printf ORIGINAL-SHELL', 'ORIGINAL-SHELL'); await settled(idle, 'shell done');
  await command('/diff ', 'PTY-WORKTREE-PRIVATE');
  await command('shell-probe', 'local answer'); await settled(idle, 'shell probe done');
  assert((await calls()).at(-1)?.text.includes('ORIGINAL-SHELL'));
  assert(!(await calls()).at(-1)?.text.includes('PTY-WORKTREE-PRIVATE'));

  const count = (await pids()).length;
  tui.submit('hold'); await settled(() => tui.frame.includes('working…'), 'model busy');
  await command('/diff ', '/diff does not queue');
  await command('/diff --wrong', 'Usage: /diff or /diff --staged');
  assert.equal((await pids()).length, count);
  assert(!tui.frame.includes('queued ·'));
  await writeFile(path.join(cwd, 'hold-release'), '');
  await settled(idle, 'model released');
  assert.equal((await calls()).at(-1)?.text, 'hold');
  tui.submit('!sleep 2'); await settled(() => tui.frame.includes('running'), 'shell busy');
  await command('/diff --staged', '/diff does not queue');
  await settled(idle, 'shell finished');
  assert.equal((await pids()).length, count);
  await command('flush-shell-report', 'local answer'); await settled(idle, 'shell report consumed');
  tui.send('\u0012'); await settled(() => tui.frame.includes('search'), 'history search');
  tui.send('/diff'); await delay(200);
  assert.equal((await pids()).length, count);
  assert(!tui.frame.includes('PTY-WORKTREE-PRIVATE'));
  tui.send('\u001b'); await settled(idle, 'search closed');
  tui.submit('/rewind '); await settled(() => tui.frame.includes('rewind'), 'rewind chooser');
  tui.send('/diff'); await delay(200);
  assert.equal((await pids()).length, count, 'rewind modal owns diff text');
  tui.send('\u001b');
  await settled(() => !tui.frame.includes('rewind prompts') && draft() === '/rewind', 'rewind restores opening draft');
  tui.send('\u0015'); await settled(idle, 'rewind draft cleared');
  tui.submit('permission'); await settled(() => tui.frame.includes('allow?'), 'permission owner');
  tui.send('/diff \r'); await delay(200);
  assert(tui.frame.includes('allow?'));
  assert.equal((await pids()).length, count);
  tui.send('n'); await settled(idle, 'permission denied');
  assert(!existsSync(path.join(cwd, 'permission-sentinel')));
  const editorMark = tui.mark(); tui.send('\u0007');
  await tui.waitFor('DIFF-EDITOR-READY', { from: editorMark });
  tui.send('/diff \r'); await settled(idle, 'editor returned');
  assert.equal((await pids()).length, count);

  const pid = await launchHeld();
  tui.send('\u001b\u001b'); await delay(200);
  assert(!tui.frame.includes('rewind prompts'), 'rewind chord cannot replace a session during inspection');
  await command('/diff --staged', '/diff does not queue');
  await command('/clear ', 'local diff in progress');
  assert.equal((await pids()).at(-1), pid, 'no overlapping viewer');
  const refusedEditor = tui.mark(); tui.send('\u0007');
  await tui.waitFor('Ctrl+G opens the external editor only while darwin is idle', { from: refusedEditor });
  const cancelMark = tui.mark(); tui.send('\u0003');
  await tui.waitFor('cancelled; capture incomplete', { from: cancelMark });
  assert.throws(() => process.kill(pid, 0));
  tui.send('\u0015'); await settled(idle, 'cancel returns composer');
  await rm(hold);
  await writeFile(path.join(cwd, 'hold-session'), '');
  const clearMark = tui.mark(); tui.submit('/clear ');
  const replacementDeadline = Date.now() + 10_000;
  while (!existsSync(path.join(cwd, 'session-waiting')) && Date.now() < replacementDeadline) await delay(20);
  assert(existsSync(path.join(cwd, 'session-waiting')));
  await command('/diff ', '/diff does not queue');
  await writeFile(path.join(cwd, 'session-release'), '');
  await tui.waitFor('new session', { from: clearMark, timeoutMs: 30_000 });
  await settled(() => draft() === '/diff' && !tui.frame.includes('working…'), 'successor retains busy-refused draft unsent');
  await command('', 'PTY-WORKTREE-PRIVATE');
  const durableText = Object.values(await durable()).map(value => Buffer.from(value, 'base64').toString('utf8')).join('\n');
  assert(!durableText.includes('PTY-WORKTREE-PRIVATE'), 'no diff contents in snapshots/trajectory/diagnostics');
  assert(!/"text":"\/diff/.test(durableText), 'no userInput/prompt history for diff');
  const exitPid = await launchHeld();
  tui.send('\u0004'); await tui.exitedWithin(10_000);
  assert.throws(() => process.kill(exitPid, 0));
} finally {
  tui.kill();
  await tui.exitedWithin(10_000).catch(() => undefined);
  for (const pid of await pids()) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  await rm(root, { recursive: true, force: true });
}
console.log('PASS SER-125 production-CLI pty isolation, grammar/discovery, busy/ownership and cleanup');
