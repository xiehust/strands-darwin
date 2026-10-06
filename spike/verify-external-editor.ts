/**
 * SER-113 external-editor process suite (in `pnpm test`): real child processes, real
 * files, no shell, no model, no network. Run: pnpm tsx spike/verify-external-editor.ts
 *
 * Requirement -> check in this file:
 * P1 VISUAL over EDITOR; blank falls through; unset is guidance; set-but-invalid refuses -> "resolution".
 * P2 bounded argv: quoted paths with spaces, escapes, ordinary flags -> "parsing" + "quoted argv launch".
 * P3 shell operators/substitutions refused and never executed (marker absent) -> "no shell".
 * P4 sanitized env carries DARWIN=1, withholds credential names; cwd is the session cwd -> "environment".
 * P5 absent / nonzero / signalled editor -> failed, never changed -> "failures".
 * P6 private 0700 directory + 0600 regular file outside the project; inside refused -> "storage".
 * P7 input/output caps (65,536 code points, 256 KiB), refusal not truncation -> "caps".
 * P8 symlink / FIFO / malformed UTF-8 rejected; read bounded while the file grows -> "validation".
 * P9 multiline Unicode round trip; only normalizeDraftText applied -> "round trip".
 * P10 unchanged content detected -> "round trip".
 * P11 temporary storage removed on every path above -> asserted after each run.
 * P12 kill(): editor reaped, storage removed synchronously; SIGINT ignored while open -> "shutdown".
 * P13 Ctrl+G eligibility: repeated chord ignored, busy/queued/peer/goal/delegation refused -> "eligibility".
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EDITOR_COMMAND_MAX_ARGS,
  EDITOR_TEMP_PREFIX,
  EXTERNAL_EDITOR_MAX_BYTES,
  EXTERNAL_EDITOR_MAX_CODE_POINTS,
  TERMINAL_SIGNAL_GRACE_MS,
  externalEditorRefusal,
  parseEditorCommand,
  resolveEditorCommand,
  runExternalEditor,
  type ExternalEditorOutcome,
} from '../src/tui/external-editor.js';
import { normalizeDraftText } from '../src/tui/prompt-editor.js';
import { scrubShellEnv, withDarwinMarker } from '../src/tools/shell-env.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-ext-editor-'));
const tempRoot = path.join(root, 'tmp');
const project = path.join(root, 'project');
const bin = path.join(root, 'editor bin');
const log = path.join(root, 'editor-log.jsonl');
await mkdir(tempRoot, { mode: 0o700 });
await mkdir(project);
await mkdir(bin);

// The fixture editor: records what it was given, then acts on FIXTURE_MODE.
const editor = path.join(bin, 'fixture editor');
await writeFile(editor, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[process.argv.length - 1];
const mode = process.env.FIXTURE_MODE || 'none';
const text = process.env.FIXTURE_TEXT || '';
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
  darwin: process.env.DARWIN ?? null, secret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
  dirMode: fs.statSync(path.dirname(file)).mode & 0o777, fileMode: fs.statSync(file).mode & 0o777,
  regular: fs.lstatSync(file).isFile(), content: fs.readFileSync(file, 'utf8'),
}) + '\\n');
if (mode === 'append') fs.appendFileSync(file, text);
else if (mode === 'write') fs.writeFileSync(file, text);
else if (mode === 'fail') process.exit(7);
else if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
else if (mode === 'symlink') { const other = path.join(path.dirname(file), 'other'); fs.writeFileSync(other, 'via symlink'); fs.rmSync(file); fs.symlinkSync(other, file); }
else if (mode === 'fifo') { fs.rmSync(file); require('node:child_process').execFileSync('mkfifo', [file]); }
else if (mode === 'remove') fs.rmSync(file);
else if (mode === 'bytes') fs.writeFileSync(file, Buffer.from(text, 'hex'));
else if (mode === 'repeat') fs.writeFileSync(file, text.repeat(Number(process.env.FIXTURE_COUNT)));
else if (mode === 'grow') {
  fs.writeFileSync(file, 'x'.repeat(${EXTERNAL_EDITOR_MAX_BYTES} + 4096));
  const grower = require('node:child_process').spawn(process.execPath, ['-e', \`
    const fs = require('node:fs'); const end = Date.now() + 3000;
    const chunk = 'y'.repeat(65536);
    const tick = () => { try { fs.appendFileSync(process.argv[1], chunk); } catch { return; } if (Date.now() < end) setTimeout(tick, 2); };
    tick();\`, file], { detached: true, stdio: 'ignore' });
  grower.unref();
}
else if (mode === 'wait') { setInterval(() => {}, 1000); return; }
`);
await chmod(editor, 0o755);

const baseEnv = withDarwinMarker(scrubShellEnv({ ...process.env, AWS_SECRET_ACCESS_KEY: 'withheld-value' }, []).env);
interface Recorded {
  argv: string[]; cwd: string; pid: number; darwin: string | null; secret: string | null;
  dirMode: number; fileMode: number; regular: boolean; content: string;
}
async function records(): Promise<Recorded[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded);
}
async function leftovers(): Promise<string[]> {
  return (await readdir(tempRoot)).filter((name) => name.startsWith(EDITOR_TEMP_PREFIX));
}

async function edit(
  text: string,
  mode: string,
  extra: Record<string, string> = {},
  argv: readonly string[] = [editor],
): Promise<{ outcome: ExternalEditorOutcome; record: Recorded | undefined; clean: boolean }> {
  await rm(log, { force: true });
  const run = runExternalEditor(text, {
    argv, cwd: project, env: { ...baseEnv, FIXTURE_MODE: mode, FIXTURE_LOG: log, ...extra },
    normalize: normalizeDraftText, tempRoot, projectRoot: project,
  });
  const outcome = await run.done;
  return { outcome, record: (await records())[0], clean: (await leftovers()).length === 0 };
}

header('P1 resolution — VISUAL first, then EDITOR; nothing guessed');
{
  assert('unset environment is guidance, not a guessed editor', resolveEditorCommand({}).kind === 'unset');
  assert('blank values count as unset', resolveEditorCommand({ VISUAL: '  ', EDITOR: '\t' }).kind === 'unset');
  const both = resolveEditorCommand({ VISUAL: 'visual-ed', EDITOR: 'editor-ed' });
  assert('VISUAL wins over EDITOR', both.kind === 'command' && both.source === 'VISUAL' && both.argv[0] === 'visual-ed');
  const fallback = resolveEditorCommand({ VISUAL: '', EDITOR: 'editor-ed -x' });
  assert('EDITOR is the fallback when VISUAL is blank',
    fallback.kind === 'command' && fallback.source === 'EDITOR' && fallback.argv.join('|') === 'editor-ed|-x');
  const invalid = resolveEditorCommand({ VISUAL: 'vim; true', EDITOR: 'nano' });
  assert('a set but invalid VISUAL refuses instead of silently using EDITOR',
    invalid.kind === 'refused' && invalid.source === 'VISUAL');
}

header('P2 parsing — bounded argv without a shell');
{
  const cases: Array<[string, string[]]> = [
    ['code --wait', ['code', '--wait']],
    ['"/opt/My Editor/bin/ed" -n +1', ['/opt/My Editor/bin/ed', '-n', '+1']],
    ["'/a b/c' --flag=value", ['/a b/c', '--flag=value']],
    ['my\\ editor', ['my editor']],
    ['"say \\"hi\\"" \'lit$eral\'', ['say "hi"', 'lit$eral']],
    ['  spaced   words\t', ['spaced', 'words']],
    ['emacsclient -c -a ""', ['emacsclient', '-c', '-a', '']],
  ];
  for (const [value, expected] of cases) {
    const parsed = parseEditorCommand(value);
    assert(`parses ${JSON.stringify(value)}`, parsed.ok && JSON.stringify(parsed.argv) === JSON.stringify(expected));
  }
  const refused = ['"unterminated', 'trailing\\', '', 'a\nb', 'x'.repeat(1025),
    Array.from({ length: EDITOR_COMMAND_MAX_ARGS + 1 }, () => 'w').join(' ')];
  for (const value of refused) {
    assert(`refuses ${JSON.stringify(value.slice(0, 24))}${value.length > 24 ? '…' : ''}`, !parseEditorCommand(value).ok);
  }
  const reason = parseEditorCommand('vim | cat');
  assert('a refusal reason never echoes the value', !reason.ok && !reason.reason.includes('vim'));
}

header('P3 no shell — operators and substitutions refused, never executed');
{
  const marker = path.join(root, 'shell-ran');
  const hostile = [
    `touch ${marker}; vim`, `vim && touch ${marker}`, `vim | tee ${marker}`, `vim > ${marker}`,
    `$(touch ${marker})`, `\`touch ${marker}\``, `"$(touch ${marker})"`, `vim $HOME`, `~/bin/vim`, 'vim *', `vim & touch ${marker}`,
  ];
  for (const value of hostile) {
    const resolved = resolveEditorCommand({ VISUAL: value });
    assert(`refused: ${value.replace(root, '<root>')}`, resolved.kind === 'refused');
  }
  // Quoted metacharacters are literal arguments handed to the editor, not syntax.
  const quoted = parseEditorCommand(`'${editor}' ';touch ${marker}' "\\$(touch ${marker})"`);
  assert('quoted metacharacters parse as literal words', quoted.ok && quoted.argv.length === 3);
  if (quoted.ok) {
    const { outcome, record, clean } = await edit('draft', 'none', {}, quoted.argv);
    assert('the editor received them verbatim', record?.argv[0] === `;touch ${marker}` && record.argv[1] === `$(touch ${marker})`);
    assert('nothing was executed by a shell (marker absent)', !existsSync(marker) && outcome.kind === 'unchanged' && clean);
  }
}

header('P4 environment and cwd — darwin child env, session cwd');
{
  const { record, outcome, clean } = await edit('env check', 'none');
  assert('the editor sees DARWIN=1', record?.darwin === '1');
  assert('credential-shaped variables are withheld', record?.secret === null);
  assert('cwd is the session cwd', record?.cwd === project);
  assert('the temp file is the last argument', record?.argv.at(-1)?.endsWith(`${path.sep}prompt.md`) === true);
  assert('unchanged + cleaned', outcome.kind === 'unchanged' && clean);
}

header('P5 failures — absent, nonzero, signalled: never a changed draft');
{
  const absent = await edit('keep me', 'none', {}, [path.join(root, 'no-such-editor')]);
  assert('missing executable is a launch failure', absent.outcome.kind === 'failed' && /could not start/.test(absent.outcome.reason));
  assert('missing executable leaves no storage', absent.clean);
  const failed = await edit('keep me', 'fail');
  assert('nonzero exit fails with its code', failed.outcome.kind === 'failed' && failed.outcome.reason.includes('code 7'));
  assert('nonzero exit leaves no storage', failed.clean);
  const signalled = await edit('keep me', 'signal');
  assert('signal exit fails with the signal', signalled.outcome.kind === 'failed' && signalled.outcome.reason.includes('SIGTERM'));
  assert('signal exit leaves no storage', signalled.clean);
  const written = await edit('keep me', 'append', { FIXTURE_TEXT: ' but then failed' }, [editor]);
  assert('control: a clean exit after writing is changed', written.outcome.kind === 'changed');
}

header('P6 storage — private 0700 directory, 0600 regular file, outside the project');
{
  const { record, clean } = await edit('modes', 'none');
  assert('directory mode is 0700', record?.dirMode === 0o700);
  assert('file mode is 0600 and regular', record?.fileMode === 0o600 && record.regular);
  assert('storage lives under the temp root, not the project',
    record !== undefined && record.argv.at(-1)?.startsWith(tempRoot + path.sep) === true && !record.argv.at(-1)?.startsWith(project));
  assert('cleaned', clean);
  const insideRoot = path.join(project, 'tmp');
  await mkdir(insideRoot);
  await rm(log, { force: true });
  const inside = await runExternalEditor('x', {
    argv: [editor], cwd: project, env: { ...baseEnv, FIXTURE_LOG: log }, normalize: normalizeDraftText,
    tempRoot: insideRoot, projectRoot: project,
  }).done;
  assert('a temp root inside the project is refused before launch', inside.kind === 'refused' && (await records()).length === 0);
  assert('and its directory is removed', (await readdir(insideRoot)).length === 0);
}

header('P7 caps — refusal, never truncation');
{
  const over = 'a'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS + 1);
  const refused = await edit(over, 'none');
  assert('over-cap draft is refused and the editor never launched', refused.outcome.kind === 'refused' && refused.record === undefined);
  assert('over-cap draft created no storage', refused.clean);
  const boundary = '🧪'.repeat(EXTERNAL_EDITOR_MAX_CODE_POINTS);
  const accepted = await edit(boundary, 'none');
  assert('exactly 65,536 code points / 262,144 bytes is accepted and round-trips',
    accepted.outcome.kind === 'unchanged' && accepted.record?.content === boundary && accepted.clean);
  const bigBytes = await edit('x', 'repeat', { FIXTURE_TEXT: 'b', FIXTURE_COUNT: String(EXTERNAL_EDITOR_MAX_BYTES + 1) });
  assert('output over 256 KiB fails', bigBytes.outcome.kind === 'failed' && /exceeds/.test(bigBytes.outcome.reason) && bigBytes.clean);
  const bigPoints = await edit('x', 'repeat', { FIXTURE_TEXT: 'p', FIXTURE_COUNT: String(EXTERNAL_EDITOR_MAX_CODE_POINTS + 1) });
  assert('output over 65,536 code points fails', bigPoints.outcome.kind === 'failed' && /exceeds/.test(bigPoints.outcome.reason) && bigPoints.clean);
}

header('P8 validation — symlink, non-regular, malformed UTF-8, growing file');
{
  const symlink = await edit('x', 'symlink');
  assert('a symlinked result is rejected', symlink.outcome.kind === 'failed' && /symlink/.test(symlink.outcome.reason) && symlink.clean);
  const hasMkfifo = spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0;
  if (hasMkfifo) {
    const started = Date.now();
    const fifo = await edit('x', 'fifo');
    assert('a FIFO result is rejected without blocking', fifo.outcome.kind === 'failed' &&
      /not a regular file/.test(fifo.outcome.reason) && Date.now() - started < 5_000 && fifo.clean);
  } else {
    assert('mkfifo available for the FIFO check', false);
  }
  const removed = await edit('x', 'remove');
  assert('a removed result is rejected', removed.outcome.kind === 'failed' && removed.clean);
  const malformed = await edit('x', 'bytes', { FIXTURE_TEXT: 'c328ff' });
  assert('malformed UTF-8 is rejected', malformed.outcome.kind === 'failed' && /UTF-8/.test(malformed.outcome.reason) && malformed.clean);
  const started = Date.now();
  const grow = await edit('x', 'grow');
  assert('a file still growing is read bounded and refused as oversize',
    grow.outcome.kind === 'failed' && /exceeds/.test(grow.outcome.reason) && Date.now() - started < 5_000);
  // The grower may still hold the directory open for its last append; give it its deadline.
  await delay(3_200);
  assert('the growing case leaves no storage once the writer stops', (await leftovers()).length === 0);
}

header('P9/P10 round trip — exact multiline Unicode, composer policy only, unchanged detected');
{
  const draft = 'line one\n汉字 🧪 e\u0301 — ünïcödé\n\tindented\n\nlast';
  const same = await edit(draft, 'none');
  assert('the temp file holds the exact draft', same.record?.content === draft);
  assert('no edit is reported unchanged', same.outcome.kind === 'unchanged' && same.clean);
  const appended = await edit(draft, 'append', { FIXTURE_TEXT: '\r\nsecond 🌍\u0007\r' });
  assert('a change is returned with CRLF/CR canonicalized and controls dropped',
    appended.outcome.kind === 'changed' && appended.outcome.text === `${draft}\nsecond 🌍\n` && appended.clean);
  const crlfOnly = await edit('a\nb', 'write', { FIXTURE_TEXT: 'a\r\nb' });
  assert('a CRLF-only rewrite normalizes to the draft and is unchanged', crlfOnly.outcome.kind === 'unchanged');
  const bom = await edit('x', 'bytes', { FIXTURE_TEXT: 'efbbbf78' });
  assert('a BOM is kept as text, not silently dropped', bom.outcome.kind === 'changed' && bom.outcome.text === '\ufeffx');
  const emptied = await edit('to delete', 'write', { FIXTURE_TEXT: '' });
  assert('an emptied file is a valid change to an empty draft', emptied.outcome.kind === 'changed' && emptied.outcome.text === '');
}

header('P12 shutdown — kill() reaps the editor and removes storage; SIGINT ignored meanwhile');
{
  await rm(log, { force: true });
  // Let the earlier edits' release grace end, so this starts outside any hold.
  await delay(TERMINAL_SIGNAL_GRACE_MS + 100);
  // Stands in for the SDK bash module's `process.exit(0)` SIGINT listener.
  let exitingListenerCalls = 0;
  const exitingListener = (): void => { exitingListenerCalls += 1; };
  process.on('SIGINT', exitingListener);
  const sigintBefore = process.listeners('SIGINT');
  const run = runExternalEditor('long edit', {
    argv: [editor], cwd: project, env: { ...baseEnv, FIXTURE_MODE: 'wait', FIXTURE_LOG: log },
    normalize: normalizeDraftText, tempRoot, projectRoot: project,
  });
  const deadline = Date.now() + 10_000;
  while ((await records()).length === 0 && Date.now() < deadline) await delay(20);
  const pid = (await records())[0]?.pid;
  assert('the waiting editor started', pid !== undefined);
  assert('existing SIGINT listeners are held aside while the editor owns the terminal',
    process.listenerCount('SIGINT') === 1 && !process.listeners('SIGINT').includes(exitingListener));
  process.kill(process.pid, 'SIGINT');
  await delay(100);
  assert('a terminal SIGINT reaches no held (process-exiting) listener', exitingListenerCalls === 0);
  run.kill();
  assert('storage is removed synchronously by kill()', (await leftovers()).length === 0);
  const outcome = await run.done;
  assert('the run settles as stopped, never changed', outcome.kind === 'failed' && /shutting down/.test(outcome.reason));
  let alive = pid !== undefined;
  const reapDeadline = Date.now() + 5_000;
  while (alive && Date.now() < reapDeadline) {
    try { process.kill(pid as number, 0); await delay(20); } catch { alive = false; }
  }
  assert('the editor process was reaped', !alive);
  await delay(TERMINAL_SIGNAL_GRACE_MS + 100);
  const after = process.listeners('SIGINT');
  assert('the held SIGINT listeners are restored exactly after settlement and its grace',
    after.length === sigintBefore.length && sigintBefore.every((listener, index) => after[index] === listener));
  process.off('SIGINT', exitingListener);
}

header('P12b overlapping holds — back-to-back edits inside the grace never leak a listener');
{
  const sentinel = (): void => {};
  process.on('SIGINT', sentinel);
  const before = process.listeners('SIGINT');
  for (let index = 0; index < 3; index += 1) {
    const { outcome } = await edit('quick', 'none');
    assert(`quick edit ${index + 1} settles unchanged`, outcome.kind === 'unchanged');
  }
  assert('still held right after the last quick edit', !process.listeners('SIGINT').includes(sentinel));
  await delay(TERMINAL_SIGNAL_GRACE_MS + 150);
  const after = process.listeners('SIGINT');
  assert('one restore of exactly the original listeners, no leaked no-op',
    after.length === before.length && before.every((listener, index) => after[index] === listener));
  process.off('SIGINT', sentinel);
}

header('P13 eligibility — idle only, nothing about to claim the session');
{
  const idle = { editorActive: false, idle: true, queued: 0, draining: false, clearing: false, goalOwed: false, peerPending: 0, liveDelegations: 0 };
  assert('idle and empty is eligible', externalEditorRefusal(idle) === undefined);
  assert('a repeated chord is ignored silently', externalEditorRefusal({ ...idle, editorActive: true }) === 'ignore');
  for (const [label, change] of [
    ['busy', { idle: false }], ['queued', { queued: 1 }], ['draining', { draining: true }], ['clearing', { clearing: true }],
    ['goal owed', { goalOwed: true }], ['peer pending', { peerPending: 1 }], ['live delegation', { liveDelegations: 1 }],
  ] as const) {
    const refusal = externalEditorRefusal({ ...idle, ...change });
    assert(`${label} refuses with a draft-unchanged notice`, typeof refusal === 'string' && refusal !== 'ignore' && refusal.includes('draft unchanged'));
  }
}

assert('P11 no editor storage left in the temp root at the end', (await leftovers()).length === 0);
await rm(root, { recursive: true, force: true });
report();
