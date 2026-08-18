/**
 * SER-017 — `/permissions`: list and revoke allow-rules in-session.
 *
 * Free suite: no model call and no network. It proves the acceptance chain end
 * to end below the pty — the gate's live rule list is the enforcement surface
 * (a revoked rule makes the very next matching `beforeToolCall` prompt again),
 * origins distinguish configured rules from session grants, revocation persists
 * so a fresh process cannot resurrect a revoked rule, and the command handler
 * degrades unknown input to a usage notice. Throughout, the one hard rule is
 * asserted directly: no path through the command can widen anything.
 *
 * Run: pnpm tsx spike/verify-permissions-command.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import { PermissionGate, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { loadProjectPolicy, permissionRulesPath, removeAllowRules } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { applyPermissionsCommand, formatPermissionRulesReport } from '../src/tui/App.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import type { TurnAction } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Rules and the resume-free project state resolve under HOME, so it is owned
// before anything can write to the real ~/.darwin.
ownPrivateHome('permissions-command');

const ROOT = '/tmp/darwin-permissions-command';
const DANGEROUS = { command: 'rm -rf /tmp/darwin-permissions-command/scratch' };
const RULE = 'bash:rm *';

/** Minimal stand-in for the SDK event, as in `verify-permission-mode-switch.ts`. */
function fakeEvent(name: string, input: unknown): BeforeToolCallEvent {
  return { toolUse: { name, input }, agent: { id: 'darwin' } } as unknown as BeforeToolCallEvent;
}

function makeGate(allowRules: readonly string[]): { gate: PermissionGate; asked: AssessedPermissionRequest[] } {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    allowRules,
    ask: async (request) => {
      asked.push(request);
      return { allowed: true };
    },
  });
  return { gate, asked };
}

/**
 * A real `AgentRuntime` as far as `/permissions` is concerned: the prototype's
 * own `listAllowRules` / `revokeAllowRules` / `info` are exercised (not a stub
 * that could drift from them), with only the fields those methods read
 * injected — building the full runtime would need an `Agent` and a `Model`,
 * which a free suite must not construct.
 */
function makeRuntime(gate: PermissionGate): AgentRuntime {
  const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;
  Object.assign(runtime, {
    gate,
    projectRoot: ROOT,
    info: { permissionRulesPath: permissionRulesPath(ROOT) },
  });
  return runtime;
}

type Notice = { text: string; severity?: string };

function collector(): { notices: Notice[]; dispatch: (action: TurnAction) => void } {
  const notices: Notice[] = [];
  return {
    notices,
    dispatch: (action) => {
      if (action.type === 'notice') notices.push({ text: action.text, ...(action.severity !== undefined ? { severity: action.severity } : {}) });
    },
  };
}

