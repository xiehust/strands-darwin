/** Offline real-runtime/pty recovery: private source copy, guide root removed after scan.
 * Run: pnpm tsx spike/verify-setup-recovery.ts [immediate-text|immediate-image|queued-text|queued-image]
 * Four cases: immediate/queued × text/image; no cloud, provider, or real config access.
 */
import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownPrivateHome } from './shared.js';
import { startTui } from './tui-driver.js';

const home = ownPrivateHome('setup-recovery');
const repo = path.resolve(import.meta.dirname, '..');
const copy = path.join(home, 'copy');
await mkdir(copy);
await cp(path.join(repo, 'src'), path.join(copy, 'src'), { recursive: true });
await mkdir(path.join(copy, 'spike'));
for (const file of ['setup-recovery-tui-fixture.ts', 'offline-model.ts']) await cp(path.join(repo, 'spike', file), path.join(copy, 'spike', file));
await writeFile(path.join(copy, 'package.json'), '{"type":"module","version":"0.0.0"}');
await symlink(path.join(repo, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
await mkdir(path.join(home, '.darwin'));
const config = JSON.stringify({ provider: 'bedrock', model: 'fake.recovery', region: 'us-west-2', promptCache: false, contextOffload: false, memory: false });
await writeFile(path.join(home, '.darwin/config.json'), config);
const skillRoot = path.join(copy, 'src/skills/builtin/setup-agentcore-memory');
const hiddenRoot = `${skillRoot}-unavailable`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64');
const imageHash = createHash('sha256').update(png).digest('hex');
const exists = (file: string) => access(file).then(() => true, () => false);
async function waitFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await exists(file)) {
    if (Date.now() > deadline) throw new Error(`fixture barrier missing: ${file}`);
    await delay(20);
  }
}

