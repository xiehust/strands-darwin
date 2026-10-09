/** SER-117 owned-HOME real files: shared rows, scope/absence, scan/display boundaries,
 * terminal-safe cells, canonical discovery and byte-zero reads. No filesystem mocks.
 * Run: pnpm tsx spike/verify-sessions-tui.ts
 */
import { strict as check } from 'node:assert';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leasePath, sessionPaths, snapshotPath, trajectoryPath } from '../src/agent/session.js';
import { sessionLabelPath } from '../src/agent/session-label.js';
import { readSessions, runSessionsCommand } from '../src/cli-sessions.js';
import { formatSessionsReport, readSessionsReport, sessionCell, MAX_SESSIONS_SCAN_ENTRIES, MAX_SESSIONS_ROWS, MAX_SESSION_CELL_POINTS } from '../src/tui/sessions-format.js';
import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { formatHelpReport, MAX_HELP_COMMANDS } from '../src/tui/help-format.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('sessions-tui');
const root = path.join(home, 'project');
const now = Date.now();

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
}
async function seed(project: string, id: string, ageMinutes = 0, prompt?: string): Promise<void> {
  const snapshot = snapshotPath(project, id, 'darwin');
  await put(snapshot, JSON.stringify({ sessionId: id, messages: [] }));
  const time = new Date(now - ageMinutes * 60_000);
  await utimes(snapshot, time, time);
  if (prompt !== undefined) await put(trajectoryPath(project, id), JSON.stringify({
    v: 1, seq: 1, t: new Date(now).toISOString(), turn: 1, type: 'userInput', text: prompt,
  }) + '\n');
}
async function bytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await bytes(file));
    else if (entry.isFile()) result[file] = (await readFile(file)).toString('base64');
  }
  return result;
}
async function cli(project: string): Promise<string> {
  let text = '';
  check.equal(await runSessionsCommand({ projectRoot: project, out: value => { text += value; }, err: () => check.fail('unexpected stderr') }, now), 0);
  return text;
}
const sessionRows = (text: string): string[] => text.split('\n').filter(row => row.startsWith('  ') && !row.startsWith('  …'));

