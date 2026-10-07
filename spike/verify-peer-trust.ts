/**
 * Peer shell work always takes the ordinary mode/rules/classifier/prompt path.
 * Read-only system-info commands stay on the static safe list; non-safe shell
 * calls are not denied solely for peer origin, including before Pre hooks.
 * User-only config `trustPeers` (off by default) only lifts the local-denial
 * `peer_send` latch. Memory saves, AGENTS/.darwin/.agents/.mcp.json paths,
 * collaboration secrets/controls and the read-only sender ceiling stay protected.
 *
 * Free suite: no model call, no network (real Unix-socket endpoint for the latch).
 * Run: pnpm tsx spike/verify-peer-trust.ts
 */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import { PermissionGate, assessRisk, classify, type ApprovalMode, type AssessedPermissionRequest, type PermissionGateOptions } from '../src/agent/permission.js';
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

function makeGate(mode: ApprovalMode, readOnly = false, overrides: Partial<PermissionGateOptions> = {}): { gate: PermissionGate; asked: AssessedPermissionRequest[] } {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    mode,
    projectRoot: ROOT,
    ask: async (request) => { asked.push(request); return { allowed: true }; },
    classifier: async () => ({ safe: false, reason: 'test classifier never clears' }),
    peerOrigin: () => true,
    peerReadOnly: () => readOnly,
    ...overrides,
  });
  return { gate, asked };
}

const isPeerDenial = (action: Action | undefined): boolean => action?.type === 'deny' && action.reason.includes('Peer/policy protection');
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

async function ordinaryShell(): Promise<void> {
  header('peer shell — the ordinary permission path, without a trust opt-in');
  const shell = () => fakeEvent('bash', { mode: 'execute', command: 'curl https://example.com' });
  const yolo = makeGate('yolo');
  assert('peer safe shell proceeds', (await yolo.gate.beforeToolCall(fakeEvent('bash', { command: 'uname -a' }))).type === 'proceed');
  assert('peer non-safe shell is not denied before Pre hooks', yolo.gate.guardBeforeHooks(shell()) === undefined);
  assert('peer non-safe shell proceeds in yolo without prompting', (await yolo.gate.beforeToolCall(shell())).type === 'proceed' && yolo.asked.length === 0);

  const prompted = makeGate('default');
  const action = await prompted.gate.beforeToolCall(shell());
  assert('default mode prompts the local user', action.type === 'proceed' && prompted.asked.length === 1);
  const refused = makeGate('default', false, { ask: async () => ({ allowed: false }) });
  const refusal = await refused.gate.beforeToolCall(shell());
  assert('the user can still refuse peer shell work', refusal.type === 'deny' && refusal.reason.includes('The user denied permission') && !isPeerDenial(refusal));

  const auto = makeGate('auto');
  assert('auto escalates a classifier refusal to the local user', (await auto.gate.beforeToolCall(shell())).type === 'proceed' && auto.asked.length === 1);
  let classified = 0;
  const cleared = makeGate('auto', false, { classifier: async () => { classified++; return { safe: true, reason: 'test classifier clears' }; } });
  assert('auto can clear peer shell work without prompting', (await cleared.gate.beforeToolCall(shell())).type === 'proceed' && classified === 1 && cleared.asked.length === 0);

  const allowed = makeGate('default', false, { allowRules: ['bash:curl *'] });
  assert('an ordinary allow-rule clears peer shell work', (await allowed.gate.beforeToolCall(shell())).type === 'proceed' && allowed.asked.length === 0);
  for (const mode of ['default', 'auto', 'plan', 'yolo'] as const) {
    const denied = makeGate(mode, false, { allowRules: ['bash'], denyRules: ['bash:curl *'] });
    const early = denied.gate.guardBeforeHooks(shell());
    const decision = await denied.gate.beforeToolCall(shell());
    assert(`${mode}: deny-rules still win before hooks and ordinary approval`, early?.type === 'deny' && decision.type === 'deny' && decision.reason.includes('blocked by deny rule') && denied.asked.length === 0);
  }
  const plan = makeGate('plan');
  const blocked = await plan.gate.beforeToolCall(shell());
  assert('plan still denies peer shell execution before prompting', blocked.type === 'deny' && blocked.reason.includes('Plan mode blocked') && plan.asked.length === 0);

  const child = makeGate('default', false, { dispatchSource: () => ({ label: 'general#peer-child', dispatchId: 'peer-child', agentName: 'general' }) });
  assert('a child of a peer turn also takes the ordinary permission path', (await child.gate.beforeToolCall(shell())).type === 'proceed' && child.asked[0]?.source.kind === 'child');
}

