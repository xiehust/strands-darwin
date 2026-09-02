/**
 * SER-057 — `/copy`: the last completed answer's transcript text onto the clipboard.
 *
 * Pure and offline: the encoder, the byte cap, the completed-answer selection and the
 * platform-tool choice are checked without a terminal, a model, or a spawned helper
 * (the one real `writeClipboardCommand` call names a binary that does not exist, so
 * the ENOENT path is exercised and nothing runs). The pty scenario
 * `verify-tui.ts copy` proves the same sequence reaches a real terminal.
 *
 * Run: pnpm tsx spike/verify-copy-command.ts
 */
import {
  COPY_COMMAND_USAGE,
  MAX_COPY_BYTES,
  NOTHING_TO_COPY_NOTICE,
  boundCopyPayload,
  clipboardCopyCommand,
  formatCopyNotice,
  latestCompletedAnswer,
  osc52Sequence,
  runCopyCommand,
  writeClipboardCommand,
} from '../src/tui/copy-command.js';
import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { replayRecords } from '../src/trajectory/replay.js';
import type { AnswerPart, HistoryItem } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

let ids = 0;
function assistant(text: string, part: AnswerPart): HistoryItem {
  ids += 1;
  return { kind: 'assistant', id: `a-${ids}`, text, part, codeOpen: false };
}
function user(text: string): HistoryItem {
  ids += 1;
  return { kind: 'user', id: `u-${ids}`, text };
}
function notice(text: string): HistoryItem {
  ids += 1;
  return { kind: 'notice', id: `n-${ids}`, text, severity: 'info' };
}

/** Decodes one OSC 52 clipboard sequence back to its text, or nothing if malformed. */
function decodeOsc52(sequence: string): string | undefined {
  const match = /^\u001B\]52;c;([A-Za-z0-9+/=]*)\u0007$/.exec(sequence);
  return match === null ? undefined : Buffer.from(match[1] as string, 'base64').toString('utf8');
}

header('/copy — OSC 52 encoding is exact');
{
  const text = 'first line\n\n  indented `code` — ünïcödé ✓\nlast line';
  const sequence = osc52Sequence(Buffer.from(text, 'utf8'));
  assert('the sequence is ESC ] 52 ; c ; base64 BEL and nothing else',
    sequence.startsWith('\u001B]52;c;') && sequence.endsWith('\u0007') &&
    !sequence.slice(0, -1).includes('\u0007') && !sequence.slice(1).includes('\u001B'));
  assert('the base64 payload decodes to the exact text', decodeOsc52(sequence) === text);
  assert('an empty payload is still a well-formed sequence',
    osc52Sequence(Buffer.alloc(0)) === '\u001B]52;c;\u0007');
}

header('/copy — the byte cap is stated, never silent');
{
  assert('MAX_COPY_BYTES is a named finite positive integer',
    Number.isInteger(MAX_COPY_BYTES) && MAX_COPY_BYTES > 0);
  const short = boundCopyPayload('hello');
  assert('under the cap, copied equals total and the bytes are the whole text',
    short.copiedBytes === 5 && short.totalBytes === 5 && short.bytes.toString('utf8') === 'hello');

  const exact = boundCopyPayload('x'.repeat(MAX_COPY_BYTES));
  assert('exactly at the cap is not truncated', exact.copiedBytes === MAX_COPY_BYTES && exact.totalBytes === MAX_COPY_BYTES);

  const over = boundCopyPayload('y'.repeat(MAX_COPY_BYTES + 1000));
  assert('over the cap, copied is the cap and total is the real length',
    over.copiedBytes === MAX_COPY_BYTES && over.totalBytes === MAX_COPY_BYTES + 1000 &&
    over.bytes.byteLength === MAX_COPY_BYTES);
  const overNotice = formatCopyNotice(over, undefined);
  assert('the notice states exactly how many bytes of how many were copied',
    overNotice.text.includes(`copied ${MAX_COPY_BYTES} of ${MAX_COPY_BYTES + 1000} bytes`) &&
    overNotice.text.includes(`cap ${MAX_COPY_BYTES} bytes`) && overNotice.severity === 'warn');

  // A 3-byte code point straddling a 7-byte cap: the cut must back up to byte 6.
  const straddle = boundCopyPayload(`abcdef✓gh`, 7);
  assert('the cut lands on a code-point boundary, never inside one',
    straddle.copiedBytes === 6 && straddle.bytes.toString('utf8') === 'abcdef' &&
    straddle.totalBytes === Buffer.byteLength('abcdef✓gh'));
  const straddleWhole = boundCopyPayload(`abcdef✓gh`, 9);
  assert('a cap that ends exactly after a multi-byte code point keeps it',
    straddleWhole.copiedBytes === 9 && straddleWhole.bytes.toString('utf8') === 'abcdef✓');

  const okNotice = formatCopyNotice(short, undefined);
  assert('the success notice names the byte count and OSC 52 only when no tool ran',
    okNotice.text === 'copied the last answer to the clipboard (5 bytes) via OSC 52' && okNotice.severity === 'info');
  assert('a successful tool is named beside OSC 52',
    formatCopyNotice(short, { name: 'wl-copy' }).text.endsWith('via OSC 52 and wl-copy'));
  const failed = formatCopyNotice(short, { name: 'xclip', failure: 'xclip is not installed' });
  assert('a failed tool is stated as a clause of the same notice, as a warning',
    failed.text.endsWith('via OSC 52; xclip is not installed') && failed.severity === 'warn');
}

