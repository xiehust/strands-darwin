/**
 * Peer trust — two narrow relaxations of the collaboration peer gate.
 *
 * 1. Read-only system-info commands (`uname`, `whoami`, `id`, `arch`, `nproc`,
 *    `uptime`, `lsb_release`, bare `hostname`) are on the static safe-command
 *    list, so a peer asking "what OS are you" is answered without any policy
 *    change. `hostname` with an argument can set the host name and stays unsafe.
 * 2. User-only config `trustPeers` (off by default): peer-origin non-safe bash
 *    goes through the ordinary mode/rules/prompt path instead of the hard peer
 *    denial, and a local denial no longer pauses `peer_send`. Everything else the
 *    peer gate protects — memory saves, AGENTS/.darwin/.agents/.mcp.json writes,
 *    collaboration secrets, the read-only sender ceiling — is unchanged.
 *
 * Free suite: no model call, no network (real Unix-socket endpoint for the latch).
 * Run: pnpm tsx spike/verify-peer-trust.ts
 */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import { PermissionGate, assessRisk, classify, type ApprovalMode, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { LocalCollaboration } from '../src/collaboration/local.js';
import { ConfigError, configPath, loadConfig, withModelChoice } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('peer-trust');
const ROOT = path.join(HOME, 'project');

type Action = Awaited<ReturnType<PermissionGate['beforeToolCall']>>;

function fakeEvent(name: string, input: unknown): BeforeToolCallEvent {
  return {
    toolUse: { name, input, toolUseId: `peer-trust-${randomUUID()}` },
    agent: { id: 'darwin', cancelSignal: new AbortController().signal },
  } as unknown as BeforeToolCallEvent;
}

function makeGate(mode: ApprovalMode, trustPeers: boolean, readOnly = false): { gate: PermissionGate; asked: AssessedPermissionRequest[] } {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    mode,
    projectRoot: ROOT,
    ask: async (request) => { asked.push(request); return { allowed: true }; },
    classifier: async () => ({ safe: false, reason: 'test classifier never clears' }),
    peerOrigin: () => true,
    peerReadOnly: () => readOnly,
    trustPeers,
  });
  return { gate, asked };
}

const isPeerDenial = (action: Action): boolean => action.type === 'deny' && action.reason.includes('Peer/policy protection');
const bashRisk = (command: string): string => assessRisk(classify('bash', { mode: 'execute', command }), ROOT).risk;

function safeList(): void {
  header('safe list — read-only system-info commands');
  for (const command of ['uname', 'uname -a', 'uname -srm', 'whoami', 'id', 'id -u', 'arch', 'nproc', 'uptime', 'lsb_release -a', 'hostname', 'uname -a && cat /etc/os-release']) {
    assert(`\`${command}\` is safe`, bashRisk(command) === 'safe');
  }
  for (const command of ['hostname newname', 'hostname -F /tmp/name', 'hostname -b x', 'uname -a > /tmp/out', 'uname && rm -rf x', 'date -s now']) {
    assert(`\`${command}\` stays dangerous`, bashRisk(command) === 'dangerous');
  }
}

async function gateWithoutTrust(): Promise<void> {
  header('trustPeers off (default) — the hard peer denial is unchanged');
  const { gate, asked } = makeGate('yolo', false);
  assert('peer `uname -a` now proceeds (safe list), even with no trust', (await gate.beforeToolCall(fakeEvent('bash', { command: 'uname -a' }))).type === 'proceed');
  assert('peer non-safe bash is still denied in yolo', isPeerDenial(await gate.beforeToolCall(fakeEvent('bash', { command: 'touch x' }))));
  assert('…and the user was never asked', asked.length === 0);
}

async function gateWithTrust(): Promise<void> {
  header('trustPeers on — peer shell work takes the ordinary path');
  const yolo = makeGate('yolo', true);
  assert('peer non-safe bash proceeds in yolo', (await yolo.gate.beforeToolCall(fakeEvent('bash', { command: 'touch x' }))).type === 'proceed');

  const prompted = makeGate('default', true);
  const action = await prompted.gate.beforeToolCall(fakeEvent('bash', { command: 'curl https://example.com' }));
  assert('in default mode the local user is prompted instead', action.type === 'proceed' && prompted.asked.length === 1);

  header('trustPeers on — every other peer protection stays');
  const g = yolo.gate;
  assert('peer memory_save is still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('memory_save', { key: 'a:b', category: 'decision', title: 't', fact: 'f' }))));
  assert('peer AGENTS.md write is still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('fileEditor', { command: 'create', path: 'AGENTS.md', file_text: 'x' }))));
  assert('peer .darwin write is still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('fileEditor', { command: 'create', path: '.darwin/mcp.json', file_text: '{}' }))));
  assert('collaboration secrets via bash are still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('bash', { command: `cat ${HOME}/.darwin/collaboration/hub-node.json` }))));
  assert('`darwin collaborate` controls via bash are still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('bash', { command: 'darwin collaborate hub block x' }))));
  const ceiling = await makeGate('yolo', true, true).gate.beforeToolCall(fakeEvent('bash', { command: 'touch x' }));
  assert('the read-only sender ceiling still blocks writes', ceiling.type === 'deny' && ceiling.reason.includes('Peer sender read-only ceiling'));
}

async function sendLatch(): Promise<void> {
  header('peer_send latch after a local denial');
  for (const trust of [false, true]) {
    const local = new LocalCollaboration(ROOT, `latch-${trust}`, () => false, trust);
    await local.start();
    try {
      local.beginHumanTurn();
      local.permissionDenied();
      const message = await local.send(randomUUID(), 'hello').then(() => '', (error: unknown) => String(error));
      assert(trust ? 'trusted: a denial does not pause peer_send' : 'untrusted: a denial pauses peer_send',
        /permission denial/.test(message) === !trust);
    } finally { local.close('peer trust test'); }
  }
}

async function configField(): Promise<void> {
  header('config — trustPeers');
  const write = async (contents: string): Promise<string> => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(configPath(ROOT), contents, 'utf8');
    return ROOT;
  };
  assert('off by default', (await loadConfig(await write('{}'))).trustPeers === false);
  const on = await loadConfig(await write('{ "trustPeers": true }'));
  assert('explicit true is accepted', on.trustPeers === true);
  assert('it survives a /model switch', withModelChoice(on, on.modelChoices[0]!).trustPeers === true);
  const bad = await loadConfig(await write('{ "trustPeers": "yes" }')).then(() => '', (error: unknown) => error instanceof ConfigError ? error.message : 'other');
  assert('a non-boolean value is refused by name', bad.includes('trustPeers'));
  const nested = await loadConfig(await write('{ "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5", "trustPeers": true }] }'))
    .then(() => '', (error: unknown) => error instanceof ConfigError ? error.message : 'other');
  assert('a models entry carrying it is refused', nested.includes('trustPeers'));
}

async function main(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  safeList();
  await gateWithoutTrust();
  await gateWithTrust();
  await sendLatch();
  await configField();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
