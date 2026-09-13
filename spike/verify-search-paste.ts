/**
 * SER-089: real CLI/App/SDK pty, private HOME/cwd and local model transport only.
 * Run: pnpm tsx spike/verify-search-paste.ts
 * Requirement/check map (each named check has its own observable assertion):
 * P1 single-line ownership; P2 CRLF/CR/LF/Tab/control normalization, never actions;
 * P3 Unicode; P4 repeated paste; P5 same-write paste/key ordering; P6 256-code-point
 * cap/backspace; P7 unchanged live draft + exact Escape cursor; P8 no model request
 * or durable mutation while filtering/cancelling; P9 Enter/Tab explicit acceptance;
 * P10 permission blocks paste; P11 compaction blocks paste; P12 composer multiline
 * paste never sends; P13 narrow/wide counted frames retain SER-088's projection.
 * P1–P9/P13 run independently for Ctrl+R and rewind. Current-frame waits settle
 * before negative checks; marker insertion proves cursor, byte maps cover all
 * private HOME/project files (including trajectory, catalogue, SDK snapshots and
 * resume pointer). Rewind snapshots the typed /rewind command at a mid-text cursor
 * but clears its live composer; history holds its original multiline draft.
 * One pty write deliberately contains multiple bracketed pastes and key events.
 * The fixture model is shared with composer-yank; no production input test seam.
 */
