/** Offline update CLI verification: real loopback HTTP, real executable npm fixture, real bootstrap.
 * No actual package installation, provider call or external network. Fixture writes stay in its private temp tree.
 * Run: pnpm tsx spike/verify-update-command.ts
 */
import check from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_USAGE, usageErrorText } from '../src/cli-usage.js';
import { DARWIN_VERSION } from '../src/version.js';
import { assert, header, report } from './shared.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'darwin-update-command-'));
const home = path.join(scratch, 'home'), prefix = path.join(scratch, 'prefix with spaces');
const installed = path.join(prefix, 'lib/node_modules/strands-darwin');
const ledger = path.join(scratch, 'npm-calls.jsonl'), npm = path.join(scratch, 'npm');
await mkdir(home); await mkdir(path.join(installed, 'dist/src'), { recursive: true });
await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'strands-darwin', type: 'module', version: '0.0.1' }));
const cliFile = path.join(installed, 'dist/src/cli.js');
const restore = () => writeFile(cliFile, 'console.log("darwin 0.0.1");');
await restore();
await writeFile(npm, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const args = process.argv.slice(2), mode = process.env.UPDATE_FIXTURE_MODE;
fs.appendFileSync(process.env.UPDATE_FIXTURE_LEDGER, JSON.stringify(args) + '\\n');
if (args[0] === 'prefix') {
  console.log(mode === 'mismatch' ? '/wrong-prefix' : process.env.UPDATE_FIXTURE_PREFIX);
} else if (args[0] === 'install') {
  if (mode === 'fail') { console.error('EACCES fixture'); process.exit(7); }
  if (mode === 'hang') {
    process.on('SIGTERM', () => {});
    const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'inherit' });
    fs.writeFileSync(process.env.UPDATE_FIXTURE_PID, String(child.pid));
    setInterval(() => {}, 1000);
  } else if (mode !== 'unchanged') {
    const version = args[2].split('@')[1];
    const target = path.join(process.env.UPDATE_FIXTURE_PREFIX, 'lib/node_modules/strands-darwin/dist/src/cli.js');
    fs.writeFileSync(target, mode === 'broken' ? 'throw new Error("unpatched SDK fixture");' : 'console.log("darwin ' + version + '");');
  }
} else { process.exit(8); }
`);
await chmod(npm, 0o700);

let answer = '{"version":"0.0.2"}', status = 200, slow = false, hits = 0;
const server = createServer((_req, res) => {
  hits++;
  if (slow) return; // real abort/timeout, no provider or external request
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(answer);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('loopback address unavailable');
const url = `http://127.0.0.1:${address.port}/latest`;
const moduleUrl = pathToFileURL(path.join(ROOT, 'src/cli-update.ts')).href;
const env = {
  ...process.env, HOME: home, DARWIN_NO_UPDATE_CHECK: '1',
  UPDATE_FIXTURE_PREFIX: prefix, UPDATE_FIXTURE_LEDGER: ledger,
  UPDATE_FIXTURE_PID: path.join(scratch, 'descendant.pid'),
};
async function calls(): Promise<string[][]> {
  return (await readFile(ledger, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function run(args: string[] = [], overrides: Record<string, unknown> = {}, mode = 'ok', signal = false) {
  const options = { currentVersion: '0.0.1', packageRoot: installed, registryUrl: url, requestTimeoutMs: 500, npmCommand: npm, ...overrides };
  const script = `import { runUpdateCli } from ${JSON.stringify(moduleUrl)}; await runUpdateCli(${JSON.stringify(args)}, ${JSON.stringify(options)});`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { cwd: installed, env: { ...env, UPDATE_FIXTURE_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 8000);
  const cancel = signal ? setInterval(() => {
    readFile(env.UPDATE_FIXTURE_PID, 'utf8').then(() => { child.kill('SIGINT'); clearInterval(cancel!); }).catch(() => {});
  }, 20) : undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); if (cancel !== undefined) clearInterval(cancel); }
}
try {

header('manual checks: uncached, explicit errors, no installation or config/cache writes');
await mkdir(path.join(home, '.darwin'));
await writeFile(path.join(home, '.darwin/config.json'), '{ invalid config');
await writeFile(path.join(home, '.darwin/update-check.json'), '{"checkedAt":9999999999999,"latest":"0.0.1"}');
const cacheBefore = await readFile(path.join(home, '.darwin/update-check.json'), 'utf8');
const initialHits = hits;
for (let count = 0; count < 2; count++) {
  const result = await run();
  check.equal(result.code, 0); check.equal(result.stderr, '');
  check.ok(result.stdout.includes('installed 0.0.1, latest 0.0.2'));
  check.ok(result.stdout.includes('darwin update --install'));
}
check.equal(hits - initialHits, 2); check.deepEqual(await calls(), []);
check.equal(await readFile(path.join(home, '.darwin/update-check.json'), 'utf8'), cacheBefore);
assert('explicit checks bypass off switch/cache, never spawn npm, and leave the cache unchanged', true);
for (const latest of ['0.0.1', '0.0.0', '0.0.1-beta.1']) {
  answer = JSON.stringify({ version: latest });
  const result = await run(); check.equal(result.code, 0); check.ok(result.stdout.includes('Already up to date'));
}
assert('equal/older/prerelease registry versions never trigger downgrade or installation', true);
for (const [body, httpStatus] of [['{"version":"0.0.2"}', 404], ['bad JSON', 200], ['{}', 200], ['{"version":"$(touch BAD)"}', 200], ['x'.repeat(600_000), 200]] as const) {
  answer = body; status = httpStatus;
  const result = await run(['--install']); check.equal(result.code, 1); check.ok(result.stderr.startsWith('error: update:'));
  check.ok(!result.stdout.includes('Updated to')); check.deepEqual(await calls(), []);
}
status = 200; answer = '{"version":"0.0.2"}'; slow = true;
const timeout = await run([], { requestTimeoutMs: 50 }); check.equal(timeout.code, 1); check.ok(timeout.stderr.startsWith('error: update:'));
slow = false;
assert('HTTP/JSON/version/streamed-size/timeout failures are visible and never launch npm', true);
const beforeUnknown = hits;
check.equal((await run([], { currentVersion: 'unknown' })).code, 1); check.equal(hits, beforeUnknown);
assert('unknown installed identity refuses before network work', true);

header('installation: exact version, same prefix, bounded failure/cancel, verified CLI');
const success = await run(['--install']);
check.equal(success.code, 0, success.stderr); check.ok(success.stdout.includes('Updated to 0.0.2'));
check.deepEqual(await calls(), [
  ['prefix', '-g'], ['install', '-g', 'strands-darwin@0.0.2', '--prefix', prefix, '--no-audit', '--no-fund'],
]);
assert('explicit install pins the checked version and preserves a prefix with spaces without a shell', true);
for (const mode of ['fail', 'unchanged', 'broken']) {
  await restore(); const before = (await calls()).length;
  const result = await run(['--install'], {}, mode);
  check.equal(result.code, 1); check.ok(!result.stdout.includes('Updated to'));
  check.ok(result.stderr.includes('No automatic retry or rollback'));
  check.equal((await calls()).length - before, 2);
}
assert('permission denial/zero-exit unchanged/broken installed CLI never claim success or retry', true);
await restore();
const beforeMismatch = (await calls()).length;
const mismatch = await run(['--install'], {}, 'mismatch');
check.equal(mismatch.code, 1); check.ok(mismatch.stderr.includes('refusing to modify another installation'));
check.equal((await calls()).length - beforeMismatch, 1);
assert('a different npm prefix is refused before installation', true);
const linked = path.join(scratch, 'linked-target');
await rename(installed, linked); await symlink(linked, installed);
try {
  const before = (await calls()).length;
  const result = await run(['--install'], { packageRoot: linked });
  check.equal(result.code, 1); check.ok(result.stderr.includes('refusing to modify another installation'));
  check.equal((await calls()).length - before, 1);
} finally { await rm(installed); await rename(linked, installed); }
assert('an npm link without a .git entry is still refused rather than replaced', true);
const checkout = path.join(scratch, 'checkout'); await mkdir(checkout);
for (const gitKind of ['directory', 'file']) {
  if (gitKind === 'directory') await mkdir(path.join(checkout, '.git'));
  else await writeFile(path.join(checkout, '.git'), 'gitdir: fixture');
  const before = hits, npmBefore = (await calls()).length;
  const result = await run(['--install'], { packageRoot: checkout });
  check.equal(result.code, 1); check.ok(result.stderr.includes('source checkout/link'));
  check.equal(hits, before); check.equal((await calls()).length, npmBefore);
  await rm(path.join(checkout, '.git'), { recursive: true });
}
assert('checkout/worktree installation refuses with zero network/npm actions', true);
for (const cancel of [false, true]) {
  await rm(env.UPDATE_FIXTURE_PID, { force: true });
  const before = (await calls()).length;
  const result = await run(['--install'], { installTimeoutMs: cancel ? 5000 : 500 }, 'hang', cancel);
  check.equal(result.code, 1); check.ok(result.stderr.includes(cancel ? 'cancelled' : 'timed out'));
  check.equal((await calls()).length - before, 2);
  const pid = Number(await readFile(env.UPDATE_FIXTURE_PID, 'utf8'));
  let running = true;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    running = false;
  }
  if (running && process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); running = !/^.*\) Z /.test(stat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      running = false; // It was reaped between the signal probe and procfs read.
    }
  }
  check.equal(running, false);
}
assert('timeout and SIGINT stop npm plus its stubborn descendant process group, without a retry', true);

