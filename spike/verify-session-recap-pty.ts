/** SER-130 real CLI PTY, private HOME and local SDK only.
 * Uses the REAL 180000ms production delay once (no production switch/clock override).
 * Optional script scenario `manual` debugs only P3/P4; the registered default runs all.
 * Pure eligibility/boundaries and all ownership flags are in verify-session-recap.ts.
 */
import { strict as check } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-recap-pty-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
await mkdir(path.join(home, '.darwin'), { recursive: true }); await mkdir(cwd);
const config = { models: [{ name: 'one', enable: true, provider: 'openai', model: 'fixture.one' }, { name: 'two', provider: 'openai', model: 'fixture.two' }], memory: false, updateCheck: false, promptSuggestions: false };
const configFile = path.join(home, '.darwin/config.json');
await writeFile(configFile, JSON.stringify(config));
const FOCUS = '\u001b[I', BLUR = '\u001b[O';
let tui: TuiSession | undefined;
let passed = false;
const editor = path.join(root, 'editor');
await writeFile(editor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1), 'editor draft');\n`); await chmod(editor, 0o755);
function launch(): TuiSession {
  return startTui({ cwd, cols: 100, rows: 32, entry: path.join(REPO_ROOT, 'spike/fixtures/session-recap-cli.ts'), env: { HOME: home, VISUAL: editor, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' } });
}
async function ledger(): Promise<{ kind: string; text: string; tools: number; maxTokens: number; model: string }[]> {
  try { return (await readFile(path.join(cwd, 'calls'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}
const ready = async () => tui!.waitUntil(() => tui!.frame.split('\n').some(line => line.trim() === 'you>'), { timeoutMs: 10_000, settleMs: 100 });
const ask = async (text: string) => { const from = tui!.mark(); tui!.submitChunk(text); await tui!.waitFor(`Observed answer ${text}`, { from, timeoutMs: 10_000 }); await ready(); };
async function disk(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await disk(file)); else result[file] = (await readFile(file)).toString('base64');
  }
  return result;
}
const clearDraft = async () => { tui!.send('\u001b[1;5F' + '\u007f'.repeat(160)); await ready(); };
async function manual(): Promise<void> {
  const from = tui!.mark(); tui!.submitChunk('/recap');
  await tui!.waitFor('session recap · manual', { from, timeoutMs: 10_000 }); await ready();
}
async function stop(): Promise<void> { tui!.send('\u0004'); check.equal(await tui!.exitedWithin(5000), 0); tui = undefined; }

try {
  tui = launch(); await ready();
  check.ok(tui.raw.includes('\u001b[?1004h'));
  let from = tui.mark();
  check.ok(process.argv[2] === undefined || process.argv[2] === 'manual', 'unknown spike scenario');
  if (process.argv[2] === 'manual') await ask('manual seed');
  else {
    tui.submitChunk('/recap'); await tui.waitFor('No completed human text exchanges', { from, timeoutMs: 10_000 });
    from = tui.mark(); tui.submitChunk('/recap extra'); await tui.waitFor('Usage: /recap (no arguments)', { from, timeoutMs: 10_000 });
    check.equal((await ledger()).length, 0);
    // Split report, coalesced reports/keys, and literal report-looking text stay distinct.
    tui.send('\u001b['); await delay(5); tui.send('O'); await ready();
    tui.send(FOCUS + 'a' + BLUR + 'b' + FOCUS);
    await tui.waitUntil(() => tui!.frame.includes('you> ab'), { settleMs: 100, timeoutMs: 10_000 }); await clearDraft();
    tui.send('\u001b[200~[I[O\u001b[201~');
    await tui.waitUntil(() => tui!.frame.includes('you> [I[O'), { settleMs: 100, timeoutMs: 10_000 }); await clearDraft();
    await ask('first'); await ask('second');
    tui.send(BLUR); await delay(150); tui.send(FOCUS);
    check.equal((await ledger()).filter(row => row.kind === 'recap').length, 0);
    await ask('third');
    const bytes = await disk(path.join(home, '.darwin/sessions'));
    const configBytes = await readFile(configFile, 'utf8');
    await delay(250); check.equal((await ledger()).filter(row => row.kind === 'recap').length, 0);
    from = tui.mark(); tui.send(BLUR);
    await delay(1000); check.equal((await ledger()).filter(row => row.kind === 'recap').length, 0);
    console.log('PASS P1: default focus lifecycle, split/coalesced keyboard coexistence, empty/grammar and no premature recap; waiting real 3 minutes');
    await tui.waitFor('session recap · automatic', { from, timeoutMs: 185_000 });
    check.equal(tui.screen.includes('Session recap (generated, not verified)'), false);
    const calls = await ledger(), auto = calls.filter(row => row.kind === 'recap');
    check.equal(auto.length, 1); check.equal(auto[0]!.tools, 0); check.equal(auto[0]!.maxTokens, 512); check.equal(auto[0]!.model, 'fixture.one');
    check.equal(JSON.parse(auto[0]!.text).exchanges.length, 3);
    check.deepEqual(await disk(path.join(home, '.darwin/sessions')), bytes); check.equal(await readFile(configFile, 'utf8'), configBytes);
    tui.send(FOCUS); await tui.waitFor('Session recap (generated, not verified): Recapped the observed work.', { from, timeoutMs: 10_000 });
    for (let i = 0; i < 4; i++) tui.send(BLUR + FOCUS);
    await delay(150); check.equal((await ledger()).filter(row => row.kind === 'recap').length, 1);
    check.deepEqual(await disk(path.join(home, '.darwin/sessions')), bytes);
    console.log('PASS P2: real production threshold, prepare while away, return-only publication/dedup, unchanged complete session/config bytes');
  }

  await manual();
  from = tui.mark(); tui.submitChunk('busy'); await tui.waitFor('working…', { from, timeoutMs: 5000 });
  tui.submitChunk('/recap'); await tui.waitFor('/recap does not queue', { from, timeoutMs: 10_000 });
  await tui.waitFor('Observed answer busy', { from, timeoutMs: 10_000 }); await ready();
  const beforeSlow = (await ledger()).filter(row => row.kind === 'recap').length;
  await writeFile(path.join(cwd, 'slow'), 'yes');
  from = tui.mark(); tui.submitChunk('/recap'); await tui.waitFor('Preparing manual session recap', { from, timeoutMs: 10_000 });
  await delay(100); tui.send('draft' + BLUR + FOCUS);
  await tui.waitUntil(() => tui!.frame.includes('you> draft'), { settleMs: 120, timeoutMs: 10_000 });
  await tui.waitFor('cancelled/stale', { from, timeoutMs: 10_000 });
  check.equal((await ledger()).filter(row => row.kind === 'recap').length, beforeSlow + 1);
  check.equal(tui.screen.slice(from).includes('Session recap (generated, not verified)'), false);
  await clearDraft();
  from = tui.mark(); tui.submitChunk('/recap'); await tui.waitFor('Preparing manual session recap', { from, timeoutMs: 10_000 }); await delay(100);
  tui.send('\u0012'); await tui.waitFor('reverse search:', { from, timeoutMs: 5000 }); await tui.waitFor('cancelled/stale', { from, timeoutMs: 10_000 }); tui.send('\u001b'); await ready();
  from = tui.mark(); tui.submitChunk('/recap'); await tui.waitFor('Preparing manual session recap', { from, timeoutMs: 10_000 }); await delay(100);
  tui.send('\u0007'); await tui.waitUntil(() => tui!.frame.includes('you> editor draft'), { settleMs: 150, timeoutMs: 10_000 });
  check.ok(tui.raw.includes('\u001b[?1004l')); await clearDraft();
  await writeFile(path.join(cwd, 'slow'), 'no');
  await ask('unicode'); from = tui.mark(); tui.submitChunk('/recap'); await tui.waitFor('Output truncated at 400 Unicode code points.', { from, timeoutMs: 10_000 });
  tui.resize(24, 14); await delay(150); check.ok(tui.frame.split('\n').length <= 14);
  tui.resize(100, 32); await ready();
  const raw = tui; await stop(); check.ok(raw.raw.includes('\u001b[?1004l'));
  console.log('PASS P3: manual separate call, busy refusal, typing/search/editor cancellation, Unicode truncation notice, resize and cleanup');

  await writeFile(configFile, JSON.stringify({ ...config, sessionRecap: false, promptSuggestions: true }));
  const beforeOff = (await ledger()).filter(row => row.kind === 'recap').length;
  tui = launch(); await ready(); check.equal(tui.raw.includes('\u001b[?1004h'), false);
  from = tui.mark(); tui.submitChunk('off manual');
  await tui.waitFor('Observed answer off manual', { from, timeoutMs: 10_000 });
  await tui.waitUntil(() => tui!.frame.includes('suggest: Explain this further (Right to edit)'), { from, settleMs: 150, timeoutMs: 10_000 });
  tui.send('\u001b[C'); await tui.waitUntil(() => tui!.frame.includes('you> Explain this further'), { settleMs: 100, timeoutMs: 10_000 });
  check.equal((await ledger()).filter(row => row.kind === 'recap').length, beforeOff);
  await clearDraft(); await manual();
  check.equal((await ledger()).filter(row => row.kind === 'recap').length, beforeOff + 1);
  check.equal(tui.raw.includes('\u001b[?1004h'), false);
  await stop();
  console.log('PASS P4: automatic off has no focus tracking or calls; suggestions independently on and Right unchanged; explicit manual recap still works');

  passed = true;
} finally {
  if (!passed && tui) await writeFile(path.join(root, 'terminal.raw'), tui.raw);
  tui?.kill();
  if (passed) await rm(root, { recursive: true, force: true }); else console.error(`recap PTY artifacts: ${root}`);
}
