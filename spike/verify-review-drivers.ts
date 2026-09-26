/** SER-087 offline driver acceptance (real runtime/SDK, not source assertions).
 * R6 TUI busy queue: no request/record until drain, commit + bare + focused expansion;
 * malformed scopes stay local and retain the draft.
 * R7 clipboard PNG follows the queued review once; literal trajectory excludes it.
 * R8 dev-repl sends the same expansion and records literal input.
 * Isolated HOME, local capture model, bounded pty waits. No external provider.
 * Run: pnpm tsx spike/verify-review-drivers.ts
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReviewCommand, REVIEW_COMMIT_USAGE } from '../src/commands/review-command.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const home = ownPrivateHome('review-drivers');
const entry = path.join(REPO_ROOT, 'spike/fixtures/review-cli.ts');
const env = { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64');
const focus = 'auth 路径 $ARGUMENTS $1 @file $(touch executed) !`touch executed`';
const literal = `/ReViEw ${focus}`;
const sha = 'ABCDEF0123456789abcdef0123456789abcdef01';
const commit = `/ReViEw --commit ${sha}`;
const invalid = '/review --commit deadbeef';

async function files(dir: string): Promise<string[]> {
  const all: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) all.push(...await files(file));
    else all.push(file);
  }
  return all;
}
async function records(): Promise<Array<{ type: string; text?: string }>> {
  const trajectories = (await files(home)).filter(file => file.endsWith('trajectory.jsonl'));
  return (await Promise.all(trajectories.map(file => readFile(file, 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
async function requests(cwd: string): Promise<Array<{ role: string; content: Array<Record<string, any>> }>> {
  const file = path.join(cwd, 'review-requests');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const config = JSON.stringify({ provider: 'bedrock', model: 'fake.offline-capture', region: 'us-west-2',
  promptCache: false, contextOffload: false, memory: false, trajectory: true, permissionMode: 'default' });
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(path.join(home, '.darwin/config.json'), config);
const cwd = path.join(home, 'tui-project');
const bin = path.join(home, 'bin');
await mkdir(cwd);
await mkdir(bin);
await writeFile(path.join(cwd, 'clipboard.png'), png);
await writeFile(path.join(bin, 'wl-paste'), `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync('clipboard.png'));\n`);
await chmod(path.join(bin, 'wl-paste'), 0o755);
async function tuiReview(): Promise<void> {
  header('review R6–R7 — real TUI queue, attachment and literal trajectory');
  const tui = startTui({ cwd, entry, cols: 120, rows: 40,
    env: { ...env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'review-test' } });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
    const held = tui.mark();
    tui.submit('hold review queue');
    await tui.waitFor('working…', { from: held, settleMs: 200 });
    tui.send('\u000f');
    await tui.waitFor('image attached · PNG', { from: held, settleMs: 200 });
    const refused = tui.mark();
    tui.submit(invalid);
    await tui.waitFor(REVIEW_COMMIT_USAGE, { from: refused, settleMs: 200 });
    assert('invalid busy scope keeps the draft/image, sends nothing and never queues',
      tui.frame.includes(invalid) && tui.frame.includes('image attached · PNG') &&
      !tui.frame.includes('queued ·') && (await requests(cwd)).length === 1);
    tui.send('\u0015'); // Clear the retained malformed draft; the image remains owned by the composer.
    const queued = tui.mark();
    tui.submit(commit);
    await tui.waitUntil(() => tui.frame.includes('queued ·') && tui.frame.includes('--commit'), {
      from: queued, settleMs: 200, label: 'review with image queued behind held model',
    });
    assert('busy review has not reached the model', (await requests(cwd)).length === 1);
    check.deepEqual((await records()).filter(record => record.type === 'userInput').map(record => record.text), ['hold review queue']);
    assert('enqueue records nothing and keeps the permission mode', tui.frame.includes('mode: default'));
    await writeFile(path.join(cwd, 'release-review'), 'release');
    await tui.waitFor('reviewing commit with /review', { from: queued });
    await tui.waitUntil(() => !tui.frame.includes('working…') && !tui.frame.includes('queued ·') &&
      tui.screen.slice(queued).includes('REVIEW_LOCAL_REPLY'), { settleMs: 300, label: 'queued review finished' });
    const calls = await requests(cwd);
    check.equal(calls.length, 2);
    const received = calls[1]!;
    check.equal(received.role, 'user');
    check.equal(received.content.length, 2);
    check.equal(received.content[0]?.['text'], parseReviewCommand(commit)!.message);
    const image = received.content[1]?.['image'];
    check(image);
    check.equal(image.format, 'png');
    check.deepEqual(Buffer.from(image.source.bytes, 'base64'), png);
    assert('one drained SDK user request contains expanded review and exact PNG', true);
    assert('queued image is consumed, not left in the composer', !tui.frame.includes('image attached · PNG'));

    const bare = tui.mark();
    tui.submit('/review ');
    await tui.waitFor('reviewing current changes with /review', { from: bare });
    await tui.waitUntil(() => !tui.frame.includes('working…') && tui.screen.slice(bare).includes('REVIEW_LOCAL_REPLY'), {
      settleMs: 300, label: 'bare review completed',
    });
    const last = (await requests(cwd)).at(-1)!;
    check.equal(last.content.length, 1);
    check.equal(last.content[0]?.['text'], parseReviewCommand('/review')!.message);
    assert('bare TUI review expands normally without reusing the image', (await requests(cwd)).length === 3);
    const malformed = tui.mark();
    tui.submit(invalid);
    await tui.waitFor(REVIEW_COMMIT_USAGE, { from: malformed, settleMs: 200 });
    assert('malformed TUI command retains draft, sends nothing and leaves no queue',
      tui.frame.includes(invalid) && !tui.frame.includes('queued ·') && (await requests(cwd)).length === 3);
    tui.send('\u0015'); // Ctrl+U clears the retained draft before the next prompt.
    const focused = tui.mark();
    tui.submit(literal);
    await tui.waitFor('reviewing current changes with /review', { from: focused });
    await tui.waitUntil(() => !tui.frame.includes('working…') && tui.screen.slice(focused).includes('REVIEW_LOCAL_REPLY'), {
      settleMs: 300, label: 'focused review completed',
    });
    check.equal((await requests(cwd)).at(-1)?.content[0]?.['text'], parseReviewCommand(literal)!.message);
    assert('TUI review did not execute shell-looking focus', !existsSync(path.join(cwd, 'executed')));
    tui.submit('/exit');
    check.equal(await tui.exitedWithin(10_000), 0);
  } finally { tui.kill(); }
  const trace = await records();
  check.deepEqual(trace.filter(record => record.type === 'userInput').map(record => record.text),
    ['hold review queue', commit, '/review', literal]);
  assert('TUI trajectory retains only literal submitted input, no tools or image bytes',
    !trace.some(record => record.type === 'beforeToolCallEvent') && !JSON.stringify(trace).includes(png.toString('base64')) &&
    !JSON.stringify(trace).includes('Review the current repository changes.'));
}
async function replReview(): Promise<void> {
  header('review R8 — actual dev-repl with offline SDK capture');
  const cwd = path.join(home, 'repl-project');
  await mkdir(cwd);
  const repl = startTui({ cwd, entry, env: { ...env, REVIEW_DRIVER: 'repl' } });
  try {
    await repl.waitFor('you>', { timeoutMs: 60_000 });
    repl.submit(invalid);
    await repl.waitFor(REVIEW_COMMIT_USAGE, { settleMs: 200 });
    assert('invalid REPL command makes no SDK request', (await requests(cwd)).length === 0);
    for (const input of ['/review', literal, commit]) {
      const before = repl.mark();
      repl.submit(input);
      await repl.waitFor(input === commit ? 'reviewing commit with /review' : 'reviewing current changes with /review',
        { from: before });
      await repl.waitFor('you>', { from: before, settleMs: 200 });
      assert('dev-repl completes the ordinary review turn', repl.screen.slice(before).includes('REVIEW_LOCAL_REPLY'));
      const received = (await requests(cwd)).at(-1)!;
      check.equal(received.content.length, 1);
      check.equal(received.content[0]?.['text'], parseReviewCommand(input)!.message);
    }
    assert('dev-repl sends one SDK request per valid input', (await requests(cwd)).length === 3);
    repl.submit('/exit');
    check.equal(await repl.exitedWithin(10_000), 0);
  } finally { repl.kill(); }
  const inputs = (await records()).filter(record => record.type === 'userInput').map(record => record.text);
  assert('dev-repl also records only its literal inputs', inputs.filter(text => text === literal).length === 2 &&
    inputs.filter(text => text === '/review').length === 2 &&
    inputs.filter(text => text === commit).length === 2 && inputs.length === 7 && !inputs.includes(invalid));
  assert('dev-repl focus is never shell-interpolated', !existsSync(path.join(cwd, 'executed')));
}
await tuiReview();
await replReview();
assert('all drivers leave isolated configuration unchanged', await readFile(path.join(home, '.darwin/config.json'), 'utf8') === config);
report();
