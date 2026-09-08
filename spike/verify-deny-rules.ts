/**
 * SER-076 — user-written deny rules: `permissionRules.deny` in the project-scoped
 * `permission-rules.json`, same grammar as `allow`, judged before every widening
 * stage of the gate.
 *
 * Free suite: no model call and no network. It proves the contract end to end
 * below the pty — the loader accepts `deny` beside `allow` and refuses a bad entry
 * by name; the gate denies a matching call in every mode (`yolo` included), for a
 * child sharing the gate, ahead of any allow rule, with a reason that names the
 * rule; the deny matcher is the conservative inverse of allow (any chained
 * segment, metacharacters never exempt, no exemptions); `/permissions` lists deny
 * rules and refuses to revoke them; and the session writers carry `deny` through
 * untouched. Throughout, the one hard rule is asserted directly: with no deny
 * rule configured, nothing changes.
 *
 * Run: pnpm tsx spike/verify-deny-rules.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import {
  APPROVAL_MODES,
  PermissionGate,
  type ApprovalMode,
  type AssessedPermissionRequest,
  type PermissionGateOptions,
} from '../src/agent/permission.js';
import { matchesAnyDenyRule, matchesAnyRule, splitDenySegments } from '../src/agent/permission-rules.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  ConfigError,
  appendAllowRule,
  loadConfig,
  loadProjectPolicy,
  permissionRulesPath,
  removeAllowRules,
} from '../src/config.js';
import { applyPermissionsCommand, formatPermissionRulesReport } from '../src/tui/App.js';
import { ToolHookGate } from '../src/hooks/tool-hooks.js';
import type { TurnAction } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Rules resolve under HOME, so it is owned before anything can write to the real
// ~/.darwin.
ownPrivateHome('deny-rules');

const ROOT = '/tmp/darwin-deny-rules';
const FORCE_PUSH = 'bash:git push --force*';
const CHAINED = { command: 'git status && git push --force' };
const CHILD_AGENT_ID = 'child-agent-1';

type Action = Awaited<ReturnType<PermissionGate['beforeToolCall']>>;

/** Minimal stand-in for the SDK event, as in `verify-permissions-command.ts`. */
function fakeEvent(name: string, input: unknown, agentId = 'darwin'): BeforeToolCallEvent {
  return {
    toolUse: { name, input, toolUseId: 'deny-call-1' },
    agent: { id: agentId, cancelSignal: new AbortController().signal },
  } as unknown as BeforeToolCallEvent;
}

interface Fixture {
  gate: PermissionGate;
  asked: AssessedPermissionRequest[];
  classified: () => number;
}

function makeGate(
  options: Partial<PermissionGateOptions> & { mode?: ApprovalMode } = {},
  answer: (request: AssessedPermissionRequest) => { allowed: boolean; rule?: string } = () => ({ allowed: true }),
): Fixture {
  const asked: AssessedPermissionRequest[] = [];
  let classified = 0;
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return answer(request);
    },
    classifier: async () => {
      classified += 1;
      return { safe: true, reason: 'test classifier clears everything' };
    },
    // The child resolver: one known dispatch id, everything else is the parent.
    dispatchSource: (agentId) =>
      agentId === CHILD_AGENT_ID ? { dispatchId: 'd1', agentName: 'explorer', label: 'explorer#d1' } : undefined,
    ...options,
  });
  return { gate, asked, classified: () => classified };
}

function reason(action: Action): string {
  return action.type === 'deny' ? action.reason : '';
}

function isDenyRuleDenial(action: Action, rule: string): boolean {
  return action.type === 'deny' && reason(action).includes(`blocked by deny rule ${rule}`);
}

/** A real `AgentRuntime` as far as `/permissions` is concerned — see `verify-permissions-command.ts`. */
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