async function collaborationOperands(): Promise<void> {
  header('collaboration guard — operands, not source-path substrings or unrelated segments');
  // The actual refused research read: none of these commands invokes the user CLI.
  const researchRead = "cat src/cli-args.ts; sed -n '1,170p' src/cli-main.ts; "
    + "rg -n '^export |case |argv\\[|arg ===|arg ==|includes\\(|Usage:' "
    + 'src/cli-{collaborate,cloud-memory,mcp,import,trajectory,permissions,doctor,sessions,list-agents}.ts; '
    + "rg --files docs | rg 'getting-started|reference'; "
    + "rg -n 'darwin --help|darwin doctor|darwin sessions|CLI|命令行' "
    + 'README.md README.zh-CN.md docs/user-guide/getting-started* docs/user-guide/reference*; '
    + "rg --files spike | rg 'docs|doc-'";
  const reads = [
    researchRead,
    "sed -n '1,20p' src/cli-collaborate.ts",
    "sed -n '1,20p' src/cli.ts; rg -n 'collaborate' src/cli.ts",
    "rg -n 'collaborate' src/cli.ts; sed -n '1,20p' src/cli.ts",
    "echo collaborate; sed -n '1,20p' src/cli.ts",
    "sed -n '1,20p' src/cli.ts; echo collaborate",
    "sed -n '1,20p' 'docs/collaborate.md'",
  ];
  for (const peer of [false, true]) {
    const { gate, asked } = makeGate('yolo', false, { peerOrigin: () => peer });
    for (const command of reads) {
      const event = fakeEvent('bash', { mode: 'execute', command });
      assert(`${peer ? 'peer' : 'human'}: source read reaches ordinary gate: ${command.slice(0, 65)}`,
        gate.guardBeforeHooks(event) === undefined && (await gate.beforeToolCall(event)).type === 'proceed');
    }
    assert('yolo source reads need no prompt', asked.length === 0);
  }
  const ordinary = makeGate('default', false, { peerOrigin: () => false });
  assert('the original read is still statically dangerous, not a new safe-list exemption', bashRisk(researchRead) === 'dangerous');
  assert('default mode still asks for that read',
    (await ordinary.gate.beforeToolCall(fakeEvent('bash', { command: researchRead }))).type === 'proceed' && ordinary.asked.length === 1);
  const denied = makeGate('yolo', false, { denyRules: ['bash:sed *'] });
  const decision = await denied.gate.beforeToolCall(fakeEvent('bash', { command: researchRead }));
  assert('configured deny-rules still apply to the research read', decision.type === 'deny' && decision.reason.includes('blocked by deny rule'));
  const plan = await makeGate('plan').gate.beforeToolCall(fakeEvent('bash', { command: researchRead }));
  assert('plan still blocks the research shell read as execute', plan.type === 'deny' && plan.reason.includes('Plan mode blocked'));

  const controls = [
    'darwin collaborate confirm pending --persist',
    '/usr/local/bin/darwin collaborate on',
    'node dist/src/cli.js collaborate off',
    'pnpm tsx src/cli.ts -- collaborate hub block node',
    'env FOO=1 command darwin collaborate off',
    "darwin 'collaborate' on",
    'darwin "collab"orate on',
    'darwin colla\\borate on',
    'darwin colla\\\nborate on',
    'echo ok; darwin collaborate on',
    'echo ok && darwin collaborate on',
    'echo ok | darwin collaborate on',
    '(darwin collaborate on)',
    'echo $(darwin collaborate on)',
    'echo `darwin collaborate on`',
    'bash -c "darwin collaborate on"',
    'darwin${IFS}collaborate${IFS}on',
    'darwin collaborate on; echo harmless',
    'echo harmless; darwin collaborate on',
  ];
  for (const peer of [false, true]) {
    for (const mode of ['default', 'auto', 'plan', 'yolo'] as const) {
      const { gate, asked } = makeGate(mode, false, { peerOrigin: () => peer, allowRules: ['bash'] });
      for (const command of controls) {
        const event = fakeEvent('bash', { command });
        assert(`${peer ? 'peer' : 'human'} ${mode}: control denied before hooks and approval: ${command}`,
          isPeerDenial(gate.guardBeforeHooks(event)!) && isPeerDenial(await gate.beforeToolCall(event)));
      }
      const secretPath = path.join(HOME, '.darwin/collaboration/policy.json');
      const secrets = [
        fakeEvent('bash', { command: `cat ${secretPath}` }),
        fakeEvent('bash', { command: `rg -uu secret ${HOME}/.darwin` }),
        ...['view', 'create', 'str_replace', 'insert'].map(command => fakeEvent('fileEditor', { command, path: secretPath })),
      ];
      for (const event of secrets) {
        assert(`${peer ? 'peer' : 'human'} ${mode}: policy/secret ${event.toolUse.name} stays protected`,
          isPeerDenial(gate.guardBeforeHooks(event)) && isPeerDenial(await gate.beforeToolCall(event)));
      }
      assert('no control or secret reaches the prompt despite a broad allow-rule', asked.length === 0);
    }
  }
}

async function peerProtections(): Promise<void> {
  header('peer shell relaxation — every other peer protection stays');
  const g = makeGate('yolo', false, { allowRules: ['bash', 'fileEditor', 'memory_save'] }).gate;
  assert('peer memory_save is still denied', isPeerDenial(await g.beforeToolCall(fakeEvent('memory_save', { key: 'a:b', category: 'decision', title: 't', fact: 'f' }))));
  for (const file of ['AGENTS.md', '.darwin/mcp.json', '.agents/hooks.json', '.mcp.json']) {
    assert(`peer ${file} write is still denied even with broad allow-rules`, isPeerDenial(await g.beforeToolCall(fakeEvent('fileEditor', { command: 'create', path: file, file_text: 'x' }))));
  }
  const secret = fakeEvent('bash', { command: `cat ${HOME}/.darwin/collaboration/hub-node.json` });
  assert('collaboration secrets via bash are still denied before hooks', isPeerDenial(g.guardBeforeHooks(secret)!));
  assert('collaboration secrets via bash are still denied', isPeerDenial(await g.beforeToolCall(secret)));
  const controls = await g.beforeToolCall(fakeEvent('bash', { command: 'darwin collaborate hub block x' }));
  assert('`darwin collaborate` controls via bash are still denied', isPeerDenial(controls));
  assert('the remaining denial no longer claims peer shell needs a human turn', controls.type === 'deny' && !controls.reason.includes('fresh human turn'));
  const ceiling = await makeGate('yolo', true).gate.beforeToolCall(fakeEvent('bash', { command: 'touch x' }));
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
  await ordinaryShell();
  await collaborationOperands();
  await peerProtections();
  await sendLatch();
  await configField();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
