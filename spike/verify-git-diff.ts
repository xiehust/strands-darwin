/**
 * SER-125 requirement-to-test checklist (real files/Git/processes, no model/network):
 * G1 exact case-insensitive name / fixed argument grammar -> grammar.
 * G2 independent scopes, unborn, empty chosen scope, binary, untracked/submodule exclusions -> repos.
 * G3 no pager/external/textconv/fsmonitor/filter helpers, no index/config/workspace writes -> sentinels + snapshots.
 * G4 bounded storage/lines/width, escaped controls, honest errors/truncation -> bounds + failures.
 * G5 timeout/cancel reap; cwd/argv/env scrub/DARWIN -> process fixtures.
 * TUI ownership/isolation/cleanup/discovery -> verify-git-diff-pty.ts; completion -> verify-tui.ts completion.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DIFF_MAX_BYTES, DIFF_MAX_LINES, DIFF_MAX_LINE_POINTS, DIFF_TIMEOUT_MS, parseDiffCommand, runGitDiff } from '../src/tui/git-diff.js';
import { scrubShellEnv } from '../src/tools/shell-env.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-git-diff-'));
const home = path.join(root, 'home');
await mkdir(home);
const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const view = (cwd: string, scope: 'staged' | 'unstaged' = 'unstaged') => runGitDiff({ projectRoot: cwd, scope, env }).result;
async function repo(name: string): Promise<string> {
  const cwd = path.join(root, name);
  await mkdir(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Test');
  return cwd;
}
async function snapshot(dir: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(name, `${prefix}${entry.name}/`));
    else result[`${prefix}${entry.name}`] = (await readFile(name)).toString('base64');
  }
  return result;
}
try {
  for (const text of ['/diff', ' /DIFF \t']) assert.equal(parseDiffCommand(text), 'unstaged');
  for (const text of ['/diff --staged', '/DiFf\t--staged\n']) assert.equal(parseDiffCommand(text), 'staged');
  for (const text of ['/diff HEAD', '/diff file', '/diff --cached', '/diff --STAGED', '/diff --staged file', '/diff --staged --staged', '/diff ; echo BAD', '/diff\n--output=x']) assert.equal(parseDiffCommand(text), 'usage');
  for (const text of ['/diffs', '/diff--staged', '!git diff', 'diff', 'x /diff']) assert.equal(parseDiffCommand(text), undefined);

  const cwd = await repo('project');
  await writeFile(path.join(cwd, 'tracked'), 'HEAD-CONTENT\n');
  await writeFile(path.join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  await writeFile(path.join(cwd, 'tracked'), 'INDEX-CONTENT\n');
  git(cwd, 'add', 'tracked');
  await writeFile(path.join(cwd, 'tracked'), 'WORKTREE-CONTENT\n');
  await writeFile(path.join(cwd, 'binary'), Buffer.from([0, 2, 3]));
  await writeFile(path.join(cwd, 'untracked'), 'UNTRACKED-SECRET');
  const sub = path.join(cwd, 'sub');
  await mkdir(sub); git(sub, 'init', '-q');
  await writeFile(path.join(sub, 'secret'), 'SUBMODULE-SECRET');
  git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${git(cwd, 'rev-parse', 'HEAD').trim()},sub`);
  const before = await snapshot(cwd);
  const unstaged = await view(cwd);
  const staged = await view(cwd, 'staged');
  assert.match(unstaged, /unstaged: worktree versus index/);
  assert.match(unstaged, /-INDEX-CONTENT\n\+WORKTREE-CONTENT/);
  assert.match(unstaged, /Binary files .* differ/);
  assert(!unstaged.includes('HEAD-CONTENT'));
  assert.match(staged, /staged: index versus HEAD/);
  assert.match(staged, /-HEAD-CONTENT\n\+INDEX-CONTENT/);
  assert(!staged.includes('WORKTREE-CONTENT'));
  for (const text of [staged, unstaged]) {
    assert.match(text, /Untracked contents and submodule contents excluded/);
    assert(!text.includes('UNTRACKED-SECRET') && !text.includes('SUBMODULE-SECRET') && !text.includes('a/sub'));
  }
  assert.deepEqual(await snapshot(cwd), before);

  const unborn = await repo('unborn');
  await writeFile(path.join(unborn, 'new'), 'UNBORN-INDEX\n'); git(unborn, 'add', 'new');
  assert.match(await view(unborn, 'staged'), /\+UNBORN-INDEX/);
  assert.match(await view(unborn), /No changes in this selected scope; this does not mean the whole tree is clean/);
  git(cwd, 'reset', '-q', 'HEAD');
  assert.match(await view(cwd, 'staged'), /No changes in this selected scope/);

  const sentinel = path.join(root, 'helper-ran');
  const helper = path.join(root, 'hostile-helper');
  await writeFile(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'BAD');\n`);
  await chmod(helper, 0o755);
  for (const key of ['core.pager', 'pager.diff', 'diff.external', 'diff.hostile.command', 'diff.hostile.textconv', 'core.fsmonitor']) git(cwd, 'config', key, helper);
  git(cwd, 'config', 'submodule.recurse', 'true');
  git(cwd, 'config', 'diff.submodule', 'diff');
  git(cwd, 'config', 'color.ui', 'always');
  await writeFile(path.join(cwd, '.gitattributes'), '* diff=hostile\n');
  const hostileBefore = await snapshot(cwd);
  const hostileView = await view(cwd);
  assert.match(hostileView, /WORKTREE-CONTENT/);
  assert.deepEqual(await snapshot(cwd), hostileBefore);
  assert(!existsSync(sentinel));
  assert(!hostileView.includes('\\u001b'), 'Git color disabled, not merely escaped');
  await writeFile(path.join(cwd, '.gitattributes'), '* diff=hostile filter=hostile\n');
  for (const key of ['filter.hostile.clean', 'filter.hostile.process', 'remote.origin.promisor', 'extensions.partialclone']) {
    git(cwd, 'config', key, key.endsWith('promisor') ? 'true' : helper);
    const refusedBefore = await snapshot(cwd);
    assert.match(await view(cwd), /configured clean\/process filters or promisor remotes are not supported/);
    assert.deepEqual(await snapshot(cwd), refusedBefore);
    assert(!existsSync(sentinel));
    git(cwd, 'config', '--unset', key);
  }
  await writeFile(path.join(cwd, 'tracked'), 'control-\u001b]52;unsafe\u0007\r\u009b\u202e\t\n');
  const controls = await view(cwd);
  assert.match(controls, /\\u001b\]52;unsafe\\u0007\\u000d\\u009b\\u202e\\u0009/);
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/.test(controls));
  await writeFile(path.join(cwd, 'tracked'), 'x'.repeat(800) + '\n');
  const wide = await view(cwd);
  assert.match(wide, /truncated; capture incomplete/);
  assert(wide.split('\n').every(line => [...line].length <= DIFF_MAX_LINE_POINTS), 'ellipsis fits inside the width cap');
  await writeFile(path.join(cwd, 'tracked'), 'row\n'.repeat(DIFF_MAX_LINES * 2));
  const rows = await view(cwd);
  assert.match(rows, /truncated; capture incomplete/);
  assert(rows.split('\n').length <= DIFF_MAX_LINES + 4);
  await writeFile(path.join(cwd, 'tracked'), 'huge\n'.repeat(DIFF_MAX_BYTES));
  const huge = await view(cwd);
  assert.match(huge, /output limit reached; capture incomplete/);
  assert(Buffer.byteLength(huge) < DIFF_MAX_BYTES);
  const nonrepo = await view(home);
  assert.match(nonrepo, /Git failed/);
  assert(!nonrepo.includes('No changes in this selected scope'));
  assert.match(await runGitDiff({ projectRoot: cwd, scope: 'unstaged', env: { PATH: root } }).result, /could not start Git/);

  // Real executable fixture: observes argv/env/cwd, or holds a process for cancel/timeout.
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const processLog = path.join(root, 'process.json');
  const fixture = path.join(bin, 'git');
  await writeFile(fixture, `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(processLog)}, JSON.stringify({pid:process.pid, argv:process.argv.slice(2), cwd:process.cwd(), env:process.env}));
if (process.env.TEST_HOLD) { setInterval(() => {}, 1000); }
else if (process.argv.includes('config')) process.exit(1);
else { process.stderr.write('fixture failure\\u001b[2J'); process.exit(7); }
`);
  await chmod(fixture, 0o755);
  const processEnv = scrubShellEnv({ ...env, PATH: bin, AWS_SECRET_ACCESS_KEY: 'do-not-inherit', KEEP_ME: 'yes', DARWIN: 'bad', GIT_DIR: '/wrong', GIT_TRACE: path.join(root, 'trace') }, []).env;
  assert.match(await runGitDiff({ projectRoot: cwd, scope: 'staged', env: processEnv }).result, /Git failed \(exit 7\)/);
  const observed = JSON.parse(await readFile(processLog, 'utf8'));
  assert.equal(observed.cwd, cwd);
  assert.equal(observed.env.DARWIN, 'bad', 'existing marker preserved');
  assert.equal(observed.env.KEEP_ME, 'yes');
  assert.equal(observed.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(observed.env.GIT_DIR, undefined);
  assert.equal(observed.env.GIT_TRACE, undefined);
  assert(observed.argv.includes('--cached') && observed.argv.includes('--no-ext-diff') && observed.argv.includes('--no-textconv'));
  assert.equal(observed.argv.at(-1), '--');
  assert(!existsSync(path.join(root, 'trace')));
  const explicitEnv = scrubShellEnv({ ...processEnv, DARWIN: undefined, AWS_SECRET_ACCESS_KEY: 'explicit' }, ['AWS_SECRET_ACCESS_KEY']).env;
  await runGitDiff({ projectRoot: cwd, scope: 'unstaged', env: explicitEnv }).result;
  const explicit = JSON.parse(await readFile(processLog, 'utf8'));
  assert.equal(explicit.env.DARWIN, '1', 'default marker installed');
  assert.equal(explicit.env.AWS_SECRET_ACCESS_KEY, 'explicit', 'user passthrough preserved');
  for (const mode of ['cancel', 'timeout'] as const) {
    await rm(processLog);
    const start = Date.now();
    const running = runGitDiff({ projectRoot: cwd, scope: 'unstaged', env: { ...processEnv, TEST_HOLD: '1' } });
    const deadline = Date.now() + 3_000;
    while (!existsSync(processLog) && Date.now() < deadline) await delay(10);
    assert(existsSync(processLog));
    const { pid } = JSON.parse(await readFile(processLog, 'utf8'));
    if (mode === 'cancel') running.cancel();
    const result = await running.result;
    assert.match(result, mode === 'cancel' ? /cancelled; capture incomplete/ : /timed out; capture incomplete/);
    assert(Date.now() - start < DIFF_TIMEOUT_MS + 2_000);
    assert.throws(() => process.kill(pid, 0));
  }
} finally { await rm(root, { recursive: true, force: true }); }
console.log('PASS SER-125 Git grammar, scopes, helper sentinels, preservation, bounds and process failures');