async function noticeCount(notices: Notice[], count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (notices.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectConfigError(what: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    assert(what, false);
    return '';
  } catch (error) {
    assert(what, error instanceof ConfigError);
    return error instanceof Error ? error.message : String(error);
  }
}

async function writeRules(record: unknown): Promise<string> {
  const file = permissionRulesPath(ROOT);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

function matcher(): void {
  header('matcher — the conservative inverse of allow');

  const rules = [FORCE_PUSH];
  const bash = (command: string): string | undefined => matchesAnyDenyRule(rules, { toolName: 'bash', input: { command } }, ROOT);

  assert('the exact command matches', bash('git push --force') === FORCE_PUSH);
  assert('a trailing `*` covers arguments', bash('git push --force-with-lease origin main') === FORCE_PUSH);
  assert('any chained segment matching is enough (allow would need every one)', bash(CHAINED.command) === FORCE_PUSH);
  assert(
    '…which is exactly where the allow matcher says no',
    matchesAnyRule(rules, { toolName: 'bash', input: CHAINED }, ROOT) === undefined,
  );
  assert('redirection never exempts a deny', bash('git push --force > /tmp/push.log 2>&1') === FORCE_PUSH);
  assert('`$(…)` substitution exposes its body as a segment', bash('echo $(git push --force)') === FORCE_PUSH);
  assert('backtick substitution exposes its body as a segment', bash('echo `git push --force`') === FORCE_PUSH);
  assert('a subshell exposes its body as a segment', bash('(cd /tmp/x && git push --force)') === FORCE_PUSH);
  assert('a backgrounded command is a segment of its own', bash('sleep 1 & git push --force') === FORCE_PUSH);
  assert('an unrelated command does not match', bash('git push origin main') === undefined);
  assert('a different tool does not match', matchesAnyDenyRule(rules, { toolName: 'fileEditor', input: { path: 'x' } }, ROOT) === undefined);
  assert(
    'splitDenySegments cuts at every operator the matcher relies on',
    JSON.stringify(splitDenySegments('a && b || c; d | e\nf & g $(h) `i` (j) k > l < m')) ===
      JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm']),
  );

  // Paths: same view as allow — project-relative inside, absolute outside.
  const file = (filePath: string, command = 'str_replace'): string | undefined =>
    matchesAnyDenyRule(['fileEditor:dist/**'], { toolName: 'fileEditor', input: { command, path: filePath } }, ROOT);
  assert('a relative path under the pattern matches', file('dist/src/cli.js') === 'fileEditor:dist/**');
  assert('the absolute form of the same path matches', file(path.join(ROOT, 'dist', 'x.js')) === 'fileEditor:dist/**');
  assert('a path outside the pattern does not match', file('src/cli.ts') === undefined);
  assert('a `view` on the path matches too — the pattern names the path, not the verb', file('dist/x.js', 'view') === 'fileEditor:dist/**');

  // No exemptions: the allow exemptions exist so a rule cannot widen.
  assert(
    'a deny can cover a `.env` write, which no allow rule may',
    matchesAnyDenyRule(['fileEditor:**'], { toolName: 'fileEditor', input: { command: 'create', path: '.env' } }, ROOT) === 'fileEditor:**' &&
      matchesAnyRule(['fileEditor:**'], { toolName: 'fileEditor', input: { command: 'create', path: '.env' } }, ROOT) === undefined,
  );
  assert('a bare tool name denies every call of that tool', matchesAnyDenyRule(['memory_save'], { toolName: 'memory_save', input: {} }, ROOT) === 'memory_save');
  assert('an unparseable entry is skipped, never matched', matchesAnyDenyRule(['bash:'], { toolName: 'bash', input: CHAINED }, ROOT) === undefined);
}

async function everyMode(): Promise<void> {
  header('gate — a deny holds in every mode, before prompt and classifier');

  for (const mode of APPROVAL_MODES) {
    const { gate, asked, classified } = makeGate({ mode, denyRules: [FORCE_PUSH] });
    const action = await gate.beforeToolCall(fakeEvent('bash', CHAINED));
    assert(`${mode}: the chained forced push is denied`, isDenyRuleDenial(action, FORCE_PUSH));
    assert(`${mode}: nobody was asked and no classifier ran`, asked.length === 0 && classified() === 0);
  }

  const { gate } = makeGate({ mode: 'yolo', denyRules: [FORCE_PUSH] });
  const reasonText = reason(await gate.beforeToolCall(fakeEvent('bash', CHAINED)));
  assert('the model-facing reason names the rule', reasonText.includes(`blocked by deny rule ${FORCE_PUSH}`));
  assert('…says not to retry or work around it', reasonText.includes('Do not retry it') && reasonText.includes('another way'));
  assert('…and says to tell the user', reasonText.includes('Tell the user'));
  assert('…in one bounded paragraph', reasonText.length < 400 && !reasonText.includes('\n'));
  assert('mode switches do not revive the call', (gate.setMode('default'), isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('bash', CHAINED)), FORCE_PUSH)));
}

async function metacharacters(): Promise<void> {
  header('gate — redirection and substitution never exempt a deny');

  const { gate, asked } = makeGate({ mode: 'yolo', denyRules: [FORCE_PUSH] });
  for (const command of [
    'git push --force > /tmp/push.log',
    'echo $(git push --force)',
    'git status; (git push --force)',
    'true || git push --force 2>&1 | tee /tmp/log',
  ]) {
    assert(`denied: ${command}`, isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('bash', { command })), FORCE_PUSH));
  }
  assert('none of it prompted', asked.length === 0);
}