header('/copy — selects the latest completed answer');
{
  assert('empty history → nothing', latestCompletedAnswer([]) === undefined);
  assert('a user prompt alone → nothing', latestCompletedAnswer([user('hi')]) === undefined);
  assert('a whole answer is returned verbatim',
    latestCompletedAnswer([user('q'), assistant('the answer', 'whole')]) === 'the answer');
  assert('streamed pieces are joined with newlines — the /export text',
    latestCompletedAnswer([
      user('q'), assistant('line 1\nline 2', 'first'), assistant('line 3', 'middle'), assistant('line 4', 'last'),
    ]) === 'line 1\nline 2\nline 3\nline 4');
  assert('an empty closing piece (the owed blank row) adds no trailing newline',
    latestCompletedAnswer([assistant('a\nb', 'first'), assistant('', 'last')]) === 'a\nb');
  assert('the newest completed answer wins over an older one',
    latestCompletedAnswer([
      assistant('old', 'whole'), user('again'), assistant('new', 'whole'),
    ]) === 'new');
  assert('an answer still arriving (first/middle, no last) is skipped for the previous completed one',
    latestCompletedAnswer([
      user('q1'), assistant('done answer', 'whole'), user('q2'),
      assistant('streaming so far', 'first'), assistant('more streaming', 'middle'),
    ]) === 'done answer');
  assert('an in-progress answer with no completed predecessor → nothing',
    latestCompletedAnswer([user('q'), assistant('partial', 'first')]) === undefined);
  assert('a notice between pieces of one answer is stepped over, not copied',
    latestCompletedAnswer([
      assistant('p1', 'first'), notice('hook: something'), assistant('p2', 'last'),
    ]) === 'p1\np2');
  assert('the walk stops at the previous answer’s close instead of merging two answers',
    latestCompletedAnswer([
      assistant('first answer', 'whole'), assistant('tail only', 'last'),
    ]) === 'tail only');
  assert('tool rows and plans between answers do not count as answer text',
    latestCompletedAnswer([
      assistant('answer', 'whole'),
      { kind: 'tool', id: 't', name: 'bash', summary: '$ ls', status: 'ok', preview: 'out', inputPreview: '', expanded: false },
      { kind: 'plan', id: 'p', plan: [] },
    ]) === 'answer');
}

header('/copy — the same text a replayed trajectory yields');
{
  // The reducer path a resumed session takes: contentBlockEvent closes the answer as
  // one `whole` piece, and the text is the trimmed authoritative block.
  const replayed = replayRecords([
    { v: 1, seq: 1, at: 'x', type: 'runStarted', session: 's', agentId: 'darwin', darwinVersion: 't', provider: 'bedrock', model: 'm', permissionMode: 'default', thinkingEffort: 'high', resumed: false, restoredMessages: 0 },
    { v: 1, seq: 2, at: 'x', type: 'userInput', turn: 1, text: 'question' },
    { v: 1, seq: 3, at: 'x', type: 'contentBlockEvent', turn: 1, data: { contentBlock: { text: 'replayed answer\nwith two lines\n' } } },
    { v: 1, seq: 4, at: 'x', type: 'turnEnded', turn: 1, outcome: 'completed' },
  ] as never);
  assert('the resumed transcript’s answer is selected verbatim, trimmed as the transcript shows it',
    latestCompletedAnswer(replayed.history) === 'replayed answer\nwith two lines');
}