import { strict as nodeAssert } from 'node:assert';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, header, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-search-paste-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
await mkdir(path.join(home, '.darwin'), { recursive: true });
await mkdir(cwd);
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ preserveRecentMessages: 1 }));
const tui = startTui({ cwd, cols: 100, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const ESC = '\u001b';
const BACK = '\u007f';
const CLEAR = '\u0015';
const CTRL_R = '\u0012';
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const multiline = 'MULTI\nrow\ntail\n\tZ';
const original = ['ABC🧬', 'second'];
let terminalRows = 24;

const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, {
  timeoutMs: 30_000, settleMs: 180, label,
});
function draftRows(): string[] {
  const rows = tui.frame.replace(/\r/g, '').split('\n');
  const start = rows.findIndex((row) => row.startsWith('you>'));
  if (start < 0) return [];
  const result = [rows[start]!.slice(5).trimEnd()];
  for (const row of rows.slice(start + 1)) {
    if (!row.startsWith('     ') && !row.startsWith('...> ')) break;
    result.push(row.slice(5).trimEnd());
  }
  return result;
}
function draftIs(expected: readonly string[]): boolean {
  return JSON.stringify(draftRows()) === JSON.stringify(expected);
}
function searching(): boolean {
  return /reverse search:|rewind prompts/.test(tui.frame);
}
async function bytes(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await bytes(file));
    else if (entry.isFile()) result[path.relative(root, file)] = (await readFile(file)).toString('base64');
  }
  return result;
}
async function durable(): Promise<Record<string, string>> {
  return { ...await bytes(home), ...await bytes(cwd) };
}
const calls = () => readFile(path.join(cwd, 'model-calls'), 'utf8');
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  assert(label, true);
}
async function clearDraft(): Promise<void> {
  // Delete the whole short draft, including line breaks, through ordinary editor keys.
  tui.send('\u001b[B'.repeat(10) + '\u001b[F');
  tui.send(BACK.repeat(100));
  await settled(() => draftIs(['']), 'empty composer');
}
async function sendTurn(text: string): Promise<void> {
  tui.send(paste(text));
  await settled(() => draftRows().some((row) => row.includes(text.split('\n')[0]!.slice(0, 12))), 'seed draft');
  const mark = tui.mark();
  tui.send('\r');
  await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
  await settled(() => draftIs(['']) && !tui.frame.includes('working…'), 'seed turn complete');
}
function safeFrame(rawStart: number): void {
  nodeAssert.ok(tui.frame.replace(/\r/g, '').trimEnd().split('\n').length < terminalRows, 'live frame fits viewport');
  nodeAssert.ok(!tui.raw.slice(rawStart).includes('\u001b[2J'), 'no overflow clear');
  nodeAssert.ok(!tui.frame.includes('queued ·'), 'no paste-created queue');
}
type Owner = 'history' | 'rewind';
const seeds = ['NEEDLE', multiline, 'UNICODE 中文🧬e\u0301', `CAP255 ${'🧬'.repeat(255)}`, `CAP256 ${'🧬'.repeat(256)}`, 'OTHER'];
async function open(owner: Owner): Promise<void> {
  if (owner === 'history') {
    tui.send(paste(original.join('\n')));
    await settled(() => draftIs(original), 'original multiline draft');
    tui.send('\u001b[A\u001b[H\u001b[C');
    tui.send(CTRL_R);
  } else {
    tui.send('/rewind');
    await settled(() => draftIs(['/rewind']), 'rewind command draft');
    tui.send('\u001b[H\u001b[C');
    // Dismiss AFTER moving: completion identity includes the cursor offset.
    tui.send(ESC);
    await settled(() => !tui.frame.includes('commands ('), 'rewind completion dismissed');
    tui.send('\r');
  }
  await settled(() => searching() && tui.frame.includes('1/6'), `${owner} open`);
}
async function matches(count: number, label?: string): Promise<void> {
  // Long queries truncate the title before its count; candidate rows remain visible.
  const candidateCount = () => [...tui.frame.matchAll(/^(?:❯ | {2})(?:NEEDLE|MULTI|UNICODE|CAP255|CAP256|OTHER|BRANCH)/gm)].length;
  await settled(() => searching() && (count === 0 ? /no match/.test(tui.frame)
    : count <= 5 ? candidateCount() === count : tui.frame.includes(`1/${count}`)) &&
    (label === undefined || tui.frame.includes(label)), `${count} matches ${label ?? ''}`);
}
async function resetQuery(): Promise<void> {
  tui.send(CLEAR);
  await matches(6);
}
async function searchChecks(owner: Owner): Promise<void> {
  header(`SER-089 — ${owner} paste ownership`);
  const before = await durable();
  const beforeCalls = await calls();
  await open(owner);
  const underlying = owner === 'history' ? original : [''];
  const liveDraft = () => nodeAssert.deepEqual(draftRows(), underlying, 'paste never edits underlying composer');
  await check(`${owner} P1 single-line paste filters to one candidate`, async () => {
    tui.send(paste('NEEDLE'));
    await matches(1, 'NEEDLE');
    liveDraft();
  });
  await resetQuery();
  await check(`${owner} P2 normalized multiline/control paste filters, never accepts`, async () => {
    const start = tui.raw.length;
    tui.send(paste('MULTI\r\nrow\rtail\n\t\u0003\u0004\u0012\u0015\u001b\u007fZ'));
    await matches(1, 'MULTI ⏎ row ⏎ tail ⏎ \\u0009Z');
    liveDraft();
    safeFrame(start);
    // A controls-only paste normalizes to empty and must leave the query intact.
    tui.send(paste('\u0003\u0004\u0012\u0015\u001b\u007f'));
    await matches(1, 'MULTI ⏎ row ⏎ tail ⏎ \\u0009Z');
    liveDraft();
  });
  await resetQuery();
  await check(`${owner} P3 Unicode paste matches complete code points`, async () => {
    tui.send(paste('中文🧬e\u0301'));
    await matches(1, 'UNICODE');
    liveDraft();
  });
  await resetQuery();
  await check(`${owner} P4 repeated paste appends instead of replacing`, async () => {
    tui.send(paste('NEE'));
    await matches(1, 'NEEDLE');
    tui.send(paste('DLE'));
    await matches(1, 'NEEDLE');
    tui.send(paste('X'));
    await matches(0);
    nodeAssert.ok(tui.frame.includes('NEEDLEX'), 'query concatenates all three pastes');
    liveDraft();
  });
  await resetQuery();
  await check(`${owner} P5 same-write paste/key/paste uses immediate state`, async () => {
    tui.send(`${paste('NEE')}D${paste('LE')}`);
    await matches(1, 'NEEDLE');
    liveDraft();
    tui.send(paste('!'));
    await matches(0, 'NEEDLE!'); // A partial query could select NEEDLE too; prove all text.
    // A queued query clear and two paste events must also observe each other.
    tui.send(`${CLEAR}${paste('中文')}${paste('🧬e\u0301')}`);
    await matches(1, 'UNICODE');
    liveDraft();
    tui.send(paste('!'));
    await matches(0, '中文🧬e\u0301!');
  });
  await resetQuery();
  await check(`${owner} P6 cap is exactly 256 Unicode points, with repeat/overflow/backspace`, async () => {
    tui.send(paste('🧬'.repeat(255)));
    await matches(2, 'CAP255');
    tui.send(`${paste('🧬'.repeat(20))}${paste('X')}X`);
    await matches(1, 'CAP256');
    nodeAssert.ok(!tui.frame.includes('CAP255'), '256 points, not 255 or UTF-16 units');
    liveDraft();
    tui.send(BACK);
    await matches(2, 'CAP255');
    tui.send(paste('🧬'));
    await matches(1, 'CAP256');
    tui.send(`${CLEAR}${paste('🧬'.repeat(300))}`);
    await matches(1, 'CAP256');
    tui.send(BACK);
    await matches(2, 'CAP255');
    liveDraft();
  });
  await resetQuery();
  await check(`${owner} P13 narrow multiline previews stay on counted rows`, async () => {
    tui.resize(40, 18);
    terminalRows = 18;
    await settled(() => searching() && tui.frame.includes('OTHER'), 'narrow settled frame');
    const start = tui.raw.length;
    tui.send(paste(multiline));
    await matches(1, 'MULTI ⏎ row ⏎ tail');
    safeFrame(start);
    liveDraft();
    tui.resize(100, 24);
    terminalRows = 24;
    await matches(1, 'MULTI ⏎ row ⏎ tail ⏎ \\u0009Z');
  });
  await check(`${owner} P7 Escape restores exact draft and insertion cursor`, async () => {
    const restored = owner === 'history' ? original : ['/rewind'];
    tui.send(ESC);
    await settled(() => !searching() && draftIs(restored), 'cancelled unchanged');
    tui.send('~');
    await settled(() => draftIs(owner === 'history' ? ['A~BC🧬', 'second'] : ['/~rewind']), 'restored cursor marker');
    tui.send(BACK);
    await settled(() => draftIs(restored), 'marker removed');
  });
  await check(`${owner} P8 filtering/cancel made no request or durable mutation`, async () => {
    nodeAssert.equal(await calls(), beforeCalls);
    nodeAssert.deepEqual(await durable(), before);
  });
  await clearDraft();
}