async function denyBeatsAllow(): Promise<void> {
  header('gate — a deny wins over any matching allow rule');

  const { gate, asked } = makeGate({ mode: 'default', allowRules: ['bash', FORCE_PUSH], denyRules: [FORCE_PUSH] });
  assert(
    'a whole-tool allow and an identical allow rule do not clear the call',
    isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('bash', CHAINED)), FORCE_PUSH) && asked.length === 0,
  );

  gate.addAllowRule('bash:git *');
  assert(
    'a rule granted this session cannot clear it either — the session never grants past a deny',
    isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('bash', CHAINED)), FORCE_PUSH),
  );

  assert(
    'the allow rule still clears what the deny does not cover',
    (await gate.beforeToolCall(fakeEvent('bash', { command: 'git push origin main' }))).type === 'proceed' && asked.length === 0,
  );

  // A statically safe call is denied too: `safe` is judged after the deny.
  const { gate: safeGate } = makeGate({ mode: 'default', denyRules: ['bash:git status*'] });
  assert(
    'a deny beats the static safe list',
    isDenyRuleDenial(await safeGate.beforeToolCall(fakeEvent('bash', { command: 'git status' })), 'bash:git status*'),
  );
}

async function filesAndTools(): Promise<void> {
  header('gate — file patterns and bare tool names');

  const { gate, asked } = makeGate({ mode: 'yolo', denyRules: ['fileEditor:dist/**', 'http_request'] });
  const write = (filePath: string): BeforeToolCallEvent =>
    fakeEvent('fileEditor', { command: 'str_replace', path: filePath, old_str: 'a', new_str: 'b' });

  assert('a write under dist/ is denied', isDenyRuleDenial(await gate.beforeToolCall(write('dist/src/cli.js')), 'fileEditor:dist/**'));
  assert(
    'the same write by absolute path is denied',
    isDenyRuleDenial(await gate.beforeToolCall(write(path.join(ROOT, 'dist', 'src', 'cli.js'))), 'fileEditor:dist/**'),
  );
  assert('a write under src/ is left alone', (await gate.beforeToolCall(write('src/cli.ts'))).type === 'proceed');
  assert(
    'a bare tool name denies every call of that tool',
    isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('http_request', { method: 'GET', url: 'https://example.com' })), 'http_request'),
  );
  assert('other tools are untouched', (await gate.beforeToolCall(fakeEvent('web_fetch', { url: 'https://example.com' }))).type === 'proceed');
  assert('none of it prompted (yolo)', asked.length === 0);
}

async function children(): Promise<void> {
  header('gate — a child dispatch sharing the gate is denied the same way');

  const { gate, asked } = makeGate({ mode: 'yolo', denyRules: [FORCE_PUSH, 'fileEditor:dist/**'] });
  const childBash = await gate.beforeToolCall(fakeEvent('bash', CHAINED, CHILD_AGENT_ID));
  const parentBash = await gate.beforeToolCall(fakeEvent('bash', CHAINED));
  assert('the child is denied', isDenyRuleDenial(childBash, FORCE_PUSH));
  assert('…with the identical reason the parent gets', reason(childBash) === reason(parentBash));
  assert(
    'a child file write under the pattern is denied too',
    isDenyRuleDenial(
      await gate.beforeToolCall(fakeEvent('fileEditor', { command: 'create', path: 'dist/new.js', file_text: '' }, CHILD_AGENT_ID)),
      'fileEditor:dist/**',
    ),
  );
  assert('no prompt reached the bridge for any of it', asked.length === 0);
}

async function hooksNeverRun(): Promise<void> {
  header('hook wrapper — a deny-rule denial runs no PreToolUse shell, like plan');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const log = path.join(ROOT, 'pre-hook-ran');
  const { gate, asked } = makeGate({ mode: 'yolo', denyRules: [FORCE_PUSH] });
  const wrapped = new ToolHookGate(ROOT, {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `printf pre >> ${log}` }] }],
  }, gate);

  const denied = await wrapped.beforeToolCall(fakeEvent('bash', CHAINED));
  assert('the wrapper returns the deny-rule denial', isDenyRuleDenial(denied, FORCE_PUSH));
  assert('no Pre hook shell ran', (await readFile(log, 'utf8').catch(() => '')) === '');
  assert('nobody was asked', asked.length === 0);

  const allowed = await wrapped.beforeToolCall(fakeEvent('bash', { command: 'git status' }));
  assert('an unrelated call still goes through Pre and the gate', allowed.type === 'proceed' && (await readFile(log, 'utf8')) === 'pre');
}