/** Waits for the reported-not-awaited persistence notice to land. */
async function noticeCount(notices: Notice[], count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (notices.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gateOrigins(): void {
  header('gate — per-rule origin, and removal that can only narrow');

  const { gate } = makeGate([RULE]);
  assert(
    'a config-loaded rule reads as configured',
    gate.listAllowRules().length === 1 &&
      gate.listAllowRules()[0]?.rule === RULE &&
      gate.listAllowRules()[0]?.origin === 'configured',
  );

  gate.addAllowRule('fileEditor:src/**');
  assert(
    'a rule granted now reads as granted this session',
    gate.listAllowRules().find((entry) => entry.rule === 'fileEditor:src/**')?.origin === 'session',
  );

  gate.addAllowRule(RULE);
  assert(
    're-granting a live configured rule neither duplicates nor relabels it',
    gate.allowRules.filter((rule) => rule === RULE).length === 1 &&
      gate.listAllowRules().find((entry) => entry.rule === RULE)?.origin === 'configured',
  );

  assert('removing a rule that is not live reports false', !gate.removeAllowRule('bash:nope *'));
  assert('…and removes nothing', gate.allowRules.length === 2);

  assert('removing a live rule reports true', gate.removeAllowRule(RULE));
  assert('…and it is gone from the live list', !gate.allowRules.includes(RULE));

  gate.addAllowRule(RULE);
  assert(
    'a configured rule revoked and re-granted honestly reads as session',
    gate.listAllowRules().find((entry) => entry.rule === RULE)?.origin === 'session',
  );

  const listing = gate.listAllowRules();
  listing.length = 0;
  assert('the listing is a projection — mutating it cannot touch enforcement', gate.allowRules.length === 2);
}

async function enforcement(): Promise<void> {
  header('gate — after revocation the very next matching call prompts again');

  const { gate, asked } = makeGate([RULE]);
  const silent = await gate.beforeToolCall(fakeEvent('bash', DANGEROUS));
  assert('a dangerous call covered by a live rule proceeds silently', silent.type === 'proceed' && asked.length === 0);

  gate.removeAllowRule(RULE);
  const prompted = await gate.beforeToolCall(fakeEvent('bash', DANGEROUS));
  assert('the identical call prompts once the rule is revoked', asked.length === 1);
  assert('…and the bridge decides it, not the dead rule', prompted.type === 'proceed');
}

async function persistence(): Promise<void> {
  header('config — revocation persists, and the write is filter-only');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const rulesFile = permissionRulesPath(ROOT);

  // Two rules on disk: one this session will revoke, one it never held. The
  // second is the widening canary — no revocation may touch it.
  await mkdir(path.dirname(rulesFile), { recursive: true });
  await writeFile(rulesFile, `${JSON.stringify({ allow: [RULE, 'fileEditor:docs/**'] }, null, 2)}\n`, 'utf8');

  await removeAllowRules(ROOT, [RULE]);
  const afterRevoke = await loadProjectPolicy(ROOT);
  assert('a fresh process no longer loads the revoked rule', !afterRevoke.allowRules.includes(RULE));
  assert('…while an untouched rule survives', afterRevoke.allowRules.includes('fileEditor:docs/**'));

  await removeAllowRules(ROOT, ['bash:never-existed *']);
  const afterMiss = await loadProjectPolicy(ROOT);
  assert(
    'removing a rule the file never had changes nothing and adds nothing',
    afterMiss.allowRules.length === 1 && afterMiss.allowRules[0] === 'fileEditor:docs/**',
  );
}

async function commandHandler(): Promise<void> {
  header('/permissions — report, revoke, and degradation to usage notices');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const rulesFile = permissionRulesPath(ROOT);
  await mkdir(path.dirname(rulesFile), { recursive: true });
  await writeFile(rulesFile, `${JSON.stringify({ allow: [RULE] }, null, 2)}\n`, 'utf8');

  const { gate } = makeGate([RULE]);
  gate.addAllowRule('fileEditor:src/**');
  const runtime = makeRuntime(gate);

  // The report: both rules, both origins, numbered.
  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions', dispatch);
    const text = notices[0]?.text ?? '';
    assert('the report lists the configured rule with its origin', text.includes(`1. ${RULE} — configured`));
    assert(
      'the report lists the session grant with its origin',
      text.includes('2. fileEditor:src/** — granted this session'),
    );
    assert('the report names the rules file', text.includes(rulesFile));
  }

  // Degradation: unknown subcommand, missing target, unmatched target.
  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions bogus', dispatch);
    applyPermissionsCommand(runtime, '/permissions add bash', dispatch);
    applyPermissionsCommand(runtime, '/permissions revoke', dispatch);
    applyPermissionsCommand(runtime, '/permissions revoke 99', dispatch);
    applyPermissionsCommand(runtime, '/permissions revoke bash:not-live *', dispatch);
    assert('an unknown subcommand degrades to a usage notice', (notices[0]?.text ?? '').includes('usage: /permissions'));
    assert('there is no add form — it degrades like any unknown subcommand', (notices[1]?.text ?? '').includes('usage: /permissions'));
    assert('a bare revoke asks for a target', (notices[2]?.text ?? '').includes('revoke needs a target'));
    assert('an out-of-range index revokes nothing and says so', (notices[3]?.text ?? '').includes('matches no live allow-rule'));
    assert('an unmatched rule string revokes nothing and says so', (notices[4]?.text ?? '').includes('matches no live allow-rule'));
    assert('none of it touched the gate', gate.allowRules.length === 2);
    assert('none of it touched the file', (await loadProjectPolicy(ROOT)).allowRules.length === 1);
  }

  // Revoke by exact rule string: gate first, file after, both reported.
  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke fileEditor:src/**', dispatch);
    assert('the gate stops honouring the rule before the handler returns', !gate.allowRules.includes('fileEditor:src/**'));
    await noticeCount(notices, 1);
    const text = notices[0]?.text ?? '';
    assert('the notice states the revocation and the re-prompt', text.includes('revoked fileEditor:src/**') && text.includes('ask again'));
    assert('…and where it was persisted', text.includes(`removed from ${rulesFile}`));
  }

  // Revoke by index: the configured rule, removed from the file too.
  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke 1', dispatch);
    assert('revoking by report index removes that rule from the gate', gate.allowRules.length === 0);
    await noticeCount(notices, 1);
    assert('the revocation of a configured rule is persisted', !(await loadProjectPolicy(ROOT)).allowRules.includes(RULE));
  }

  // Revoke all, from a repopulated gate, with one rule persisted and one not.
  {
    gate.addAllowRule(RULE);
    gate.addAllowRule('fileEditor:src/**');
    await writeFile(rulesFile, `${JSON.stringify({ allow: [RULE] }, null, 2)}\n`, 'utf8');
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke all', dispatch);
    assert('revoke all empties the gate', gate.allowRules.length === 0);
    await noticeCount(notices, 1);
    assert('…and reports the count', (notices[0]?.text ?? '').includes('revoked 2 allow-rules'));
    assert('…and empties the file', (await loadProjectPolicy(ROOT)).allowRules.length === 0);

    const { notices: again, dispatch: dispatchAgain } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke all', dispatchAgain);
    assert('revoke all with nothing live revokes nothing', (again[0]?.text ?? '').includes('nothing to revoke'));
  }

  // A failed write costs the file, not the session: the gate is already
  // narrower, and the warn notice says the rule returns next process.
  {
    gate.addAllowRule(RULE);
    await rm(rulesFile, { recursive: true, force: true });
    await mkdir(rulesFile, { recursive: true }); // a directory where the file goes makes the write fail
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, `/permissions revoke ${RULE}`, dispatch);
    assert('the gate revokes even when the file cannot be written', !gate.allowRules.includes(RULE));
    await noticeCount(notices, 1);
    const failed = notices[0];
    assert('the failed write is reported as a degradation', failed?.severity === 'warn');
    assert('…naming the file', (failed?.text ?? '').includes(rulesFile));
    assert('…and saying the rule outlives only this session', (failed?.text ?? '').includes('session only'));
    await rm(rulesFile, { recursive: true, force: true });
  }

  // The empty report is an answer, not an error.
  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions', dispatch);
    assert('an empty rule list reads as "everything asks"', (notices[0]?.text ?? '').includes('no allow-rules in effect'));
  }

  assert(
    'formatPermissionRulesReport distinguishes both origins in one report',
    formatPermissionRulesReport(
      [
        { rule: RULE, origin: 'configured' },
        { rule: 'fileEditor:src/**', origin: 'session' },
      ],
      rulesFile,
    ).includes('configured') &&
      formatPermissionRulesReport([{ rule: RULE, origin: 'session' }], rulesFile).includes('granted this session'),
  );
}

function menuContract(): void {
  header('completion — /permissions is a visible built-in');

  assert('permissions is a built-in command name', (BUILTIN_COMMAND_NAMES as readonly string[]).includes('permissions'));
  assert(
    'the completion menu can show every built-in at once',
    MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length,
  );
}

async function main(): Promise<void> {
  gateOrigins();
  await enforcement();
  await persistence();
  await commandHandler();
  menuContract();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