header('production bootstrap: local grammar/help, checkout guard, no runtime/config/hooks');
function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'src/cli.ts'), ...args],
    { cwd: home, env, encoding: 'utf8', timeout: 10_000 });
}
for (const args of [['--check'], ['extra'], ['--install', '--install'], ['--install', '-p', 'hello']]) {
  const result = cli(['update', ...args]);
  check.equal(result.status, 2); check.equal(result.stdout, ''); check.equal(result.stderr, usageErrorText('usage: darwin update [--install]'));
}
for (const flag of ['--help', '-h', '--version', '-V']) {
  const result = cli(['--', 'update', 'bad', flag]); check.equal(result.status, 0); check.equal(result.stderr, '');
  check.equal(result.stdout, flag === '--help' || flag === '-h' ? CLI_USAGE : `darwin ${DARWIN_VERSION}\n`);
}
check.equal(cli(['update', '--version', '--help']).stdout, CLI_USAGE);
const actualCheckout = cli(['update', '--install']); check.equal(actualCheckout.status, 1);
check.ok(actualCheckout.stderr.includes('source checkout/link'));
check.deepEqual((await readdir(home)).sort(), ['.darwin']);
check.deepEqual((await readdir(path.join(home, '.darwin'))).sort(), ['config.json', 'update-check.json']);
check.equal(await readFile(path.join(home, '.darwin/config.json'), 'utf8'), '{ invalid config');
check.equal(await readFile(path.join(home, '.darwin/update-check.json'), 'utf8'), cacheBefore);
const bootstrap = await readFile(path.join(ROOT, 'src/cli.ts'), 'utf8');
check.ok(bootstrap.indexOf("args[0] === 'update'") < bootstrap.indexOf("import('./cli-main.js')"));
assert('real CLI preserves exit 2/help precedence and runs no config/session machinery', true);
report();

} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
}