async function unchangedWithoutDeny(): Promise<void> {
  header('gate — with no deny rule, nothing changes; a prompt never offers one');

  const dangerous = { command: 'rm -rf /tmp/darwin-deny-rules/scratch' };
  const { gate: plain, asked: plainAsked } = makeGate({ mode: 'default' });
  const { gate: unrelated, asked: unrelatedAsked } = makeGate({ mode: 'default', denyRules: [FORCE_PUSH] });
  const [a, b] = await Promise.all([
    plain.beforeToolCall(fakeEvent('bash', dangerous)),
    unrelated.beforeToolCall(fakeEvent('bash', dangerous)),
  ]);
  assert('an unrelated deny leaves the ordinary flow untouched', a.type === b.type && plainAsked.length === 1 && unrelatedAsked.length === 1);
  assert(
    'the prompt offers allow suggestions only — no deny rule appears',
    unrelatedAsked[0]?.suggestions.every((suggestion) => suggestion.rule !== FORCE_PUSH) === true &&
      JSON.stringify(unrelatedAsked[0]?.suggestions) === JSON.stringify(plainAsked[0]?.suggestions),
  );
  assert('a safe call still proceeds silently', (await unrelated.beforeToolCall(fakeEvent('bash', { command: 'git status' }))).type === 'proceed');
  assert('the gate exposes its deny rules read-only', Object.isFrozen(unrelated.denyRules) && unrelated.denyRules.length === 1 && plain.denyRules.length === 0);
}

async function loader(): Promise<void> {
  header('config — `deny` loads beside `allow`, and a bad entry is a ConfigError naming it');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  assert('an absent file has no deny rules', (await loadProjectPolicy(ROOT)).denyRules.length === 0);

  await writeRules({ allow: ['bash:pnpm *'] });
  assert('a file without `deny` has none — behaviour before SER-076', (await loadProjectPolicy(ROOT)).denyRules.length === 0);

  await writeRules({ allow: ['bash:pnpm *'], deny: [FORCE_PUSH, 'fileEditor:dist/**', 'http_request'] });
  const loaded = await loadProjectPolicy(ROOT);
  assert('deny rules load in order', JSON.stringify(loaded.denyRules) === JSON.stringify([FORCE_PUSH, 'fileEditor:dist/**', 'http_request']));
  assert('allow rules are unaffected', JSON.stringify(loaded.allowRules) === JSON.stringify(['bash:pnpm *']));

  await writeRules({ deny: ['bash:pnpm *'] });
  assert('`deny` alone is fine — allow is then empty', (await loadProjectPolicy(ROOT)).allowRules.length === 0 && (await loadProjectPolicy(ROOT)).denyRules.length === 1);

  await writeRules({ deny: 'bash' });
  const notArray = await expectConfigError('a non-array deny is rejected', () => loadProjectPolicy(ROOT));
  assert('…naming the field', notArray.includes('"permissionRules.deny"'));

  await writeRules({ deny: ['bash:'] });
  const emptyPattern = await expectConfigError('a deny with an empty pattern is rejected', () => loadProjectPolicy(ROOT));
  assert('…naming the entry', emptyPattern.includes('"bash:"') && emptyPattern.includes('"deny"'));

  await writeRules({ deny: [42] });
  const nonString = await expectConfigError('a non-string deny entry is rejected', () => loadProjectPolicy(ROOT));
  assert('…naming the entry', nonString.includes('42'));

  // Global config keeps refusing the whole field, `deny` included.
  const globalConfig = path.join(process.env['HOME'] ?? '', '.darwin', 'config.json');
  await mkdir(path.dirname(globalConfig), { recursive: true });
  await writeFile(globalConfig, JSON.stringify({ permissionRules: { deny: [FORCE_PUSH] } }), 'utf8');
  const global = await expectConfigError('global config refuses permissionRules with only deny', () => loadConfig(ROOT));
  assert('…and says rules are project-scoped', global.includes('project-scoped'));
  await rm(globalConfig, { force: true });

  header('config — the session writers carry `deny` through untouched');

  const file = await writeRules({ allow: ['bash:pnpm *'], deny: [FORCE_PUSH] });
  await appendAllowRule(ROOT, 'fileEditor:src/**');
  let written = JSON.parse(await readFile(file, 'utf8')) as { allow?: string[]; deny?: string[] };
  assert('a grant keeps the deny list', JSON.stringify(written.deny) === JSON.stringify([FORCE_PUSH]));
  assert('…and appends the allow rule', JSON.stringify(written.allow) === JSON.stringify(['bash:pnpm *', 'fileEditor:src/**']));

  await removeAllowRules(ROOT, ['bash:pnpm *', FORCE_PUSH]);
  written = JSON.parse(await readFile(file, 'utf8')) as { allow?: string[]; deny?: string[] };
  assert('a revocation keeps the deny list even when named as a target', JSON.stringify(written.deny) === JSON.stringify([FORCE_PUSH]));
  assert('…and removes only the allow rule', JSON.stringify(written.allow) === JSON.stringify(['fileEditor:src/**']));

  await writeRules({ allow: ['bash:pnpm *'] });
  await appendAllowRule(ROOT, 'fileEditor:src/**');
  const before = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert('a file that never had `deny` is rewritten without one', !('deny' in before));
}