for (const queued of [false, true]) for (const withImage of [false, true]) {
  const label = `${queued ? 'queued' : 'immediate'}-${withImage ? 'image' : 'text'}`;
  if (process.argv[2] !== undefined && process.argv[2] !== label) continue;
  const root = path.join(home, label);
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(root, 'clipboard.png'), png);
  await writeFile(path.join(bin, 'wl-paste'), `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(process.env.CLIPBOARD_FIXTURE));\n`);
  await chmod(path.join(bin, 'wl-paste'), 0o755);
  const tui = startTui({ cwd: root, entry: path.join(copy, 'spike/setup-recovery-tui-fixture.ts'), cols: 140, rows: 45,
    env: { PATH: `${bin}:${process.env.PATH}`, WAYLAND_DISPLAY: 'fixture', CLIPBOARD_FIXTURE: path.join(root, 'clipboard.png') } });
  let missing = false;
  try {
    await tui.waitFor('you>', { timeoutMs: 30_000, settleMs: 200 });
    await waitFile(path.join(root, 'runtime-ready.json'));
    const { trajectoryFile } = JSON.parse(await readFile(path.join(root, 'runtime-ready.json'), 'utf8'));
    const submitted = '/setup-agentcore-memory chosen-settings';
    const before = tui.mark();
    if (queued) {
      tui.submit('hold original turn');
      await tui.waitFor('working…', { from: before, timeoutMs: 10_000, settleMs: 200 });
      await waitFile(path.join(root, 'model-request.json'));
    } else {
      tui.submit('!printf retained-shell-report');
      await tui.waitFor('retained-shell-report', { from: before, timeoutMs: 10_000, settleMs: 200 });
      await tui.waitUntil(() => !tui.frame.includes('running ! command…'), { timeoutMs: 10_000, settleMs: 200 });
    }
    if (withImage) {
      const attachedAt = tui.mark();
      tui.send('\u000f');
      await tui.waitFor('image attached · PNG', { from: attachedAt, timeoutMs: 10_000, settleMs: 200 });
    }
    tui.submit(submitted);
    if (queued) {
      await tui.waitFor(`queued · ${withImage ? '[image] ' : ''}${submitted}`, { timeoutMs: 10_000, settleMs: 200 });
      tui.submit('later user entry');
      await tui.waitFor('queued · later user entry', { timeoutMs: 10_000, settleMs: 200 });
      tui.submit('!touch later-ran');
      await tui.waitFor('queued · !touch later-ran', { timeoutMs: 10_000, settleMs: 200 });
      tui.send('draft-before-drain');
      await tui.waitFor('you> draft-before-drain', { timeoutMs: 10_000, settleMs: 200 });
      await rename(skillRoot, hiddenRoot); missing = true;
      await writeFile(path.join(root, 'release-model'), 'release');
    }
    await waitFile(path.join(root, 'activation-ready'));
    if (!queued) { await rename(skillRoot, hiddenRoot); missing = true; }
    const newer = queued ? 'draft-before-drain-newer' : 'newer-draft';
    tui.send(queued ? '-newer' : newer);
    await tui.waitFor(`you> ${newer}`, { timeoutMs: 10_000, settleMs: 200 });
    if (withImage) {
      const attemptedAt = tui.mark();
      tui.send('\u000f');
      await tui.waitFor('one clipboard image is already queued or sending', { from: attemptedAt, timeoutMs: 10_000, settleMs: 200 });
    }
    const failureAt = tui.mark();
    await writeFile(path.join(root, 'release-activation'), 'release');
    await tui.waitFor('prompt not sent — restored to the editor', { from: failureAt, timeoutMs: 10_000, settleMs: 400 });
    const expected = [submitted, ...(queued ? ['later user entry', '!touch later-ran'] : []), newer];
    const draft = tui.frame.slice(tui.frame.lastIndexOf('you>'));
    const drawn = [...draft.matchAll(/(?:you>|\.\.\.>) ([^\r\n]*)/g)].map(match => match[1]);
    assert.deepEqual(drawn, expected, `${label}: every failed/queued/newer literal remains editable in order`);
    assert(!tui.frame.includes('queued · '), `${label}: no later user entry remains to drain`);
    assert.equal(tui.frame.includes('image attached · PNG'), withImage, `${label}: image returned to composer`);
    assert(!await exists(path.join(root, 'later-ran')), 'later shell command never ran');
    const requestFile = path.join(root, 'model-request.json');
    assert.equal(await exists(requestFile), queued, `${label}: no extra model request`);
    if (queued) assert.equal(JSON.parse(await readFile(requestFile, 'utf8')).calls, 1);
    const records = async () => (await readFile(trajectoryFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual((await records()).filter(record => record.type === 'userInput').map(record => record.text), queued ? ['hold original turn'] : []);

    // Repair the private bundle, delete only the returned trailing entries through
    // ordinary editor keys, and retry the preserved literal setup prompt.
    await rename(hiddenRoot, skillRoot); missing = false;
    const extra = expected.slice(1).map(line => `\n${line}`).join('');
    tui.send('\u007f'.repeat(extra.length));
    await tui.waitUntil(() => tui.frame.includes(`you> ${submitted}`) && !tui.frame.slice(tui.frame.lastIndexOf('you>')).includes('...>'), { timeoutMs: 10_000, settleMs: 200 });
    // One branch proves explicit removal after recovery; the other proves exact
    // image bytes survive recovery and reach the repaired ordinary invocation.
    const removeImage = withImage && !queued;
    if (removeImage) {
      const removedAt = tui.mark();
      tui.send('\u000f');
      await tui.waitFor('clipboard image removed from the next prompt', { from: removedAt, timeoutMs: 10_000, settleMs: 200 });
    }
    const retryAt = tui.mark();
    tui.send('\r');
    await tui.waitFor('Offline answer; setup is pending user confirmation.', { from: retryAt, timeoutMs: 10_000, settleMs: 400 });
    const retry = JSON.parse(await readFile(requestFile, 'utf8'));
    assert.equal(retry.calls, queued ? 2 : 1);
    assert(retry.text.includes('# Set up AgentCore Memory') && retry.text.endsWith('chosen-settings'));
    if (!queued) assert(retry.text.includes('retained-shell-report'), 'activation failure preserved held shell reports');
    assert.equal(retry.imageHash, withImage && !removeImage ? imageHash : undefined);
    assert(!tui.frame.includes('image attached · PNG'), 'successful retry consumes image');
    tui.submit('/exit');
    assert.equal(await tui.exitedWithin(10_000), 0);
    const finalRecords = await records();
    assert.deepEqual(finalRecords.filter(record => record.type === 'userInput').map(record => record.text), [...(queued ? ['hold original turn'] : []), submitted]);
    const bytes = await readFile(trajectoryFile, 'utf8');
    assert(!bytes.includes(png.toString('base64')) && !bytes.includes(imageHash), 'trajectory contains neither image bytes nor synthetic image evidence');
    assert(!await exists(path.join(root, 'later-ran')));
    assert.equal(await readFile(path.join(home, '.darwin/config.json'), 'utf8'), config);
    console.log(`PASS ${label}: recovery, no drain/record, repair and retry`);
  } finally {
    tui.kill();
    await tui.exitedWithin(10_000);
    if (missing) await rename(hiddenRoot, skillRoot);
  }
}

console.log(`setup recovery: ${process.argv[2] ?? 'all 4 runtime/pty cases'} passed`);