header('/copy — platform tool selection without spawning');
{
  assert('Wayland selects wl-copy',
    JSON.stringify(clipboardCopyCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })) ===
    JSON.stringify({ command: 'wl-copy', args: [] }));
  assert('X11 selects xclip on the clipboard selection',
    JSON.stringify(clipboardCopyCommand('linux', { DISPLAY: ':0' })) ===
    JSON.stringify({ command: 'xclip', args: ['-selection', 'clipboard'] }));
  assert('Wayland wins when both displays are set',
    clipboardCopyCommand('linux', { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' })?.command === 'wl-copy');
  assert('macOS selects pbcopy regardless of display variables',
    clipboardCopyCommand('darwin', {})?.command === 'pbcopy');
  assert('Linux without a display (SSH) selects no tool — OSC 52 alone',
    clipboardCopyCommand('linux', {}) === undefined);
  assert('empty display variables count as absent',
    clipboardCopyCommand('linux', { DISPLAY: '', WAYLAND_DISPLAY: '' }) === undefined);
  assert('other platforms select no tool', clipboardCopyCommand('win32', { DISPLAY: ':0' }) === undefined);
}

header('/copy — runCopyCommand: OSC 52 first, tool second, one notice, nothing thrown');
{
  const writes: string[] = [];
  const write = (data: string): void => { writes.push(data); };
  const history = [user('q'), assistant('copy me', 'whole')];

  const none = await runCopyCommand({ history, writeToTerminal: write, platform: 'linux', env: {} });
  assert('without a display exactly one OSC 52 write happens and the notice says so',
    writes.length === 1 && decodeOsc52(writes[0] as string) === 'copy me' &&
    none.text === 'copied the last answer to the clipboard (7 bytes) via OSC 52');

  writes.length = 0;
  const calls: { command: string; bytes: string }[] = [];
  const ok = await runCopyCommand({
    history, writeToTerminal: write, platform: 'linux', env: { WAYLAND_DISPLAY: 'w' },
    runTool: async (selected, bytes) => { calls.push({ command: selected.command, bytes: bytes.toString('utf8') }); return undefined; },
  });
  assert('with a display the OSC 52 write still happens first and the tool gets the same bytes',
    writes.length === 1 && calls.length === 1 && calls[0]?.command === 'wl-copy' && calls[0]?.bytes === 'copy me' &&
    ok.text.endsWith('via OSC 52 and wl-copy') && ok.severity === 'info');

  writes.length = 0;
  const failing = await runCopyCommand({
    history, writeToTerminal: write, platform: 'darwin', env: {},
    runTool: async () => 'pbcopy exited 1: no pasteboard',
  });
  assert('a tool failure is a clause of the notice, not a throw, and OSC 52 was still written',
    writes.length === 1 && failing.text.endsWith('via OSC 52; pbcopy exited 1: no pasteboard') && failing.severity === 'warn');

  writes.length = 0;
  const throwing = await runCopyCommand({
    history, writeToTerminal: write, platform: 'darwin', env: {},
    runTool: async () => { throw new Error('boom'); },
  });
  assert('even a throwing helper becomes a stated failure',
    throwing.text.endsWith('via OSC 52; pbcopy failed: boom') && throwing.severity === 'warn');

  writes.length = 0;
  const nothing = await runCopyCommand({ history: [user('q'), assistant('partial', 'first')], writeToTerminal: write, platform: 'linux', env: {} });
  assert('nothing to copy writes no sequence and is an info notice, not an error',
    writes.length === 0 && nothing.text === NOTHING_TO_COPY_NOTICE && nothing.severity === 'info');
  assert('the fresh-session case is the same notice',
    (await runCopyCommand({ history: [], writeToTerminal: write, platform: 'linux', env: {} })).text === NOTHING_TO_COPY_NOTICE);

  const missing = await writeClipboardCommand(
    { command: 'darwin-no-such-clipboard-tool-ser057', args: [] }, Buffer.from('x'), {}, 2_000,
  );
  assert('a missing helper binary resolves to a stated failure instead of rejecting',
    missing === 'darwin-no-such-clipboard-tool-ser057 is not installed');
}

header('/copy — registry');
assert('copy is a canonical built-in', (BUILTIN_COMMAND_NAMES as readonly string[]).includes('copy'));
assert('the usage notice names the command', COPY_COMMAND_USAGE === '/copy takes no arguments');

report();