async function permissionsCommand(): Promise<void> {
  header('/permissions — lists deny rules, refuses to revoke them');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const rulesFile = await writeRules({ allow: ['bash:rm *'], deny: [FORCE_PUSH] });
  const { gate } = makeGate({ mode: 'default', allowRules: ['bash:rm *'], denyRules: [FORCE_PUSH] });
  const runtime = makeRuntime(gate);

  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions', dispatch);
    const text = notices[0]?.text ?? '';
    assert('the report lists the allow rule numbered', text.includes('1. bash:rm * — configured'));
    assert('the report lists the deny rule, labelled as deny and configured', text.includes(`${FORCE_PUSH} — deny (configured)`));
    assert('deny rules are unnumbered — numbers are revoke targets', !/\d+\. bash:git push/.test(text));
    assert('the deny section says where it comes from and that it holds everywhere', text.includes('deny-rules in effect (1)') && text.includes('every mode') && text.includes(rulesFile));
  }

  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, `/permissions revoke ${FORCE_PUSH}`, dispatch);
    const text = notices[0]?.text ?? '';
    assert('revoking a deny rule by name is refused', text.includes('never revokes deny-rules'));
    assert('…because it would widen', text.includes('widen'));
    assert('…and the notice names the file to edit instead', text.includes(rulesFile));
    assert('the gate still holds the deny', gate.denyRules.includes(FORCE_PUSH));
    assert('…and the allow rule is untouched', gate.allowRules.includes('bash:rm *'));
    assert('the file is untouched', JSON.stringify((await loadProjectPolicy(ROOT)).denyRules) === JSON.stringify([FORCE_PUSH]));
    assert('the deny still enforces', isDenyRuleDenial(await gate.beforeToolCall(fakeEvent('bash', CHAINED)), FORCE_PUSH));
  }

  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke 2', dispatch);
    assert('an index past the allow list reaches no deny rule', (notices[0]?.text ?? '').includes('matches no live allow-rule'));
    assert('…and nothing changed', gate.denyRules.length === 1 && gate.allowRules.length === 1);
  }

  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions revoke all', dispatch);
    await noticeCount(notices, 1);
    const text = notices[0]?.text ?? '';
    assert('revoke all removes the allow rules', gate.allowRules.length === 0 && text.includes('revoked bash:rm *'));
    assert('…says the deny rules stay', text.includes('deny-rules stay in force'));
    assert('…and leaves them in the gate and the file', gate.denyRules.length === 1 && JSON.stringify((await loadProjectPolicy(ROOT)).denyRules) === JSON.stringify([FORCE_PUSH]));
  }

  {
    const { notices, dispatch } = collector();
    applyPermissionsCommand(runtime, '/permissions', dispatch);
    const text = notices[0]?.text ?? '';
    assert('with no allow rules the deny section still lists', text.includes('no allow-rules in effect') && text.includes(`${FORCE_PUSH} — deny (configured)`));
  }

  assert(
    'the formatter with no deny rules is the pre-SER-076 report byte for byte',
    formatPermissionRulesReport([{ rule: 'bash:rm *', origin: 'configured' }], rulesFile, []) ===
      `allow-rules in effect (1) — configured rules load from ${rulesFile}\n` +
        '  1. bash:rm * — configured\n' +
        '  /permissions revoke <n|rule|all> revokes; new rules come only from the permission prompt',
  );
}

async function main(): Promise<void> {
  matcher();
  await everyMode();
  await metacharacters();
  await denyBeatsAllow();
  await filesAndTools();
  await children();
  await hooksNeverRun();
  await unchangedWithoutDeny();
  await loader();
  await permissionsCommand();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