header('SER-089 — isolated production CLI, local SDK model');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
  for (const seed of seeds) await sendTurn(seed);
  for (const owner of ['history', 'rewind'] as const) await searchChecks(owner);

  await check('history P5 Ctrl+R and paste in one write sees the new owner', async () => {
    const before = await durable();
    tui.send(`${CTRL_R}${paste('NEEDLE')}`);
    await matches(1, 'NEEDLE');
    nodeAssert.ok(draftIs(['']));
    tui.send(ESC);
    await settled(() => !searching() && draftIs(['']), 'same-event open cancelled');
    nodeAssert.deepEqual(await durable(), before);
  });
  for (const key of ['\r', '\t']) {
    await check(`history P9 explicit ${key === '\r' ? 'Enter' : 'Tab'} accepts raw multiline text without sending`, async () => {
      const before = await durable();
      tui.send(CTRL_R);
      await matches(6);
      tui.send(paste(multiline));
      await matches(1, 'MULTI ⏎ row');
      tui.send(key);
      await settled(() => !searching() && draftRows()[0] === 'MULTI' && draftRows().length === 4, 'raw multiline accepted');
      nodeAssert.deepEqual(draftRows().slice(0, 3), ['MULTI', 'row', 'tail']);
      // Tab's editor projection is whitespace, not the literal preview escape.
      nodeAssert.ok(!tui.frame.includes('\\u0009'));
      tui.send('~');
      await settled(() => draftRows()[3]?.trim() === 'Z~', 'accepted cursor at raw end');
      nodeAssert.deepEqual(await durable(), before);
      if (key === '\t') {
        // Only now explicitly send: the captured SDK request proves raw tabs/newlines,
        // not merely the row projection, survived query acceptance and cursor edits.
        const mark = tui.mark();
        tui.send('\r');
        await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
        await settled(() => draftIs(['']) && !tui.frame.includes('working…'), 'accepted prompt explicitly sent');
        nodeAssert.equal(JSON.parse((await calls()).trimEnd().split('\n').at(-1)!), `${multiline}~`);
      }
      await clearDraft();
    });
  }
  await check('P12 ordinary normalized multiline paste edits but never sends or queues', async () => {
    const before = await durable();
    const rawStart = tui.raw.length;
    tui.send(paste('FIRST\r\nSECOND\rTHIRD\n\t\u0003Z'));
    await settled(() => draftRows().length === 4 && draftRows()[3]?.trim() === 'Z', 'ordinary pasted lines');
    nodeAssert.deepEqual(draftRows().slice(0, 3), ['FIRST', 'SECOND', 'THIRD']);
    safeFrame(rawStart);
    nodeAssert.deepEqual(await durable(), before);
    await clearDraft();
  });
  await check('P10 permission ignores pasted approval/controls and retains held draft/cursor', async () => {
    const mark = tui.mark();
    tui.submit('permission');
    await tui.waitFor('permission preparing', { from: mark, timeoutMs: 30_000 });
    tui.send('ABC');
    await settled(() => draftIs(['ABC']), 'held draft');
    tui.send('\u001b[H\u001b[C');
    await writeFile(path.join(cwd, 'release-permission'), '');
    await settled(() => tui.frame.includes('allow?'), 'permission pending');
    const before = await durable();
    tui.send(paste('y\r\nn\t\u0003\u001bBLOCKED'));
    await settled(() => tui.frame.includes('allow?') && !tui.frame.includes('BLOCKED'), 'paste did not answer permission');
    nodeAssert.deepEqual(await durable(), before);
    await nodeAssert.rejects(readFile(path.join(cwd, 'yank-permission-sentinel')), { code: 'ENOENT' });
    tui.send('n');
    await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => draftIs(['ABC']) && !tui.frame.includes('allow?'), 'permission denied');
    tui.send('~');
    await settled(() => draftIs(['A~BC']), 'permission retained cursor');
    await clearDraft();
  });
  await check('P11 compaction ignores paste and returns an empty unqueued composer', async () => {
    const mark = tui.mark();
    tui.submit('/compact');
    await tui.waitFor('compacting conversation', { from: mark, timeoutMs: 30_000, settleMs: 200 });
    const before = await durable();
    tui.send(paste('BLOCKED\r\n\t\u0003\u001b'));
    await settled(() => tui.frame.includes('compacting conversation') && !tui.frame.includes('BLOCKED'), 'compaction still owns paste');
    nodeAssert.deepEqual(await durable(), before);
    await writeFile(path.join(cwd, 'release-summary'), '');
    await tui.waitFor('conversation compacted', { from: mark, timeoutMs: 30_000 });
    await settled(() => draftIs(['']) && !tui.frame.includes('compacting conversation'), 'compaction completed');
    const afterCalls = await calls();
    nodeAssert.ok(!afterCalls.includes('BLOCKED'), 'blocked paste never reached the model');
    tui.send('~');
    await settled(() => draftIs(['~']) && !tui.frame.includes('queued ·'), 'no deferred paste');
    nodeAssert.equal(await calls(), afterCalls);
    await clearDraft();
  });
  for (const key of ['\r', '\t']) {
    // Each accepted successor is a real new session; seed its own checkpoints.
    await sendTurn('BRANCH first');
    await sendTurn('BRANCH chosen\nsecond');
    await check(`rewind P9 explicit ${key === '\r' ? 'Enter' : 'Tab'} branches once, selected prompt unsent`, async () => {
      const beforeCalls = await calls();
      tui.submit('/rewind');
      await settled(searching, 'acceptance chooser');
      tui.send(paste('BRANCH chosen\r\nsecond'));
      await matches(1, 'BRANCH chosen ⏎ second');
      nodeAssert.equal(await calls(), beforeCalls);
      const mark = tui.mark();
      // Include an additional paste immediately before Tab: acceptance must read it.
      tui.send(key === '\t' ? `${CLEAR}${paste('BRANCH chosen\nsecond')}${key}` : key);
      await tui.waitFor('rewound conversation into new session', { from: mark, timeoutMs: 30_000 });
      await settled(() => !searching() && draftIs(['BRANCH chosen', 'second']), 'branched prompt unsent');
      tui.send('~');
      await settled(() => draftIs(['BRANCH chosen', 'second~']), 'branch cursor at raw end');
      nodeAssert.equal(await calls(), beforeCalls);
      nodeAssert.ok(!tui.frame.includes('queued ·'));
      await clearDraft();
    });
  }
  tui.send('\u0004');
  nodeAssert.equal(await tui.exitedWithin(30_000), 0);
  report();
} catch (error) {
  await writeFile(path.join(root, 'failure.txt'), tui.raw.slice(-100_000));
  console.error(`pty evidence: ${root}/failure.txt\n${tui.frame}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}
