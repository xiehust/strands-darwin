/** SER-129: real CLI PTY, private HOME, generated local SDK responses, exact ledger.
 * P1 shown Right edits only, Enter provenance; P2 typing/Escape/batched/modified keys;
 * P3 narrow/hidden/resize; P4 stale typing/clear/model/search/editor/image/queue/goal;
 * P5 disabled zero calls, failures suspend, shutdown cancellation. No remote calls.
 */
import { strict as check } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-suggestion-pty-'));
const RIGHT = '\u001b[C';
const ESC = '\u001b';
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
let tui: TuiSession | undefined;
let passed = false;

const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
await mkdir(path.join(home, '.darwin'), { recursive: true });
await mkdir(cwd);
const bin = path.join(root, 'bin'); await mkdir(bin);
const editor = path.join(bin, 'editor');
await writeFile(editor, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(process.argv.at(-1), 'editor result');\n`);
await chmod(editor, 0o755);
const clipboard = path.join(bin, 'wl-paste');
await writeFile(clipboard, `#!${process.execPath}\nprocess.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==','base64'));\n`);
await chmod(clipboard, 0o755);
const config = { models: [
  { name: 'one', provider: 'openai', model: 'fixture.one', enable: true },
  { name: 'two', provider: 'openai', model: 'fixture.two' },
], memory: false, updateCheck: false, preserveRecentMessages: 1 };
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify(config));
async function ledger(): Promise<{ kind: string; text: string; model: string; tools: number; maxTokens: number }[]> {
  try { return (await readFile(path.join(cwd, 'model-calls'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}
const settled = async (fn: () => boolean, label: string) => tui!.waitUntil(fn, { timeoutMs: 15_000, settleMs: 120, label });
const draft = async (text: string) => settled(() => tui!.frame.split('\n').some(line => line.trimEnd() === `you> ${text}`.trimEnd()), `draft ${JSON.stringify(text)}`);
const shown = async (user: string) => settled(() => tui!.frame.includes(`suggest: Explain ${user} further (Right to edit)`), `suggestion ${user}`);
async function ask(user: string): Promise<void> { tui!.submitChunk(user); await shown(user); }
const clearDraft = async () => { tui!.send('\u001b[1;5F' + '\u007f'.repeat(160)); await draft(''); };
try {
  tui = startTui({ cwd, cols: 100, rows: 30, entry: path.join(REPO_ROOT, 'spike/fixtures/prompt-suggestion-cli.ts'), env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true', VISUAL: editor, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'suggestion-test' } });
  await draft(''); check.equal((await ledger()).length, 0);
  await ask('Unicode');
  const before = await ledger();
  check.equal(before.length, 2);
  check.equal(before[1]?.tools, 0); check.equal(before[1]?.maxTokens, 256);
  check.equal(before[1]?.model, 'fixture.one');
  check.deepEqual(JSON.parse(before[1]!.text), { user: 'Unicode', assistant: 'Observed answer about Unicode' });
  const sessions = (await import('node:fs/promises')).readdir;
  const sessionRoot = path.join(home, '.darwin/sessions');
  const project = (await sessions(sessionRoot))[0]!;
  const session = (await sessions(path.join(sessionRoot, project))).find(name => name.startsWith('session-'))!;
  const trajectory = path.join(sessionRoot, project, session, 'trajectory.jsonl');
  const beforeAccept = await readFile(trajectory, 'utf8');
  check.equal(beforeAccept.includes('Explain Unicode further'), false);
  tui.send(RIGHT); await draft('Explain Unicode further');
  check.equal((await ledger()).length, 2); check.equal(await readFile(trajectory, 'utf8'), beforeAccept);
  tui.send('\r'); await shown('Explain Unicode further');
  check.equal((await ledger())[2]?.text, 'Explain Unicode further');
  const records = (await readFile(trajectory, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  check.ok(records.some(record => record.type === 'userInput' && record.text === 'Explain Unicode further'));
  console.log('PASS P1: generated text, visible Right without calls/records, separate Enter with exact provenance');
  tui.send('x' + RIGHT); await draft('x'); await clearDraft();
  check.equal(tui.frame.includes('suggest:'), false);
  await ask('Escape'); tui.send(ESC); await draft(''); tui.send(RIGHT); await draft('');
  await ask('Batch'); tui.send(RIGHT + '\u001b[D' + 'X'); await draft('Explain Batch furtheXr'); await clearDraft();
  await ask('Modified'); tui.send('\u001b[1;5C' + 'X'); await draft('X'); await clearDraft();
  await ask('Nonempty'); tui.send(paste('ab') + '\u001b[D' + RIGHT + 'X'); await draft('abX'); await clearDraft();
  await ask('中文é🙂'); tui.send(RIGHT); await draft('Explain 中文é🙂 further'); await clearDraft();
  console.log('PASS P2: typing/Escape dismissal, single-write Right/edit batches, Unicode, modified/nonempty arrows');
  await ask('Narrow'); tui.resize(24, 14);
  await settled(() => !tui!.frame.includes('suggest:'), 'no prompt grant at tiny size');
  check.ok(tui.frame.split('\n').length <= 14);
  const narrowCalls = (await ledger()).length;
  tui.send(RIGHT); tui.resize(40, 30); await draft('');
  tui.send(RIGHT); await draft(''); check.equal((await ledger()).length, narrowCalls);
  tui.resize(100, 30); await shown('Narrow'); tui.send(ESC); await draft('');
  console.log('PASS P3: narrow frame fits, hidden candidate cannot be accepted, widening redraw');
  tui.submitChunk('slow typing'); await tui.waitFor('Observed answer about slow typing', { settleMs: 120 });
  tui.send('typed' + '\u001b[1;5F' + '\u007f'.repeat(5) + RIGHT); await draft('');
  await writeFile(path.join(cwd, 'release'), 'slow typing');
  await tui.waitFor('cancelled', { settleMs: 120 }); check.equal(tui.frame.includes('suggest:'), false);
  await ask('Search'); tui.send('\u0012'); await settled(() => tui!.frame.includes('search'), 'history owns');
  tui.send(RIGHT); check.equal(tui.frame.includes('suggest:'), false); tui.send(ESC); await draft('');
  await ask('Menu'); tui.send('/'); await tui.waitFor('commands ('); tui.send(RIGHT); check.equal(tui.frame.includes('suggest:'), false); await clearDraft();
  await ask('Rewind'); tui.submitChunk('/rewind'); await tui.waitFor('rewind prompts'); tui.send(RIGHT); check.equal(tui.frame.includes('suggest:'), false); tui.send(ESC); await draft('/rewind'); await clearDraft();
  await ask('Clear'); tui.submitChunk('/clear'); await draft(''); tui.send(RIGHT); await draft('');
  await ask('Switch'); tui.submitChunk('/model two'); await tui.waitFor('fixture.two'); await draft(''); tui.send(RIGHT); await draft('');
  await ask('Newmodel'); check.equal((await ledger()).at(-1)?.model, 'fixture.two'); tui.send(ESC); await draft('');
  tui.submitChunk('queue owner'); await settled(() => tui!.frame.includes('working…'), 'queue owner working'); tui.submitChunk('queued human');
  await tui.waitFor('Observed answer about queued human', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion' && /queue owner|queued human/u.test(call.text)).length, 0);
  tui.submitChunk('/goal condition'); await tui.waitFor('goal'); tui.submitChunk('goal human');
  await tui.waitFor('goal met', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion' && call.text.includes('goal human')).length, 0);
  tui.submitChunk('permission'); await tui.waitFor('allow? y n'); tui.send(RIGHT);
  check.equal(tui.frame.includes('suggest:'), false); tui.send('n'); await tui.waitFor('Observed answer about tool result', { settleMs: 120 });
  tui.send(ESC); await draft('');
  await ask('Editor'); const beforeEditor = (await ledger()).length;
  tui.send('\u0007'); await draft('editor result'); check.equal((await ledger()).length, beforeEditor); await clearDraft();
  await ask('Image'); tui.send('\u000f'); await tui.waitFor('image attached', { settleMs: 120 });
  tui.send(RIGHT); await draft(''); check.equal(tui.frame.includes('suggest:'), false);
  const beforeImage = (await ledger()).filter(call => call.kind === 'suggestion').length;
  tui.submitChunk('image human'); await tui.waitFor('Observed answer about image human', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion').length, beforeImage);
  console.log('PASS P4: stale typing, search/rewind/menu, clear/model, queue/goal/permission, editor/image ownership');
  for (const user of ['reject one', 'reject two', 'reject three']) {
    const mark = tui.mark(); tui.submitChunk(user); await tui.waitFor('unsupported suggestion request', { from: mark, settleMs: 120 }); await draft('');
  }
  await tui.waitFor('prompt suggestions suspended');
  const rejected = (await ledger()).filter(call => call.kind === 'suggestion').length;
  tui.submitChunk('reject four'); await tui.waitFor('Observed answer about reject four', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion').length, rejected);
  tui.submitChunk('/clear'); await draft(''); tui.submitChunk('reject after clear'); await tui.waitFor('Observed answer about reject after clear', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion').length, rejected);
  tui.submitChunk('/model one'); await tui.waitFor('fixture.one'); await draft(''); await ask('Reset');
  check.equal((await ledger()).filter(call => call.kind === 'suggestion').length, rejected + 1);
  tui.send(ESC); await draft('');
  tui.submitChunk('slow exit'); await tui.waitFor('Observed answer about slow exit', { settleMs: 120 });
  tui.send('\u0004'); check.equal(await tui.exitedWithin(10_000), 0);
  console.log('PASS P5: bounded same-cause suspension survives clear, model change resets, pending exit cancels');
  await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ ...config, promptSuggestions: false }));
  const beforeDisabled = (await ledger()).length;
  tui = startTui({ cwd, cols: 100, rows: 30, entry: path.join(REPO_ROOT, 'spike/fixtures/prompt-suggestion-cli.ts'), env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true', VISUAL: editor, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'suggestion-test' } });
  await draft(''); tui.submitChunk('disabled'); await tui.waitFor('Observed answer about disabled', { settleMs: 120 }); await draft('');
  check.equal((await ledger()).length, beforeDisabled + 1); tui.send(RIGHT); await draft('');
  tui.send('\u0004'); check.equal(await tui.exitedWithin(10_000), 0);
  console.log('PASS P6: explicit false performs only the human turn, no auxiliary request or candidate');
  passed = true;
} finally {
  if (tui !== undefined) { await writeFile(path.join(root, 'pty.raw'), tui.raw); tui.kill(); }
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`retained ${root}`);
}
