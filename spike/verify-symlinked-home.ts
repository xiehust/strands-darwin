/**
 * HOME reached through a symlink (`/home -> /local/home` on many dev hosts).
 *
 * Darwin's user-state readers refuse symlinks so a planted link cannot redirect them, but that
 * rule belongs to what Darwin owns — HOME and everything under it — not to where the machine
 * mounted HOME. Before the fix, a first launch on such a host failed with
 * "Could not read ~/.darwin/config.json: AgentCore state path refused", and collaboration,
 * /list-agents and `permissions test` refused their stores the same way.
 *
 * Proves, with HOME = <tmp>/link/user where <tmp>/link -> <tmp>/real: `darwin doctor` (the real
 * CLI) and loadConfig read an absent and a present config; AgentCore state writes/reads; the
 * collaboration store is created and an endpoint starts; /list-agents reads the session store;
 * and every no-symlink rule *inside* HOME still holds (a linked `~/.darwin`, a linked state dir
 * and a linked collaboration dir are all still refused). Free: no model, no network.
 *
 * Run: pnpm tsx spike/verify-symlinked-home.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = mkdtempSync(path.join(os.tmpdir(), 'darwin-symhome-'));
mkdirSync(path.join(base, 'real', 'user'), { recursive: true, mode: 0o755 });
symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
const HOME = path.join(base, 'link', 'user');
const original = process.env['HOME'];
process.env['HOME'] = HOME;
process.on('exit', () => { process.env['HOME'] = original ?? ''; rmSync(base, { recursive: true, force: true }); });

const { assert, header, report } = await import('./shared.js');
const { loadConfig, configFilePath } = await import('../src/config.js');
const { readState, writeState } = await import('../src/agentcore/state.js');
const { checkStore } = await import('../src/collaboration/storage.js');
const { LocalCollaboration } = await import('../src/collaboration/local.js');
const { readLocalAgents } = await import('../src/list-agents.js');
const { userDarwinDir, userSessionsDir } = await import('../src/paths.js');

const project = path.join(base, 'real', 'project');
mkdirSync(project);
const refused = async (run: () => unknown): Promise<string> => {
  try { await run(); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
};

header('the reported failure: first launch, no ~/.darwin yet');
const ext = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const cli = fileURLToPath(new URL(`../src/cli.${ext}`, import.meta.url));
const doctor = spawnSync(process.execPath, [...(ext === 'ts' ? ['--import', import.meta.resolve('tsx')] : []), cli, 'doctor'], {
  cwd: project, env: { ...process.env, HOME }, encoding: 'utf8', timeout: 60_000,
});
assert('darwin doctor exits 0', doctor.status === 0);
assert('…and reports no config problem', !/Could not read|state path refused/.test(doctor.stdout + doctor.stderr));
assert('loadConfig with no file returns the defaults', (await loadConfig(project)).model !== undefined);

header('a present config and AgentCore state under the linked HOME');
mkdirSync(userDarwinDir(), { mode: 0o700 });
writeFileSync(configFilePath(), '{ "terminalBell": true }');
assert('a present config is read', (await loadConfig(project)).terminalBell === true);
const stateFile = path.join(userDarwinDir(), 'agentcore', 'probe', 'approval.json');
await writeState(stateFile, { ok: 1 });
assert('AgentCore state is written and read back', JSON.stringify(await readState(stateFile)) === '{"ok":1}');

header('collaboration store and /list-agents');
assert('the collaboration store is created', (await refused(() => checkStore(true))) === '');
const local = new LocalCollaboration(project, 'symlinked-home');
await local.start();
assert('a collaboration endpoint starts', local.address !== undefined && !local.takeNotices().some(n => /unavailable|Unsafe/.test(n)));
local.close('symlinked home verified');
mkdirSync(userSessionsDir(), { recursive: true, mode: 0o700 });
assert('/list-agents reads the session store', (await readLocalAgents(project)).state !== 'unavailable');

header('links inside HOME are still refused');
const moved = path.join(HOME, 'darwin-elsewhere');
renameSync(userDarwinDir(), moved); symlinkSync(moved, userDarwinDir());
assert('a linked ~/.darwin: config read refused', /Could not read/.test(await refused(() => loadConfig(project))));
assert('a linked ~/.darwin: collaboration store refused', /Unsafe collaboration directory/.test(await refused(() => checkStore())));
assert('a linked ~/.darwin: /list-agents unavailable', (await readLocalAgents(project)).state === 'unavailable');
rmSync(userDarwinDir()); renameSync(moved, userDarwinDir());
const agentcore = path.join(userDarwinDir(), 'agentcore');
renameSync(agentcore, path.join(HOME, 'agentcore-elsewhere')); symlinkSync(path.join(HOME, 'agentcore-elsewhere'), agentcore);
assert('a linked state directory is refused', /state path refused/.test(await refused(() => readState(stateFile))));
const collab = path.join(userDarwinDir(), 'collaboration');
renameSync(collab, path.join(HOME, 'collab-elsewhere')); symlinkSync(path.join(HOME, 'collab-elsewhere'), collab);
assert('a linked collaboration directory is refused', /Unsafe collaboration directory/.test(await refused(() => checkStore())));

report();
