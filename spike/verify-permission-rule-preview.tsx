/** SER-097: exact rule review. Real Ink, pty, gate and files; local model, no provider calls.
 * Selection and every non-final page must leave both the tool and rules file untouched.
 * Run: pnpm tsx spike/verify-permission-rule-preview.tsx
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'ink';
import { classify, NEVER_WITHDRAWN, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { suggestRules } from '../src/agent/permission-rules.js';
import { appendAllowRule, permissionRulesPath } from '../src/config.js';
import { PermissionRulePreview, exactRuleText, ruleReviewLayout, type RuleReview } from '../src/tui/permission-rule-preview.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui, stripAnsi, type TuiSession } from './tui-driver.js';

ownPrivateHome('permission-rule-preview');
const ROOT = '/tmp/darwin-permission-rule-preview';
const entry = path.join(REPO_ROOT, 'spike/fixtures/permission-rule-preview-cli.ts');

function request(toolName: string, input: unknown): AssessedPermissionRequest {
  return { ...classify(toolName, input), risk: 'dangerous', riskReason: 'fixture',
    source: { kind: 'parent', label: 'parent' }, withdrawn: NEVER_WITHDRAWN,
    suggestions: suggestRules({ toolName, input }, ROOT) };
}

async function renderCases(): Promise<void> {
  header('exact preview — decoded rendered pages equal real persisted strings');
  const targets = [
    request('bash', { command: 'pnpm test --watch' }),
    request('fileEditor', { command: 'create', path: `${ROOT}/src/a.ts` }),
    request('mcp_unknown', { anything: 'opaque' }),
    request('bash', { command: `tool${'x'.repeat(800)} argument` }),
    request('fileEditor', { path: `${ROOT}/quote"slash\\tab\tline\n\x1b[31m\u202e中文e\u0301😀/a` }),
    request('fileEditor', { path: `${ROOT}/${' '.repeat(50)}/a` }),
  ];
  let count = 0;
  for (const target of targets) for (const { rule } of target.suggestions) {
    const review: RuleReview = { request: target, rule, columns: 40, maxRows: 4, offset: 0 };
    let offset = 0;
    let decoded = '';
    do {
      const layout = ruleReviewLayout(rule, 40, 4, offset);
      const output = stripAnsi(renderToString(<PermissionRulePreview review={{ ...review, offset }} />, { columns: 40 }));
      assert(`page ${count}/${offset} fits grant`, output.split('\n').length <= 4);
      assert(`page ${count}/${offset} exact rows visible`, layout.rows.every((row) => output.includes(row)));
      assert(`page ${count}/${offset} keys visible`, output.includes('b=back y=once n/esc=deny'));
      decoded += output.split('\n').slice(1, -1).join('');
      offset = layout.end;
    } while (offset < exactRuleText(rule).length);
    assert(`rule ${count} lossless ASCII JSON`, /^[\x20-\x7e]*$/.test(decoded) && JSON.parse(decoded) === rule);
    const dir = path.join(ROOT, `roundtrip-${count++}`);
    await mkdir(dir, { recursive: true });
    await appendAllowRule(dir, rule);
    const saved = JSON.parse(await readFile(permissionRulesPath(dir), 'utf8')) as { allow: string[] };
    assert(`rule ${count} saved bytes match preview`, saved.allow[0] === JSON.parse(decoded));
  }
  for (const columns of [12, 30, 39, 40, 80]) for (const maxRows of [0, 1, 2, 3, 5]) {
    const target = targets[0]!;
    const rule = target.suggestions[0]!.rule;
    const layout = ruleReviewLayout(rule, columns, maxRows);
    const output = stripAnsi(renderToString(<PermissionRulePreview review={{ request: target, rule, columns, maxRows, offset: 0 }} />, { columns }));
    assert(`budget ${columns}x${maxRows}`, output === '' || output.split('\n').length <= maxRows);
    assert(`no confirmation without content ${columns}x${maxRows}`, layout.ready || (!output.includes('enter=save') && layout.end === 0));
  }
}

async function fixture(name: string, options: { tool?: string; input?: unknown; rows?: number; cols?: number; calls?: number } = {}): Promise<{
  tui: TuiSession; dir: string; file: string; rules: string; rule: string;
}> {
  const dir = path.join(ROOT, name);
  const project = path.join(dir, 'workspace');
  await mkdir(project, { recursive: true });
  const file = path.join(dir, 'target.txt');
  await writeFile(file, 'before');
  const tool = options.tool ?? 'fileEditor';
  const input = options.input ?? { command: 'str_replace', path: file, old_str: 'before', new_str: 'after' };
  const rule = suggestRules({ toolName: tool, input }, project)[0]!.rule;
  const tui = startTui({ cwd: project, entry, cols: options.cols ?? 80, rows: options.rows ?? 24,
    env: { PREVIEW_TOOL: tool, PREVIEW_INPUT: JSON.stringify(input), PREVIEW_CALLS: String(options.calls ?? 1),
      PREVIEW_PID_FILE: path.join(project, 'runtime.pid'), DARWIN_MODEL_PRICES_FETCH: 'off' } });
  try {
    await tui.waitFor('you>', { timeoutMs: 30_000 });
    const from = tui.mark();
    tui.submit('run fixture');
    await tui.waitFor('allow?', { from, timeoutMs: 30_000, settleMs: 100 });
    return { tui, dir: project, file, rules: permissionRulesPath(project), rule };
  } catch (error) { tui.kill(); throw error; }
}
const unwrapped = (text: string): string => text.replace(/\s/g, '');
async function waitText(tui: TuiSession, text: string, from = 0): Promise<void> {
  await tui.waitUntil((screen) => unwrapped(screen.slice(from)).includes(unwrapped(text)), { timeoutMs: 15_000, settleMs: 120, label: text });
}
async function key(tui: TuiSession, value: string, text: string): Promise<void> {
  const from = tui.mark();
  tui.send(value);
  await waitText(tui, text, from);
}
async function finish(tui: TuiSession): Promise<void> {
  await tui.waitUntil(() => tui.frame.includes('you>') && !tui.frame.includes('working') && !tui.frame.includes('allow?'), { timeoutMs: 30_000, settleMs: 150 });
}
async function close(tui: TuiSession): Promise<void> {
  tui.send('\x04');
  assert('fixture exits', (await tui.exitedWithin(5000)) === 0);
}

async function ptyCases(): Promise<void> {
  header('real App — preview, back, once, persisted bytes, notices and revoke');
  for (const choice of ['a', 'A']) {
    const { tui, file, rules, rule } = await fixture(`save-${choice}`);
    try {
      await key(tui, choice, 'enter=save');
      const expected = choice === 'a' ? rule : 'fileEditor';
      assert(`${choice} exact selected rule shown`, tui.frame.includes(JSON.stringify(expected)));
      assert(`${choice} selection neither writes nor executes`, !existsSync(rules) && await readFile(file, 'utf8') === 'before');
      await key(tui, 'b', 'allow?');
      assert('back neither writes nor executes', !existsSync(rules) && await readFile(file, 'utf8') === 'before');
      await key(tui, choice, 'enter=save');
      await key(tui, '\r', `always allowing ${expected} — saved to`);
      await finish(tui);
      assert('original edit executes unchanged', await readFile(file, 'utf8') === 'after');
      assert('saved rule equals preview', (JSON.parse(await readFile(rules, 'utf8')) as { allow: string[] }).allow[0] === expected);
      const from = tui.mark();
      tui.submit('/permissions');
      await waitText(tui, `1. ${expected} — granted this session`, from);
      tui.submit('/permissions revoke 1');
      await waitText(tui, `revoked ${expected}`, from);
      assert('named rule revoked on disk', (JSON.parse(await readFile(rules, 'utf8')) as { allow: string[] }).allow.length === 0);
      await close(tui);
    } finally { tui.kill(); }
  }
  for (const cancel of ['n', '\x1b', '\x03', 'y']) {
    const { tui, file, rules } = await fixture(`cancel-${cancel.charCodeAt(0)}`);
    try {
      await key(tui, 'a', 'enter=save');
      tui.send(cancel);
      await finish(tui);
      assert(`review ${JSON.stringify(cancel)} never persists`, !existsSync(rules));
      assert(`review ${JSON.stringify(cancel)} preserves once/deny semantics`, await readFile(file, 'utf8') === (cancel === 'y' ? 'after' : 'before'));
      await close(tui);
    } finally { tui.kill(); }
  }
  {
    const { tui, file, rules, rule } = await fixture('write-failure');
    try {
      await key(tui, 'a', 'enter=save');
      await mkdir(rules, { recursive: true }); // An actual filesystem failure, not an injected writer.
      await key(tui, '\r', `always allowing ${rule} for this session only`);
      await finish(tui);
      assert('failed persistence names the exact rule and file', unwrapped(tui.screen).includes(unwrapped(`could not write ${rules}`)));
      assert('failed persistence still allows exact edit for session', await readFile(file, 'utf8') === 'after');
      tui.submit('/permissions');
      await waitText(tui, `1. ${rule} — granted this session`);
      tui.submit('/permissions revoke 1');
      await waitText(tui, `revoked ${rule}`);
      await close(tui);
    } finally { tui.kill(); }
  }
  header('real App — page traversal, short/narrow fail-closed and withdrawal');
  {
    const command = `printf '%s' '${'x'.repeat(1700)}' > bash-result.txt`;
    const { tui, dir, rules, rule } = await fixture('bash', { tool: 'bash', input: { mode: 'execute', command } });
    try {
      await key(tui, 'a', 'enter=save');
      assert('bash prefix comes from exact input', tui.frame.includes(exactRuleText(rule)) && rule === 'bash:printf *');
      assert('bash preview precedes execution', !existsSync(path.join(dir, 'bash-result.txt')) && !existsSync(rules));
      await key(tui, '\r', 'always allowing bash:printf *');
      await finish(tui);
      assert('full original command executed', await readFile(path.join(dir, 'bash-result.txt'), 'utf8') === 'x'.repeat(1700));
      assert('bash persisted bytes match', (JSON.parse(await readFile(rules, 'utf8')) as { allow: string[] }).allow[0] === rule);
      await close(tui);
    } finally { tui.kill(); }
  }
  {
    const dir = path.join(ROOT, 'pages');
    const longDirectory = path.join(dir, ...Array.from({ length: 8 }, (_, i) => `d${i}-${'x'.repeat(85)}`));
    await mkdir(longDirectory, { recursive: true });
    const target = path.join(longDirectory, 'new.txt');
    const { tui, rules, rule } = await fixture('pages', { cols: 60, rows: 16,
      input: { command: 'create', path: target, file_text: 'exact paged write' } });
    try {
      await key(tui, 'a', 'enter=next');
      let collected = '';
      let pages = 0;
      while (true) {
        const lines = tui.frame.replace(/\r/g, '').split('\n');
        const start = lines.findIndex((line) => line.startsWith('allow rule (JSON)'));
        const end = lines.findIndex((line, index) => index > start && line.startsWith('enter='));
        assert('page has complete framing and reachable keys', start >= 0 && end > start && lines[end]!.includes('n/esc=deny'));
        collected += lines.slice(start + 1, end).join('');
        assert('every review page precedes persistence/execution', !existsSync(rules) && !existsSync(target));
        pages++;
        if (lines[end]!.startsWith('enter=save')) break;
        await key(tui, '\r', 'allow rule (JSON)');
      }
      assert('multiple pages reconstruct exact selected rule', pages > 1 && JSON.parse(collected) === rule);
      await key(tui, '\r', 'always allowing');
      await finish(tui);
      assert('paged original write executed and persisted exact rule', await readFile(target, 'utf8') === 'exact paged write' &&
        (JSON.parse(await readFile(rules, 'utf8')) as { allow: string[] }).allow[0] === rule);
      assert('fixed-size paging never clears the screen', !tui.raw.includes('\x1b[2J'));
      await close(tui);
    } finally { tui.kill(); }
  }
  for (const size of [{ cols: 30, rows: 24 }, { cols: 80, rows: 9 }]) {
    const { tui, file, rules } = await fixture(`small-${size.cols}`, size);
    try {
      await key(tui, 'a', 'resize');
      tui.send('\r');
      await tui.waitUntil(() => tui.frame.includes('resize'), { settleMs: 150 });
      assert('small frame has no saving key and no side effects', !tui.frame.includes('enter=save') && !existsSync(rules) && await readFile(file, 'utf8') === 'before');
      await key(tui, 'b', 'allow?');
      tui.send('n');
      await finish(tui);
      await close(tui);
    } finally { tui.kill(); }
  }
  {
    const { tui, dir, file, rules } = await fixture('withdraw');
    try {
      await key(tui, 'a', 'enter=save');
      process.kill(Number(await readFile(path.join(dir, 'runtime.pid'), 'utf8')), 'SIGUSR1');
      await finish(tui);
      tui.send('\r');
      assert('mode withdrawal cannot save or execute stale preview', !existsSync(rules) && await readFile(file, 'utf8') === 'before');
      assert('withdrawal removes preview', !tui.frame.includes('allow rule (JSON)'));
      await close(tui);
    } finally { tui.kill(); }
  }
  {
    const { tui, file, rules } = await fixture('queued', { calls: 2 });
    try {
      await key(tui, 'a', 'enter=save');
      await key(tui, 'n', 'allow?');
      tui.send('\r');
      // Enter has no meaning on the successor prompt: the previous preview is gone.
      await tui.waitUntil(() => tui.frame.includes('allow?'), { settleMs: 150 });
      assert('queued successor is not approved by old review', !existsSync(rules) && await readFile(file, 'utf8') === 'before');
      tui.send('n');
      await finish(tui);
      await close(tui);
    } finally { tui.kill(); }
  }
}

async function edgeCases(): Promise<void> {
  header('real App — unflushed keys, resize traversal reset, withdrawal and successor');
  const name = 'resize';
  const target = path.join(ROOT, name, ...Array.from({ length: 8 }, (_, i) => `d${i}-${'z'.repeat(85)}`), 'new.txt');
  await mkdir(path.dirname(target), { recursive: true });
  const { tui, dir, rules } = await fixture(name, { cols: 60, rows: 16,
    input: { command: 'create', path: target, file_text: 'must not execute' } });
  try {
    // An a+Enter batch must not save or skip the first page before it is drawn.
    tui.send('a\r');
    await tui.waitUntil(() => tui.frame.includes('allow?'), { settleMs: 150 });
    assert('combined selection/Enter is ignored, never saves', !existsSync(rules) && !existsSync(target));
    await key(tui, 'a', 'enter=next');
    assert('selection starts with the first page', tui.frame.includes('allow rule (JSON) 1-'));
    await key(tui, '\r', 'enter=next');
    assert('Enter advances a displayed page', !tui.frame.includes('allow rule (JSON) 1-'));
    let from = tui.mark();
    tui.resize(55, 16);
    await waitText(tui, 'allow rule (JSON) 1-', from);
    assert('resize resets traversal without saving', !existsSync(rules) && !existsSync(target));
    from = tui.mark();
    tui.resize(30, 16);
    await waitText(tui, 'resize', from);
    tui.send('\r\r');
    await tui.waitUntil(() => tui.frame.includes('resize'), { settleMs: 150 });
    assert('narrow resize cannot enable save', !existsSync(rules) && !existsSync(target));
    from = tui.mark();
    tui.resize(60, 16);
    await waitText(tui, 'allow rule (JSON) 1-', from);
    process.kill(Number(await readFile(path.join(dir, 'runtime.pid'), 'utf8')), 'SIGUSR1');
    await finish(tui);
    assert('mode withdrawal discards reviewed rule', !existsSync(rules) && !existsSync(target) && !tui.frame.includes('allow rule (JSON)'));
    await close(tui);
  } finally { tui.kill(); }
  const queued = await fixture('edge-queued', { calls: 2 });
  try {
    await key(queued.tui, 'a', 'enter=save');
    queued.tui.send('n\r');
    await queued.tui.waitUntil(() => queued.tui.frame.includes('enter=save'), { settleMs: 150 });
    assert('combined deny/Enter does not confirm a rule', !existsSync(queued.rules) && await readFile(queued.file, 'utf8') === 'before');
    await key(queued.tui, 'n', 'allow?');
    queued.tui.send('\r');
    await queued.tui.waitUntil(() => queued.tui.frame.includes('allow?'), { settleMs: 150 });
    assert('Enter cannot confirm queued successor without review', !existsSync(queued.rules) && await readFile(queued.file, 'utf8') === 'before');
    queued.tui.send('n');
    await finish(queued.tui);
    await close(queued.tui);
  } finally { queued.tui.kill(); }
}

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
try {
  if (!process.argv.includes('--pty') && !process.argv.includes('--edge')) await renderCases();
  if (!process.argv.includes('--render') && !process.argv.includes('--edge')) await ptyCases();
  if (!process.argv.includes('--render')) await edgeCases();
  report();
} finally { await rm(ROOT, { recursive: true, force: true }); }