header('SER-117 shared real-file rows and byte-zero absence/scope');
const empty = await readSessionsReport(root, now);
check.ok(empty.includes('no resumable sessions in this project') && empty.includes('darwin --resume <id>'));
check.deepEqual(await readdir(home), []); // Absent store does not get created.
await seed(root, 'hand-named', 5, '  first\nrecorded prompt  ');
await seed(root, 'older', 60);
await seed(root, 'damaged', 120);
await put(trajectoryPath(root, 'damaged'), 'not JSON\n{"broken":\n');
await put(trajectoryPath(root, 'orphan'), '{}\n');
await put(sessionLabelPath(root, 'hand-named'), JSON.stringify({ version: 1, label: 'triage 中😀' }));
await put(sessionLabelPath(root, 'older'), '{ invalid metadata');
await put(sessionLabelPath(root, 'damaged'), JSON.stringify({ version: 1, label: '' }));
await put(sessionPaths(root).pointerFile, JSON.stringify({ sessionId: 'older', updatedAt: new Date(now).toISOString() }));
await put(leasePath(root, 'hand-named'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date(now).toISOString() }));
await put(leasePath(root, 'older'), JSON.stringify({ pid: 0, hostname: os.hostname(), startedAt: new Date(now).toISOString() }));
const other = path.join(home, 'other-project');
await seed(other, 'foreign', 0, 'other project must not appear');
const before = await bytes(home);
const model = await readSessions(root, MAX_SESSIONS_SCAN_ENTRIES);
const complete = await readSessions(root);
check.deepEqual(model.rows, complete.rows);
check.deepEqual(model.rows.map(row => row.id), ['hand-named', 'older', 'damaged']);
check.equal(model.skipped, 1);
const tui = await readSessionsReport(root, now);
const listing = await cli(root);
for (const [index, row] of model.rows.entries()) {
  const cliRow = listing.split('\n').find(line => line.startsWith(row.id))!;
  const tuiRow = sessionRows(tui)[index]!;
  check.equal(tuiRow.trim().replace(/ {2,}/g, ' '), cliRow.trim().replace(/ {2,}/g, ' '));
}
check.ok(tui.includes('5m ago') && tui.includes('1h ago') && tui.includes('2h ago'));
check.ok(tui.includes('first recorded prompt') && tui.includes('label: "triage 中😀"'));
check.equal((tui.match(/label:/g) ?? []).length, 1);
check.equal((tui.match(/\(not recorded\)/g) ?? []).length, 2);
check.ok(sessionRows(tui)[1]!.includes('(last)') && sessionRows(tui)[0]!.includes(`(open in pid ${process.pid})`));
check.equal((tui.match(/\(open /g) ?? []).length, 1);
check.ok(tui.includes('1 inspected session(s) without a restorable snapshot not listed'));
check.ok(!tui.includes('foreign') && (await readSessionsReport(other, now)).includes('foreign'));
check.deepEqual(await bytes(home), before);
assert('CLI/TUI share IDs, snapshot ages/order, first prompt, label, last/live markers; malformed/missing data and project scope are byte-zero', true);

const metadata = path.join(home, 'metadata-absence');
for (const id of ['missing', 'empty', 'malformed', 'valid']) await seed(metadata, id);
await put(sessionLabelPath(metadata, 'empty'), '');
await put(sessionLabelPath(metadata, 'malformed'), JSON.stringify({ version: 99, label: 'wrong version' }));
await put(sessionLabelPath(metadata, 'valid'), JSON.stringify({ version: 1, label: '\\"'.repeat(40) }));
const metadataBefore = await bytes(home);
const metadataModel = await readSessions(metadata, MAX_SESSIONS_SCAN_ENTRIES);
check.equal(metadataModel.rows.filter(row => row.label !== undefined).length, 1);
check.equal((formatSessionsReport(metadataModel, now).match(/label:/g) ?? []).length, 1);
check.ok(sessionRows(formatSessionsReport(metadataModel, now)).every(row => [...row].length <= 5 * MAX_SESSION_CELL_POINTS + 40));
check.deepEqual(await bytes(home), metadataBefore);
assert('missing/empty/wrong-version metadata is unnamed; escaped 80-point label stays bounded and stores remain byte-identical', true);

header('SER-117 terminal safety over legacy real-file cells');
const longId = 'legacy-' + 'x'.repeat(180);
await seed(root, longId, 0, '\u001b[31munsafe\u0007\u009btitle\u202e reverse\u2028line ' + '😀'.repeat(100));
await put(sessionLabelPath(root, longId), JSON.stringify({ version: 1, label: '\u001b[2Jbad' }));
await put(leasePath(root, longId), JSON.stringify({ pid: process.pid, hostname: 'foreign\u001b]0;owned\u0007\u202ehost', startedAt: new Date(now).toISOString() }));
// Invalid legacy directory IDs are excluded by the same CLI alphabet, not offered as resume IDs.
await seed(root, 'invalid\u001bID', 0, 'invalid id prompt');
const legacyBefore = await bytes(home);
const legacy = await readSessionsReport(root, now);
check.ok(!/[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/u.test(legacy.replace(/\n/g, '')));
check.ok(!legacy.includes(longId) && legacy.includes('legacy-') && legacy.includes('…'));
check.ok(!legacy.includes('invalid id prompt') && !legacy.includes('label: "bad"'));
const legacyRow = sessionRows(legacy)[0]!;
check.ok(legacyRow.includes('(open on foreign') && legacyRow.includes('unsafe'));
for (const cell of legacyRow.trim().split(/ {2,}/)) check.ok([...cell].length <= MAX_SESSION_CELL_POINTS + 16);
check.equal([...sessionCell('id\u001b\u0007\u202e\n' + '😀'.repeat(200))].length, MAX_SESSION_CELL_POINTS);
check.ok(sessionRows(legacy).every(row => [...row].length <= 5 * MAX_SESSION_CELL_POINTS + 40));
check.deepEqual(await bytes(home), legacyBefore);
assert('legacy prompt/host controls removed, unsafe labels unnamed, long IDs/cells visibly bounded; raw stores unchanged', true);

header('SER-117 exact scan boundary, overflow probe and display omissions');
const displayBoundary = path.join(home, 'display-boundary');
for (let index = 0; index < 20; index++) await seed(displayBoundary, `row-${index}`, index);
const twenty = await readSessionsReport(displayBoundary, now);
check.equal(sessionRows(twenty).length, 20);
check.ok(!twenty.includes('not shown') && !twenty.includes('scan limit'));
await seed(displayBoundary, 'row-20', 20);
const twentyOne = await readSessionsReport(displayBoundary, now);
check.equal(sessionRows(twentyOne).length, 20);
check.ok(twentyOne.includes('1 more inspected resumable session(s) not shown') && !twentyOne.includes('scan limit'));
const boundary = path.join(home, 'boundary');
// 199 SDK entries + the base's session directory = 200 entries, exactly.
for (let index = 0; index < 199; index++) await seed(boundary, `saved-${index}`, index);
const exact = await readSessions(boundary, MAX_SESSIONS_SCAN_ENTRIES);
check.equal(exact.inspected, 200);
check.equal(exact.scanCapped, false);
check.equal(exact.rows.length, 199);
const exactReport = formatSessionsReport(exact, now);
check.equal(sessionRows(exactReport).length, MAX_SESSIONS_ROWS);
check.ok(exactReport.includes('179 more inspected resumable session(s) not shown (display limit 20)'));
await seed(boundary, 'overflow', 0);
const overflow = await readSessions(boundary, MAX_SESSIONS_SCAN_ENTRIES);
check.equal(overflow.inspected, 200);
check.equal(overflow.scanCapped, true);
check.equal(overflow.rows.length, 200);
const overflowReport = formatSessionsReport(overflow, now);
check.ok(overflowReport.includes('newest activity among inspected entries only') && !overflowReport.includes('newest activity first'));
check.ok(overflowReport.includes('additional entries not inspected (count unknown)') && overflowReport.includes('complete listing'));
for (let index = 200; index < 250; index++) await seed(boundary, `saved-${index}`, index);
const cappedBefore = await bytes(home);
const capped = await readSessions(boundary, MAX_SESSIONS_SCAN_ENTRIES);
check.equal(capped.inspected, 200);
check.equal(capped.rows.length, 200);
check.equal(capped.scanCapped, true);
check.ok(capped.rows.every((row, index) => index === 0 || capped.rows[index - 1]!.activeAt >= row.activeAt));
check.equal(sessionRows(formatSessionsReport(capped, now)).length, 20);
check.equal((await readSessions(boundary)).rows.length, 250); // CLI remains complete.
const cappedCli = await cli(boundary);
check.equal(cappedCli.split('\n').filter(line => /^(saved-|overflow)/.test(line)).length, 250);
check.deepEqual(await bytes(home), cappedBefore);
const noSnapshots = path.join(home, 'only-orphans');
for (let index = 0; index < 205; index++) await mkdir(path.join(sessionPaths(noSnapshots).stateDir, `orphan-${index}`), { recursive: true });
const onlyOrphans = await readSessionsReport(noSnapshots, now);
check.ok(onlyOrphans.includes('no resumable sessions among inspected entries') && !onlyOrphans.includes('no resumable sessions in this project'));
check.ok(onlyOrphans.includes('200 inspected session(s) without a restorable snapshot') && onlyOrphans.includes('scan limit 200'));
assert('200-entry scan + one overflow probe, 20-row display and separate omissions; capped order/empty claims are inspected-only; CLI complete', true);

header('SER-117 read-only seams and canonical discoverability');
const source = (file: string): string => readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
for (const file of ['src/cli-sessions.ts', 'src/tui/sessions-format.ts', 'src/agent/session-label.ts']) {
  const text = source(file);
  check.ok(!/from ['"][^'"]*session-label-write|import\([^)]*session-label-write/.test(text));
  check.ok(!/writeFile|appendFile|createWriteStream|\bmkdir\b|\bunlink\b|\brename\s*\(|truncate|utimes/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
}
const seen = new Set<string>();
function inspectImports(file: string): void {
  if (seen.has(file)) return;
  seen.add(file);
  check.ok(!file.endsWith('/session-label-write.ts'), `metadata writer reached through ${file}`);
  const text = source(file);
  for (const match of text.matchAll(/^import (?!type\b)[^;]*?from ['"](\.[^'"]+)['"]/gm)) {
    const target = path.join(path.dirname(file), match[1]!).replace(/\.js$/, '.ts');
    inspectImports(target);
  }
}
inspectImports('src/cli-sessions.ts');
inspectImports('src/tui/sessions-format.ts');
const reads = source('src/cli-sessions.ts');
check.ok(reads.includes('bufferSize: 1') && reads.includes('if (inspected === maxEntries) return'));
const app = source('src/tui/App.tsx');
const branch = app.slice(app.indexOf('// Saved snapshots in this project only.'), app.indexOf('// SER-057:'));
check.ok(branch.includes('runtime.info.projectRoot') && !/runtime\.(send|listMcp|startNew|rename)|setStatus|setQueued|runTurn|userInput/.test(branch));
check.ok(BUILTIN_COMMAND_NAMES.includes('sessions'));
check.ok(MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length && MAX_HELP_COMMANDS >= BUILTIN_COMMAND_NAMES.length);
for (const name of BUILTIN_COMMAND_NAMES) check.ok(formatHelpReport().includes(`/${name} —`), `help must expose ${name}`);
assert('read model/label seam has no metadata writer; ordinary local branch has no execution/state channel; every built-in exposed', true);

report();
