/** SER-085 offline production-CLI pty acceptance (in pnpm test).
 * Requirement -> proving checks below:
 * S1 exact Unicode/cursor, occupied/empty and cap -> state suite + editor probes.
 * S2 hidden draft never submitted/persisted -> full request capture + all HOME files.
 * S3 busy queue/recall/ownership -> real keys, file-held local model/permission/summary.
 * S4 image invariant/generation -> real delayed wl-paste helper, queue + in-flight.
 * S5 lifetime -> model/compact keep; successful clear/rewind/tangent/exit drop.
 * S6 reset undo/lastCut/completion/recall/preferred column -> post-transition probes.
 * S7 raw Ctrl+S (never Ctrl+Q) and narrow frame -> responsive output/no overflow clear.
 * No fake App, provider transport, external model, user HOME or source-only assertion.
 * Separate control writes and settled latest-frame predicates avoid stale scrollback.
 * Run: pnpm tsx spike/verify-composer-stash.ts
 */
import { strict as check } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DRAFT_STASH_CAP, DRAFT_STASH_DROP_NOTICE } from '../src/tui/draft-stash.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-stash-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
const bin = path.join(root, 'bin');
await mkdir(path.join(home, '.darwin'), { recursive: true });
await mkdir(cwd);
await mkdir(bin);
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ preserveRecentMessages: 1,
  models: [
    { enable: true, name: 'first', provider: 'bedrock', model: 'fake.stash-first', region: 'us-west-2' },
    { enable: false, name: 'second', provider: 'bedrock', model: 'fake.stash-second', region: 'us-west-2' },
  ],
}));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64');
await writeFile(path.join(cwd, 'clipboard.png'), png);
// Real executable helper: release files bound callback races without guessing sleeps.
await writeFile(path.join(bin, 'wl-paste'), `#!${process.execPath}
const fs = require('node:fs');
const mode = fs.existsSync('clip-mode') ? fs.readFileSync('clip-mode', 'utf8') : 'immediate';
fs.appendFileSync('clip-starts', mode + '\\n');
const done = () => { process.stdout.write(fs.readFileSync('clipboard.png')); fs.appendFileSync('clip-done', mode + '\\n'); };
if (mode === 'immediate') done();
else { const timer = setInterval(() => { if (fs.existsSync('release-' + mode)) { clearInterval(timer); done(); } }, 20); }
`);
await chmod(path.join(bin, 'wl-paste'), 0o755);
const tui = startTui({ cwd, cols: 80, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/draft-stash-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true',
    PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'stash-test' },
});
const STASH = '\u0013';
const CLIP = '\u000f';
const HOME = '\u001b[H';
const END = '\u001b[F';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ESC = '\u001b';
const BACK = '\u007f';
const UNDO = '\u001f';
const YANK = '\u0019';

const draft = () => /you> ?([^\r\n]*)/.exec(tui.frame)?.[1]?.trimEnd();
const chip = () => tui.frame.includes('Ctrl+O remove');
const parked = () => tui.frame.includes('stash: Ctrl+S');
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 30_000, settleMs: 180, label });
async function keys(input: string, expected: string): Promise<void> {
  tui.send(input);
  await settled(() => draft() === expected, `draft ${JSON.stringify(expected)}`);
}
async function stash(expected: string, occupied: boolean): Promise<void> {
  const mark = tui.mark();
  tui.send(STASH);
  await tui.waitFor(occupied ? 'draft stashed' : 'draft restored', { from: mark, timeoutMs: 30_000 });
  await settled(() => draft() === expected && parked() === occupied, 'stash transition');
}
async function erase(): Promise<void> {
  tui.send(HOME);
  tui.send('\u000b');
  await settled(() => draft() === '', 'erase short composer');
}
async function local(command: string, notice: string): Promise<void> {
  const mark = tui.mark();
  tui.submit(command);
  await tui.waitFor(notice, { from: mark, timeoutMs: 30_000 });
  await settled(() => draft() === '', 'local command finished');
}
async function turn(text: string): Promise<void> {
  const mark = tui.mark();
  tui.submit(text);
  await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
  await settled(() => draft() === '' && !tui.frame.includes('working…'), 'turn finished');
}
async function allFiles(dir: string): Promise<{ name: string; text: string }[]> {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(name));
    else files.push({ name, text: await readFile(name, 'utf8') });
  }
  return files;
}
async function privateDraft(text: string): Promise<void> {
  for (const file of await allFiles(home)) check.ok(!file.text.includes(text), `hidden text in ${file.name}`);
  const requests = await readFile(path.join(cwd, 'model-requests'), 'utf8').catch(() => '');
  check.ok(!requests.includes(text), 'hidden text in model request');
}
async function release(name: string): Promise<void> { await writeFile(path.join(cwd, name), ''); }
async function helperReached(file: string, operation: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await readFile(path.join(cwd, file), 'utf8').catch(() => '')).includes(operation)) return;
    await delay(20);
  }
  throw new Error(`clipboard helper did not reach ${file}: ${operation}`);
}
async function probe(label: string, action: () => Promise<void>): Promise<void> { await action(); assert(label, true); }

