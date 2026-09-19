/** SER-096: real recorded files, offline CLI and busy pty; no provider/network. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, BeforeToolCallEvent, ContentBlockEvent, ToolUseBlock } from '@strands-agents/sdk';
import { createSessionManager } from '../src/agent/session.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { CaptureModel } from './offline-model.js';
import { PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { matchesAnyDenyRule, matchesAnyRule } from '../src/agent/permission-rules.js';
import { candidateProblem, permissionTestReport, testCell } from '../src/permissions-test.js';
import { userDarwinDir, userProjectDir, userProjectSessionsDir } from '../src/paths.js';
import { encodeRecord, projectEvent, type TrajectoryRecord } from '../src/trajectory/record.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { applyPermissionsCommand } from '../src/tui/App.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

ownPrivateHome('permissions-test');
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-rule-test-'));
const rulesFile = path.join(userProjectDir(root), 'permission-rules.json');
const denies = ['bash:git push *', 'fileEditor:.env*'];

async function put(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}
function envelope(seq: number, fields: Record<string, unknown>): TrajectoryRecord {
  return { v: 1, seq, t: '2026-09-19T00:00:00Z', turn: 1, ...fields } as TrajectoryRecord;
}
function call(seq: number, name: string, input: unknown, before = false): TrajectoryRecord {
  const toolUse = new ToolUseBlock({ name, input: input as never, toolUseId: `c${seq}` });
  const event = before ? new BeforeToolCallEvent({ toolUse } as never)
    : new ContentBlockEvent({ contentBlock: toolUse } as never);
  return envelope(seq, { type: event.type, ...projectEvent(event) });
}
async function seed(project: string, id: string, records: TrajectoryRecord[], suffix = ''): Promise<string> {
  const file = path.join(userProjectSessionsDir(project), id, 'trajectory.jsonl');
  await put(file, records.map(encodeRecord).join('') + suffix);
  return file;
}
async function digest(directory: string): Promise<string> {
  const values: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    values.push(entry.name);
    if (entry.isDirectory()) values.push(await digest(file));
    else if (entry.isFile()) values.push(createHash('sha256').update(await readFile(file)).digest('hex'));
  }
  return createHash('sha256').update(values.join('\n')).digest('hex');
}
await put(rulesFile, JSON.stringify({ allow: ['bash:old *'], deny: denies }));
const targets = [
  { toolName: 'bash', input: { command: 'git status && git push origin main' } },
  { toolName: 'bash', input: { command: 'git status && pnpm test' } },
  { toolName: 'bash', input: { command: 'echo $(git push --force)' } },
  { toolName: 'bash', input: { command: 'git status > out' } },
  { toolName: 'bash', input: { command: 'cat .env.local' } },
  { toolName: 'bash', input: { command: 'printf  two   spaces' } },
  { toolName: 'fileEditor', input: { command: 'view', path: 'src/a.ts' } },
  { toolName: 'fileEditor', input: { command: 'view', path: '.env.local' } },
  { toolName: 'mcp_unknown', input: { message: 'ESC\u001b]52;c;payload\u0007\u202e' } },
];
const records = targets.map((target, index) => call(index + 1, target.toolName, target.input, index % 2 === 0));
const file = await seed(root, 'current', records);
await seed(root, 'other-session', [call(1, 'bash', { command: 'OTHER_SESSION' })]);
const projectReport = await permissionTestReport('bash', { projectRoot: root });
assert('CLI project projection includes another current-project session', projectReport.includes('OTHER_SESSION') && projectReport.includes('deny beats candidate allow'));
const outside = await mkdtemp(path.join(os.tmpdir(), 'darwin-rule-outside-'));
const outsideFile = await seed(outside, 'outside', [call(1, 'bash', { command: 'OTHER_PROJECT' })]);
await put(path.join(userProjectSessionsDir(root), 'last-session.json'), '{"id":"current"}');
const options = { projectRoot: root, sessionId: 'current', denyRules: denies };


header('SER-096 — canonical parse/match/deny and immutable evidence');
const beforeHash = await digest(userDarwinDir());
for (const rule of ['bash:git *', 'bash', 'bash:printf  two   *', 'fileEditor:src/**', 'fileEditor', 'mcp_unknown', 'mcp_unknown:pattern']) {
  const text = await permissionTestReport(rule, options);
  const expected = targets.filter(target => matchesAnyRule([rule], target, root) !== undefined);
  const beaten = expected.filter(target => matchesAnyDenyRule(denies, target, root) !== undefined);
  assert(`${rule}: canonical match count`, text.includes(`candidate matches ${expected.length}; deny beats ${beaten.length};`));
  assert(`${rule}: exact pair rows and session scope`, text.includes('current interactive session "current" only') && !text.includes('OTHER_SESSION') && !text.includes('OTHER_PROJECT'));
}
const bashReport = await permissionTestReport('bash:git *', options);
assert('deny precedence named on matched chain', bashReport.includes('deny beats candidate allow "bash:git push *"'));
assert('nonmatching metacharacter call still reports matching deny', bashReport.includes('deny matches (candidate does not)'));
assert('internal whitespace preserved by parser and matcher', (await permissionTestReport(' bash : printf  two   * ', options)).includes('pattern "printf  two   *"'));
assert('invalid canonical parse', candidateProblem(':pattern') !== undefined && candidateProblem('bash: ') !== undefined);
assert('candidate cap and no terminal controls', candidateProblem('x'.repeat(2001)) !== undefined && !/[\u0000-\u001f\u007f-\u009f\u202e]/u.test(testCell('\u001b]52;c;bad\u0007\u202e')));
assert('SDK wire before and content blocks both read', bashReport.includes('9 exact;'));
assert('observer byte-identical state', await digest(userDarwinDir()) === beforeHash);

header('SER-096 — missing, lossy, bounded and untrusted evidence');
const loss = [
  call(1, 'bash', { command: 'x'.repeat(9000) }),
  call(2, 'bash', { command: '[REDACTED]' }),
  call(3, 'bash', { reasoning: 'private', command: 'echo secret' }),
  envelope(4, { type: 'beforeToolCallEvent', data: {} }),
  envelope(5, { type: 'beforeToolCallEvent', dropped: 'record-too-large' }),
  envelope(6, { type: 'recordingStopped' }),
  envelope(7, { type: 'permissionDecision', toolUseId: 'child-no-input' }),
];
await seed(root, 'loss', loss, 'damaged\n{"partial":');
const lossText = await permissionTestReport('bash', { ...options, sessionId: 'loss', recording: 'stopped' });
for (const phrase of ['0 exact', 'redacted/placeholder', 'truncated', 'recording stopped', 'partial trailing line', 'unreadable line', 'without recorded input', 'match and no-match are unknown']) {
  assert(`loss explicit: ${phrase}`, lossText.includes(phrase));
}
assert('reasoning never recovered', !lossText.includes('private') && !lossText.includes('echo secret'));
const missing = await permissionTestReport('bash', { ...options, sessionId: 'missing', recording: 'disabled' });
assert('missing and disabled explicit, no exhaustive no-match', missing.includes('recording: disabled') && missing.includes('trajectory missing') && missing.includes('not proof of no matching calls'));
await mkdir(path.join(userProjectSessionsDir(root), 'linked'), { recursive: true });
await symlink(outsideFile, path.join(userProjectSessionsDir(root), 'linked', 'trajectory.jsonl'));
assert('cross-project symlink refused', (await permissionTestReport('bash', { ...options, sessionId: 'linked' })).includes('symlinked: exact pairs unavailable'));
await seed(root, 'large', [], ' '.repeat(2 * 1024 * 1024 + 1));
assert('oversize evidence stated', (await permissionTestReport('bash', { ...options, sessionId: 'large' })).includes('budget exceeded'));
assert('bounded reader refuses bytes past budget', await readTrajectory(file, 10).then(() => false, () => true));
assert('bounded reader preserves exact bytes at limit', (await readTrajectory(file, (await readFile(file)).length)).records.length === 9);
await seed(root, 'metadata', [envelope(1, { ...call(1, 'bash', { command: 'echo safe-looking' }), redacted: true })]);
assert('redaction metadata is not matchable input', (await permissionTestReport('bash', { ...options, sessionId: 'metadata' })).includes('0 exact;'));
await seed(root, 'duplicates', [call(1, 'bash', { command: 'echo same' }), call(2, 'bash', { command: 'echo same' }, true)]);
assert('same pair in assembled block and before-event deduplicates', (await permissionTestReport('bash', { ...options, sessionId: 'duplicates' })).includes('1 exact;'));
for (let i = 0; i < 5; i += 1) await seed(root, `budget-${i}`, [], ' '.repeat(2 * 1024 * 1024));
assert('aggregate read cap explicit', (await permissionTestReport('bash', { projectRoot: root })).includes('total 8 MiB read budget exceeded'));
await seed(root, 'many', Array.from({ length: 35 }, (_, i) => call(i + 1, 'bash', { command: `echo ${i} ${'a'.repeat(500)}` })));
const many = await permissionTestReport('bash', { ...options, sessionId: 'many' });
assert('row/cell caps stated and total output bounded', many.includes('15 evaluated pairs not displayed') && many.includes('[display clipped]') && many.length < 20_000 && many.split('\n').length < 40);
for (let i = 0; i < 21; i += 1) await seed(root, `z-${i}`, []);
assert('project session cap explicit', (await permissionTestReport('bash', { projectRoot: root })).includes('session cap'));
assert('missing policy is unknown, not no deny', (await permissionTestReport('bash', { projectRoot: outside })).includes('deny policy unavailable'));
await put(rulesFile, JSON.stringify({ deny: null }));
assert('null deny policy is invalid, not empty', (await permissionTestReport('bash', { projectRoot: root, sessionId: 'current' })).includes('invalid deny rules'));
const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rule-empty-'));
const empty = await permissionTestReport('bash', { projectRoot: emptyRoot });
assert('missing project store is explicit', empty.includes('project trajectory store missing or unreadable'));
await put(rulesFile, '{broken');
assert('damaged policy is unknown', (await permissionTestReport('bash', { projectRoot: root, sessionId: 'current' })).includes('deny policy unavailable'));
await put(rulesFile, JSON.stringify({ deny: denies }));

header('SER-096 — real CLI, no SDK graph, no runtime/config/trajectory mutation');
// Invalid global config and executable project hooks would break a normal launch.
await put(path.join(userDarwinDir(), 'config.json'), '{invalid-global-config');
await put(path.join(root, '.darwin', 'hooks.json'), JSON.stringify({ PreToolUse: [{ command: 'touch HOOK_RAN' }] }));
const cliHash = await digest(userDarwinDir());
const cli = (args: string[]) => spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [path.join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
const good = cli(['permissions', 'test', 'bash:printf  two   *']);
assert('real CLI dispatch and whitespace', good.status === 0 && good.stdout.includes('parse valid') && good.stdout.includes('pattern "printf  two   *"') && good.stderr === '');
assert('CLI scope and file policy stated', good.stdout.includes('scope: current project') && good.stdout.includes('current project permission-rules.json'));
for (const args of [[], ['test'], ['add', 'bash'], ['test', ':bad'], ['test', 'bash:', 'extra'], ['test', ''], ['test', 'x'.repeat(2001)]]) {
  const result = cli(['permissions', ...args]);
  assert(`CLI usage locally rejected ${JSON.stringify(args).slice(0, 55)}`, result.status === 2 && result.stderr.includes('usage') && !result.stderr.includes('stack'));
}
assert('CLI writes no HOME state', cliHash === await digest(userDarwinDir()));
assert('CLI runs no project hook', !(await readdir(root)).includes('HOOK_RAN'));
const visited = new Set<string>();
async function checkImports(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
    const target = match[1]!;
    assert(`observer import ${path.basename(file)}: ${target}`, !target.includes('@strands-agents') && !/config\.js|runtime\.js|permission\.js|hooks\//.test(target));
    if (target.startsWith('.')) await checkImports(path.resolve(path.dirname(file), target.replace(/\.js$/, '.ts')));
  }
}
await checkImports(path.join(REPO_ROOT, 'src/cli-permissions.ts'));


header('SER-096 — live gate unchanged by TUI handler');
const gate = new PermissionGate({ mode: 'default', projectRoot: root, allowRules: ['bash:old *'], denyRules: denies, ask: async () => ({ allowed: false }) });
const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;
Object.assign(runtime, { gate, info: { projectRoot: root, sessionId: 'current' } });
const liveBefore = JSON.stringify(gate.listAllowRules());
const handlerText = await new Promise<string>(resolve => {
  applyPermissionsCommand(runtime, '/permissions test bash:printf  two   *', action => { if (action.type === 'notice') resolve(action.text); });
});
assert('handler preserves whitespace and reports live policy', handlerText.includes('pattern "printf  two   *"') && handlerText.includes('current session snapshot'));
assert('handler does not widen/revoke gate', JSON.stringify(gate.listAllowRules()) === liveBefore && JSON.stringify(gate.denyRules) === JSON.stringify(denies));

header('SER-096 — real busy pty, local route never queues');
const ptyRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-rule-pty-'));
await put(path.join(userDarwinDir(), 'config.json'), JSON.stringify({ trajectory: true, memory: false }));
const manager = createSessionManager(ptyRoot, 'current');
const agent = new Agent({ id: 'darwin', model: new CaptureModel('seed'), systemPrompt: DEFAULT_SYSTEM_PROMPT, sessionManager: manager, printer: false });
await agent.initialize();
await manager.saveSnapshot({ target: agent, isLatest: true });
await seed(ptyRoot, 'current', [call(1, 'bash', { command: 'printf  two   spaces' })]);
await seed(ptyRoot, 'other-session', [call(1, 'bash', { command: 'DO_NOT_DISPLAY_OTHER_SESSION' })]);
const tui = startTui({ cwd: ptyRoot, entry: path.join(REPO_ROOT, 'spike/fixtures/permissions-test-cli.ts'), args: ['--session', 'current'], cols: 160 });
try {
  await tui.waitFor('you>', { timeoutMs: 60_000 });
  let mark = tui.mark();
  tui.submit('/permissions test');
  await tui.waitFor('test needs a rule', { from: mark });
  mark = tui.mark();
  tui.submit('/permissions test bash:');
  await tui.waitFor('parse invalid', { from: mark });
  mark = tui.mark();
  tui.submit('hold this offline turn');
  await tui.waitUntil(() => { try { return existsSync(path.join(ptyRoot, 'calls')); } catch { return false; } }, { timeoutMs: 30_000 });
  await tui.waitFor('working', { from: mark, timeoutMs: 30_000, settleMs: 100 });
  const duringHash = await digest(userProjectSessionsDir(ptyRoot));
  mark = tui.mark();
  tui.submit('/permissions test bash:printf  two   *');
  await tui.waitFor('candidate matches 1', { from: mark, timeoutMs: 30_000, settleMs: 200 });
  const output = tui.screen.slice(mark);
  assert('busy test responds locally with scope and omission', output.includes('current interactive session') && output.includes('buffered/live calls'));
  assert('busy test does not disclose other session or queue', !output.includes('DO_NOT_DISPLAY_OTHER_SESSION') && !output.includes('queued message'));
  assert('busy test leaves trajectory/store bytes unchanged', await digest(userProjectSessionsDir(ptyRoot)) === duringHash);
  await put(path.join(ptyRoot, 'release'), 'release');
  await tui.waitFor('offline turn finished', { from: mark, timeoutMs: 30_000 });
  await tui.waitUntil(() => tui.frame.includes('◆ DARWIN · ready') && !tui.frame.includes('working…'), { timeoutMs: 30_000, settleMs: 200 });
  tui.submit('/exit');
  assert('pty exits cleanly', await tui.exitedWithin(30_000) === 0);
  assert('exactly one offline model invocation; no queued test', await readFile(path.join(ptyRoot, 'calls'), 'utf8') === '1');
  const recorded = await readTrajectory(path.join(userProjectSessionsDir(ptyRoot), 'current', 'trajectory.jsonl'));
  assert('only real prompt recorded, test never sent to model', recorded.records.filter(r => r.type === 'userInput').length === 1 && !JSON.stringify(recorded.records).includes('/permissions test'));
} finally { tui.kill(); }


report();
