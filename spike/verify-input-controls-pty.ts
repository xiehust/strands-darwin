/** SER-100 C4: real CLI pty, real mode-000 filenames, no model invocation.
 * Exact raw drafts are proved without submitting: one-grapheme Backspace walks
 * every source suffix, checked against its independently projected screen text.
 * Literal escape text cannot pass: it takes six deletes rather than one.
 * Existing offline CLI fixture records every model call; absence is asserted.
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchPreview } from '../src/tui/search-preview.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-input-controls-pty-'));
const cwd = path.join(root, 'project');
const home = path.join(root, 'home');
await mkdir(cwd);
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(path.join(home, '.darwin/config.json'), '{}');
const names = ['a-ordinary.txt', 'b-\u001b[31mRED\u001b[0m.txt', 'c-\u001b]2;TITLE\u0007\u009bX\u2028\t\r\n中e\u0301👩‍💻.txt'];
await Promise.all(names.map((name) => writeFile(path.join(cwd, name), 'SER100_UNREAD_CONTENT', { mode: 0o000 })));
const tui = startTui({ cwd, cols: 100, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const END = '\u001b[F';
const HOME = '\u001b[H';
const LEFT = '\u001b[D';
const BACK = '\u007f';
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 15_000, settleMs: 100, label });
const project = (text: string) => text.replace(/\t/g, '    ')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function draftRows(): string[] {
  const lines = tui.frame.replaceAll('\r', '').split('\n');
  const start = lines.findIndex((line) => line.startsWith('you>'));
  if (start < 0) return [];
  const result = [lines[start]!.slice(5).trimEnd()];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('...> ')) break;
    result.push(line.slice(5).trimEnd());
  }
  return result;
}
async function draft(text: string): Promise<void> {
  await settled(() => JSON.stringify(draftRows()) === JSON.stringify(project(text).split('\n').map((s) => s.trimEnd())), `draft ${JSON.stringify(text)}`);
}
async function keys(input: string, expected: string): Promise<void> {
  tui.send(input);
  await draft(expected);
}

header('SER-100 C4 — hostile completion selection and exact unsent editing in the real CLI');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  for (const [index, key] of [[1, '\t'], [2, '\r']] as const) {
    tui.send('@');
    await settled(() => tui.frame.includes('❯ a-ordinary.txt'), 'scan populated');
    tui.send('\u001b[B'.repeat(index));
    await settled(() => tui.frame.includes(`❯ ${searchPreview(names[index]!)}`), 'selected raw candidate safely projected');
    const rawStart = tui.raw.length;
    let text = names[index]! + ' ';
    await keys(key, text);
    check.ok(!tui.frame.includes('files ('));
    check.ok(!tui.raw.slice(rawStart).includes('\u001b[31m'));
    check.ok(!tui.raw.slice(rawStart).includes('\u001b]2;TITLE'));
    assert(`${key === '\t' ? 'Tab' : 'Enter'} accepts selected path without submission or active payload`, true);

    // Both candidates finish in a short .txt row. Word cut/undo restores raw bytes,
    // then a marker proves source cursor after an ordinary left move and deletion.
    tui.send('\u0017');
    await settled(() => !tui.frame.includes('.txt'), 'word deleted');
    await keys('\u001f', text);
    await keys(`${LEFT}!`, text.slice(0, -1) + '! ');
    await keys(BACK, text);
    // Delete every raw grapheme, including CRLF as one unit and ESC as one unit.
    // End puts the cursor after the trailing space; the sentinel makes whitespace
    // differences visible even though Ink trims the row's trailing display spaces.
    await keys(`${END}|`, text + '|');
    await keys(BACK, text);
    const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      text = text.slice(0, parts[part]!.index);
      await keys(BACK, text);
      tui.send('|');
      await draft(text + '|');
      await keys(BACK, text);
    }
    assert('every raw source prefix survives one-grapheme deletion, cursor insertion and destructive undo', true);
  }

  // Narrow selection plus post-acceptance soft wrap: no repeated terminal clears.
  tui.resize(24, 24);
  await draft('');
  const rawStart = tui.raw.length;
  tui.send('@b');
  await settled(() => tui.frame.includes('❯ b-\\u001b[31mRED'), 'narrow safe menu');
  tui.send('\t');
  await settled(() => tui.frame.includes('you> b-\\u001b[31mRED') && !tui.frame.includes('files ('), 'narrow accepted draft');
  tui.send(`${HOME}X`);
  await settled(() => tui.frame.includes('you> b-\\u001b[31mREDX'), 'edit at wrapped raw boundary');
  check.ok(!tui.raw.slice(rawStart).includes('\u001b[2J'), 'no frame-overflow clear while selecting/editing');
  tui.resize(100, 24);
  await draft('b-\u001b[31mREDX\u001b[0m.txt ');
  assert('24-column wrap boundary edits exact raw offset and stays within the frame', true);
  check.ok(!existsSync(path.join(cwd, 'model-calls')));
  check.ok(!tui.screen.includes('working…'));
  check.ok(!tui.screen.includes('SER100_UNREAD_CONTENT'));
  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
  assert('all drafts remain unsent; zero model calls, file-content exposure or provider network', true);
} catch (error) {
  await writeFile(path.join(root, 'pty.raw'), tui.raw);
  console.error(`SER-100 pty artifacts: ${root}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}

report();