header('SER-085 — stash in the production CLI with local transport');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
  await probe('S1/S7 empty Ctrl+S inert; raw terminal keeps rendering without Ctrl+Q', async () => {
    await keys(STASH, '');
    await keys('raw-alive', 'raw-alive');
    check.ok(!parked());
    await erase();
  });
  const hidden = 'PRIVATE_中e\u0301👩‍👩‍👧‍👦_tail';
  await probe('S1/S2 exact Unicode cursor; hidden across send; occupied refuses without swapping', async () => {
    await keys(hidden, hidden);
    await keys(HOME, hidden);
    await keys('\u001b[C', hidden); // after P
    await stash('', true);
    await keys(YANK, '');
    await keys(UNDO, '');
    await privateDraft(hidden);
    await keys('intervening', 'intervening');
    const mark = tui.mark();
    await keys(STASH, 'intervening');
    await tui.waitFor('draft stash occupied', { from: mark });
    await turn('');
    await privateDraft(hidden);
    await stash(hidden, false);
    await privateDraft(hidden); // restoration alone is not recorded
    await keys('X', 'PX' + hidden.slice(1));
    await keys(BACK, hidden);
    await turn('');
    check.ok((await readFile(path.join(cwd, 'model-requests'), 'utf8')).includes(hidden));
    const records = (await allFiles(home)).filter((file) => file.name.endsWith('trajectory.jsonl'));
    check.ok(records.length > 0);
    const inputs = records.flatMap((file) => file.text.split('\n').filter((line) => line.includes('userInput') && line.includes(hidden)));
    check.equal(inputs.length, 1, 'only ordinary submission records the restored literal prompt');
  });
  await probe('S6 both transfers clear destructive undo and lastCut, not exact cursor', async () => {
    await keys('retain CUT', 'retain CUT');
    await keys('\u0017', 'retain');
    await stash('', true);
    await keys(YANK, '');
    await keys(UNDO, '');
    await keys('OTHER', 'OTHER');
    await keys('\u0015', '');
    await stash('retain', false);
    await keys(YANK, 'retain');
    await keys(UNDO, 'retain');
    await keys('X', 'retain X');
    await erase();
  });
  await probe('S6 completion selection/dismissal and recall reset; stash survives recall', async () => {
    await keys('/c', '/c');
    await keys(DOWN, '/c');
    await keys(ESC, '/c');
    check.ok(!tui.frame.includes('commands ('));
    await stash('', true);
    await keys(UP, hidden);
    await erase();
    await stash('/c', false);
    await settled(() => tui.frame.includes('commands ('), 'completion rearmed');
    check.ok(!tui.frame.includes('history 1/'));
    await keys('\t', '/clear'); // first candidate, not previously selected /compact
    await erase();
  });
  await probe('S1/S7 over-cap unchanged and never truncated; cap-sized draft can stash', async () => {
    const huge = 'Z'.repeat(DRAFT_STASH_CAP + 1);
    tui.send(`\u001b[200~${huge}\u001b[201~`);
    await settled(() => tui.frame.includes('draft rows not shown'), 'large paste');
    const mark = tui.mark();
    tui.send(STASH);
    await tui.waitFor('exceeds 65,536 code points', { from: mark });
    check.ok(!parked());
    tui.send(BACK);
    await settled(() => tui.frame.includes('draft rows not shown'), 'remove exactly one point');
    await stash('', true); // exactly cap now
    tui.send(STASH);
    await settled(() => !parked() && tui.frame.includes('draft rows not shown'), 'full cap restored');
    // A single word cut removes the whole cap draft, without submission or disk exposure.
    await keys('\u0017', '');
    await local('/help', 'Ctrl+S');
  });
  await probe('S6/S7 soft-wrap affinity and preferred-column reset at 40x18, no overflow clear', async () => {
    tui.resize(40, 18);
    await settled(() => tui.frame.includes('you>'), 'narrow frame');
    const wrapped = `${'a'.repeat(34)}TAIL`;
    tui.send(wrapped);
    await settled(() => /\n +TAIL/.test(tui.frame), 'wrapped tail');
    tui.send(HOME); // downstream boundary at second row start
    await settled(() => /\n +TAIL/.test(tui.frame), 'boundary cursor');
    const start = tui.raw.length;
    await stash('', true);
    check.ok(tui.frame.includes('stash: Ctrl+S'));
    tui.send(STASH);
    await settled(() => !parked() && /\n +TAIL/.test(tui.frame), 'wrapped restore');
    tui.send('\u0015'); // must kill nothing at downstream start, not row one
    await settled(() => /\n +TAIL/.test(tui.frame), 'affinity preserved');
    tui.send('X');
    await settled(() => /\n +XTAIL/.test(tui.frame), 'exact boundary insertion');
    check.ok(!tui.raw.slice(start).includes('\u001b[2J'), 'no repeated full-screen redraw');
    tui.resize(80, 24);
    await settled(() => draft() === `${'a'.repeat(34)}XTAIL`, 'unwrapped');
    await erase();
  });
  await probe('S6 multiline paste and vertical preferred-column reset on restore', async () => {
    tui.send('\u001b[200~abcdef\nx\nabcdef\u001b[201~');
    await settled(() => tui.frame.includes('abcdef'), 'multiline paste');
    tui.send(UP); // column 6 preference, clamped to short middle row at column 1
    await settled(() => tui.frame.includes('abcdef'), 'middle row');
    await stash('', true);
    tui.send(STASH);
    await settled(() => !parked() && tui.frame.includes('abcdef'), 'multiline restore');
    tui.send(DOWN); // reset preference must use column 1, not old column 6
    await settled(() => tui.frame.includes('abcdef'), 'next row');
    tui.send('X');
    await settled(() => tui.frame.includes('aXbcdef'), 'reset preferred column');
    await turn(''); // only this explicit Enter sends the restored multiline draft
  });
  await probe('S3 busy stash/restore is unsent; queue take-back and cancel preserve the slot', async () => {
    await keys('BUSY_PRIVATE', 'BUSY_PRIVATE');
    await stash('', true);
    const mark = tui.mark();
    tui.submit('!sleep 30');
    await tui.waitFor('running ! command', { from: mark, settleMs: 200 });
    await stash('BUSY_PRIVATE', false);
    await stash('', true);
    tui.resize(40, 24);
    await settled(() => tui.frame.includes('running ! command') && parked(), 'busy suffix visible at narrow width');
    const busyStart = tui.raw.length;
    await keys('x', 'x');
    await keys(BACK, '');
    check.ok(!tui.raw.slice(busyStart).includes('\u001b[2J'));
    tui.resize(80, 24);
    await settled(() => draft() === '' && parked(), 'wide busy composer');
    tui.submit('queued draft');
    await settled(() => tui.frame.includes('queued · queued draft') && draft() === '', 'queued');
    await keys(UP, 'queued draft');
    const refused = tui.mark();
    await keys(STASH, 'queued draft');
    await tui.waitFor('draft stash occupied', { from: refused });
    tui.send('\r');
    await settled(() => tui.frame.includes('queued · queued draft') && draft() === '', 'queued again');
    tui.send('\u0003');
    await settled(() => draft() === 'queued draft' && !tui.frame.includes('running ! command'), 'cancel return');
    await privateDraft('BUSY_PRIVATE');
    await erase();
    await stash('BUSY_PRIVATE', false);
    await erase();
  });
  // Consume the shell report before permission's exact fixture trigger.
  await turn('after shell');
  await probe('S2/S3 automatic queue drain never sends the stash', async () => {
    await keys('DRAIN_PRIVATE', 'DRAIN_PRIVATE');
    await stash('', true);
    const mark = tui.mark();
    tui.submit('!while [ ! -e release-drain ]; do sleep 0.05; done');
    await tui.waitFor('running ! command', { from: mark });
    tui.submit('drained prompt');
    await settled(() => tui.frame.includes('queued · drained prompt'), 'queued for drain');
    await release('release-drain');
    await tui.waitFor('local answer', { from: mark });
    await settled(() => draft() === '' && parked() && !tui.frame.includes('working…'), 'queue drained, stash stays');
    await privateDraft('DRAIN_PRIVATE');
    await stash('DRAIN_PRIVATE', false);
    await erase();
  });
  await probe('S3 history and rewind search cannot stash/restore, cancellation preserves slot', async () => {
    await keys('SEARCH_PRIVATE', 'SEARCH_PRIVATE');
    await stash('', true);
    tui.send('\u0012');
    await settled(() => tui.frame.includes('search'), 'history search');
    const before = tui.frame;
    tui.send(STASH);
    await settled(() => tui.frame === before, 'search owns Ctrl+S');
    await keys(ESC, '');
    await local('/rewind', 'rewind');
    const rewind = tui.frame;
    tui.send(STASH);
    await settled(() => tui.frame === rewind, 'rewind search owns Ctrl+S');
    await keys(ESC, '/rewind');
    await erase();
    await stash('SEARCH_PRIVATE', false);
    await erase();
  });
  await probe('S3 permission owns Ctrl+S; busy composer can stash before permission arrives', async () => {
    const mark = tui.mark();
    tui.submit('permission');
    await tui.waitFor('permission preparing', { from: mark });
    await keys('PERMISSION_PRIVATE', 'PERMISSION_PRIVATE');
    await stash('', true);
    await release('release-permission');
    await settled(() => tui.frame.includes('allow?'), 'permission ready');
    tui.send(STASH);
    await settled(() => tui.frame.includes('allow?'), 'Ctrl+S cannot approve');
    await check.rejects(readFile(path.join(cwd, 'permission-sentinel')), { code: 'ENOENT' });
    tui.send('n');
    await tui.waitFor('local answer', { from: mark });
    await settled(() => draft() === '' && parked() && !tui.frame.includes('working…'), 'denied with stash intact');
    await privateDraft('PERMISSION_PRIVATE');
    await stash('PERMISSION_PRIVATE', false);
    await erase();
  });
  await probe('S3/S5 model switch and compaction preserve stash; compaction owns Ctrl+S', async () => {
    await keys('COMPACT_PRIVATE', 'COMPACT_PRIVATE');
    await stash('', true);
    await local('/model second', 'saved to ~/.darwin/config.json');
    check.ok(parked());
    const config = JSON.parse(await readFile(path.join(home, '.darwin/config.json'), 'utf8')) as { models: { name: string; enable: boolean }[] };
    check.ok(config.models.find((model) => model.name === 'second')?.enable, 'actual model switch, not list/refusal');
    const mark = tui.mark();
    tui.submit('/compact');
    await tui.waitFor('compacting conversation', { from: mark, settleMs: 200 });
    tui.send(STASH);
    await settled(() => tui.frame.includes('compacting conversation') && !tui.frame.includes('COMPACT_PRIVATE'), 'compaction owns Ctrl+S');
    await release('release-summary');
    await tui.waitFor('conversation compacted', { from: mark });
    await settled(() => draft() === '' && parked(), 'compacted with stash');
    await privateDraft('COMPACT_PRIVATE');
    await stash('COMPACT_PRIVATE', false);
    await erase();
  });
  await probe('S4 pending clipboard results are invalidated by both stash and restore', async () => {
    for (const operation of ['stash', 'restore']) {
      await keys('pending', 'pending');
      if (operation === 'restore') await stash('', true);
      await writeFile(path.join(cwd, 'clip-mode'), operation);
      tui.send(CLIP);
      await helperReached('clip-starts', operation);
      await stash(operation === 'stash' ? '' : 'pending', operation === 'stash');
      await release(`release-${operation}`);
      await helperReached('clip-done', operation);
      await delay(200); // helper exit + decoder settlement; late mutation must remain absent
      await keys('X', operation === 'stash' ? 'X' : 'pendingX');
      check.ok(!chip(), 'late callback cannot attach to the new composer');
      await erase();
      if (operation === 'stash') { await stash('pending', false); await erase(); }
    }
    await writeFile(path.join(cwd, 'clip-mode'), 'immediate');
  });
  await probe('S4 image-only stash blocks a second clipboard read; conflicting restoration refuses', async () => {
    tui.send(CLIP);
    await settled(chip, 'first image attached');
    await stash('', true);
    check.ok(!chip());
    const starts = await readFile(path.join(cwd, 'clip-starts'), 'utf8');
    const mark = tui.mark();
    tui.send(CLIP);
    await tui.waitFor('one clipboard image is stashed', { from: mark });
    check.equal(await readFile(path.join(cwd, 'clip-starts'), 'utf8'), starts);
    await turn('image stays hidden');
    check.ok(!(await readFile(path.join(cwd, 'model-requests'), 'utf8')).includes(png.toString('base64')));
    await stash('', false);
    await settled(chip, 'same image restored');
    // Stash text while the image is elsewhere, then prove an image-only composer
    // counts as occupied and cannot silently lose the image during restoration.
    tui.send(CLIP);
    await settled(() => !chip(), 'explicitly removed');
    await keys('TEXT_WITH_OTHER_IMAGE', 'TEXT_WITH_OTHER_IMAGE');
    await stash('', true);
    tui.send(CLIP);
    await settled(chip, 'image beside empty text');
    const refused = tui.mark();
    tui.send(STASH);
    await tui.waitFor('draft stash occupied', { from: refused });
    await settled(() => chip() && parked(), 'refusal preserves both image and stash after repaint');
    tui.send(CLIP);
    await settled(() => !chip(), 'remove conflict');
    await stash('TEXT_WITH_OTHER_IMAGE', false);
    await erase();
  });
  await probe('S4 image travels stash/restore/queue/take-back/in-flight with no second slot escape', async () => {
    const mark = tui.mark();
    tui.submit('!sleep 30');
    await tui.waitFor('running ! command', { from: mark });
    tui.send(CLIP);
    await settled(chip, 'image during shell');
    await keys('queued image', 'queued image');
    await stash('', true);
    await stash('queued image', false);
    check.ok(chip());
    tui.send('\r');
    await settled(() => draft() === '' && tui.frame.includes('queued · [image] queued image') && !chip(), 'image queued');
    const queuedMark = tui.mark();
    tui.send(CLIP);
    await tui.waitFor('already queued or sending', { from: queuedMark });
    await keys(UP, 'queued image');
    check.ok(chip());
    tui.send('\u0003');
    await settled(() => !tui.frame.includes('running ! command'), 'shell cancelled');
    // Consume shell report without sending/removing the attachment via a local command.
    await erase();
    await stash('', true); // image-only stash
    await turn('consume shell report');
    await stash('', false);
    const sending = tui.mark();
    tui.submit('hold image');
    await tui.waitFor('working…', { from: sending });
    tui.send(CLIP);
    await tui.waitFor('already queued or sending', { from: sending });
    await keys('INFLIGHT_PRIVATE', 'INFLIGHT_PRIVATE');
    await stash('', true); // text-only while the one image is in-flight
    const inFlightMark = tui.mark();
    tui.send(CLIP);
    await tui.waitFor('already queued or sending', { from: inFlightMark });
    await release('release-image');
    await tui.waitFor('local answer', { from: sending });
    await settled(() => parked() && !chip() && !tui.frame.includes('working…'), 'image sent once');
    await privateDraft('INFLIGHT_PRIVATE');
    const requests = (await readFile(path.join(cwd, 'model-requests'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { content: unknown[] }[]);
    const last = requests.at(-1)?.at(-1);
    check.ok(JSON.stringify(last).includes(png.toString('base64')), 'restored image bytes are exact at model boundary');
    check.equal(last?.content.length, 2, 'one text block and exactly one image');
    for (const file of (await allFiles(home)).filter((file) => file.name.endsWith('trajectory.jsonl'))) {
      check.ok(!file.text.includes(png.toString('base64')), 'trajectory has no image bytes');
    }
    await stash('INFLIGHT_PRIVATE', false);
    await erase();
  });
  await probe('S5 refused clear keeps stash; successful clear drops text/image with notice', async () => {
    await keys('CLEAR_PRIVATE', 'CLEAR_PRIVATE');
    tui.send(CLIP);
    await settled(chip, 'image before clear');
    await stash('', true);
    await local('/clear extra', '/clear takes no arguments');
    check.ok(parked());
    const mark = tui.mark();
    await local('/clear', 'new session');
    await tui.waitFor(DRAFT_STASH_DROP_NOTICE, { from: mark });
    await keys(STASH, '');
    check.ok(!parked() && !chip());
    await privateDraft('CLEAR_PRIVATE');
  });
  await turn('rewind first');
  await turn('rewind second');
  await probe('S5 successful rewind drops stash, returns only selected ordinary prompt unsent', async () => {
    await keys('REWIND_PRIVATE', 'REWIND_PRIVATE');
    tui.send(CLIP);
    await settled(chip, 'rewind image');
    await stash('', true);
    await local('/rewind', 'rewind');
    const mark = tui.mark();
    tui.send('\r');
    await tui.waitFor('rewound conversation into new session', { from: mark });
    await tui.waitFor(DRAFT_STASH_DROP_NOTICE, { from: mark });
    await settled(() => draft() === 'rewind second' && !parked() && !chip(), 'selected prompt only');
    await privateDraft('REWIND_PRIVATE');
    await erase();
  });
  await probe('S5 tangent arm preserves stash; successful return successor drops it', async () => {
    await keys('TANGENT_PRIVATE', 'TANGENT_PRIVATE');
    tui.send(CLIP);
    await settled(chip, 'tangent image');
    await stash('', true);
    await local('/tangent', 'tangent');
    check.ok(parked());
    await turn('tangent first');
    await turn('tangent second');
    const mark = tui.mark();
    await local('/tangent', 'rewound conversation into new session');
    await tui.waitFor(DRAFT_STASH_DROP_NOTICE, { from: mark });
    await keys(STASH, '');
    check.ok(!parked());
    check.ok(!chip());
    await privateDraft('TANGENT_PRIVATE');
  });
  await probe('S5 exit drops stash visibly; no unsent draft in any durable file', async () => {
    await keys('EXIT_PRIVATE', 'EXIT_PRIVATE');
    await stash('', true);
    const mark = tui.mark();
    tui.send('\u0004');
    check.equal(await tui.exitedWithin(30_000), 0);
    check.ok(tui.screen.slice(mark).includes(DRAFT_STASH_DROP_NOTICE));
    await privateDraft('EXIT_PRIVATE');
  });
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
