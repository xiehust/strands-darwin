/**
 * Live darwin-to-darwin run through the deployed hub (*live*; needs `pnpm stack-deploy` and the
 * deployer's credentials). Two private HOMEs stand in for two machines: each is enrolled through
 * the real `darwin collaborate hub enroll` CLI with a real minted token, and each runs a real
 * LocalCollaboration node process. Both nodes are revoked at the end; HOMEs are removed.
 */
import assert from 'node:assert/strict';
import { execFile, fork, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENROLL_TOKEN_TTL_MS, mintToken } from '../../src/collaboration/hub-wire.js';
import { mint, revoke } from '../src/handlers.js';
import { operatorContext } from '../scripts/operator.js';

const { ctx, outputs } = operatorContext();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = ['--import', import.meta.resolve('tsx')];
const children: ChildProcess[] = [];
const homes: string[] = [];
const nodes: string[] = [];
let sequence = 0;

function machine(label: string, origin: string) {
  const home = mkdtempSync(`/tmp/dhl${label}-`); homes.push(home);
  const project = path.join(home, 'p'); mkdirSync(project);
  spawnSync('git', ['init', '-q', project]); spawnSync('git', ['-C', project, 'remote', 'add', 'origin', origin]);
  return { home, project };
}
function cli(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => execFile(process.execPath, [...tsx, path.join(repo, 'src/cli.ts'), 'collaborate', ...args], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60_000 },
    (error, out, err) => resolve({ code: error ? 1 : 0, out, err })));
}
async function start(home: string, project: string): Promise<ChildProcess> {
  const child = fork(path.join(repo, 'spike/fixtures/hub-process.ts'), [project, `live-${randomUUID().slice(0, 8)}`], { env: { ...process.env, HOME: home }, execArgv: tsx, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push(child);
  await new Promise(resolve => child.once('message', resolve));
  return child;
}
function ask(child: ChildProcess, op: string, fields: Record<string, unknown> = {}): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} timeout`)), 30_000);
    const receive = (value: any) => { if (value.id !== id) return; clearTimeout(timer); child.off('message', receive); value.error ? reject(new Error(value.error)) : resolve(value.result); };
    child.on('message', receive); child.send({ id, op, ...fields });
  });
}
async function until(what: string, test: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 150; n++) { if (await test()) return; await new Promise(r => setTimeout(r, 200)); }
  throw new Error(`timeout: ${what}`);
}

try {
  const A = machine('A', 'git@github.com:acme/alpha.git');
  const B = machine('B', 'git@github.com:acme/beta.git');
  for (const [m, name] of [[A, 'live-alpha'], [B, 'live-beta']] as const) {
    const token = mintToken(); await mint(ctx, token, ENROLL_TOKEN_TTL_MS, 'verify-live-darwin');
    const result = await cli(m.home, ['hub', 'enroll', outputs['HubUrl']!, token, '--name', name]);
    assert.equal(result.code, 0, result.err);
    nodes.push(JSON.parse(readFileSync(path.join(m.home, '.darwin/collaboration/hub-node.json'), 'utf8')).node);
    console.log(`ok enrolled ${name} through the real CLI`);
  }
  const a = await start(A.home, A.project);
  const b = await start(B.home, B.project);
  await until('both connected', async () => (await ask(a, 'state')).state === 'connected' && (await ask(b, 'state')).state === 'connected');
  const addrB = (await ask(b, 'state')).hub;
  await until('B discoverable from A', async () => (await ask(a, 'discover')).hub.endpoints.some((row: any) => row.address.endpoint === addrB.endpoint));
  console.log('ok A discovers B through the deployed hub');
  assert.match(await ask(a, 'send', { target: addrB.endpoint, text: 'hello from alpha via AWS' }), /^Queued .* via hub/);
  const taken = await ask(b, 'take');
  assert.equal(taken.envelope.text, 'hello from alpha via AWS');
  assert.equal(taken.envelope.sender.project, 'github.com/acme/alpha');
  assert.match(await ask(b, 'reply', { text: 'reply from beta via AWS' }), /^Queued/);
  const back = await ask(a, 'take');
  assert.equal(back.envelope.text, 'reply from beta via AWS');
  assert.equal(back.envelope.chain.hop, 1);
  console.log('ok send, receive and reply between two darwin nodes, no confirmation');
  const status = await cli(A.home, ['hub', 'status']);
  assert.equal(status.code, 0); assert.match(status.out, /"enrolled": true/);
  console.log('ok collaborate hub status reports the enrolled node');
} finally {
  for (const child of children) child.kill();
  for (const node of nodes) await revoke(ctx, node).catch(() => undefined);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}
console.log(`verify-live-darwin: passed (${nodes.length} nodes revoked, HOMEs removed)`);
