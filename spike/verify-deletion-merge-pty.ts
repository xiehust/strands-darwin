/** SER-118 P1–P3: real production CLI/App in an offline pty, no submissions.
 * P1 LF/combining and RI merges followed by literal typing/movement/deletion.
 * P2 wrapped row cut/yank repeats and destructive undo restores the old cursor.
 * P3 no automatic send/model calls, unchanged raw controls and bounded frame.
 * Control bytes are separate writes with settled current-frame assertions.
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-deletion-merge-pty-'));
const cwd = path.join(root, 'project');
const home = path.join(root, 'home');
await mkdir(cwd);
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(path.join(home, '.darwin/config.json'), '{}');
const tui = startTui({ cwd, cols: 100, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const HOME = '\u001b[H';
const DRAFT_HOME = '\u001b[1;5H';
const BACK = '\u007f';
const DELETE = '\u001b[3~';
const UNDO = '\u001f';
const YANK = '\u0019';
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 15_000, settleMs: 100, label });
function draft(): string {
  const lines = tui.frame.replaceAll('\r', '').split('\n');
  const start = lines.findLastIndex((line) => line.startsWith('you>'));
  if (start < 0) return '';
  let result = lines[start]!.slice(5).trimEnd();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('...> ')) result += '\n' + line.slice(5).trimEnd();
    else if (line.startsWith('     ') && line.trim() !== '') result += line.slice(5).trimEnd();
    else break;
  }
  return result;
}
async function keys(input: string, expected: string): Promise<void> {
  tui.send(input);
  await settled(() => draft() === expected, `draft ${JSON.stringify(expected)}`);
}
async function paste(text: string): Promise<void> {
  await keys(`\u001b[200~${text}\u001b[201~`, text);
}
async function clear(text: string): Promise<void> {
  await keys(DRAFT_HOME, text);
  // Clear by ordinary grapheme deletes, never a submission or a cut reset.
  for (const _part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) tui.send(DELETE);
  await settled(() => draft() === '', 'empty unsent draft');
}

header('SER-118 P1–P3 — legal deletion caret and exact next input in the real offline CLI');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  const rawStart = tui.raw.length;
  for (const backward of [true, false]) {
    await paste('e\n\u0301x');
    if (backward) await keys(HOME, 'e\n\u0301x');
    else {
      await keys(DRAFT_HOME, 'e\n\u0301x');
      await keys(RIGHT, 'e\n\u0301x');
    }
    await keys(backward ? BACK : DELETE, 'e\u0301x');
    await keys('Z', 'e\u0301Zx');
    await keys(BACK, 'e\u0301x');
    await keys(LEFT, 'e\u0301x');
    await keys('Q', 'Qe\u0301x');
    await keys(BACK, 'e\u0301x');
    await keys(DELETE, 'x');
    await clear('x');
  }
  assert('P1 both LF deletes place Z after the joined combining grapheme, then move/delete exactly', true);
  await paste('🇦X🇧x');
  await keys(DRAFT_HOME, '🇦X🇧x');
  await keys(RIGHT, '🇦X🇧x');
  await keys(DELETE, '🇦🇧x');
  await keys('Z', '🇦🇧Zx');
  await keys(BACK, '🇦🇧x');
  await keys(BACK, 'x');
  await clear('x');
  assert('P1 regional indicators join with the next insertion after the flag; backspace deletes it whole', true);

  // At 60 columns, 53 ASCII cells + the woman/ZWJ grapheme fill the
  // first row. X starts the second row. Ctrl+U removes only X, not 💻.
  check.ok(!tui.raw.slice(rawStart).includes('\u001b[2J'), 'no frame-overflow clear before resize');
  tui.resize(60, 24);
  await settled(() => draft() === '', 'empty composer after width decrease');
  const narrowStart = tui.raw.length; // the mandated one-time resize clear is not overflow
  const padding = 'a'.repeat(53);
  const original = padding + '👩‍X💻x';
  await paste(original);
  await keys(LEFT, original);
  await keys(LEFT, original);
  await keys('\u0015', padding + '👩‍💻x');
  await keys('Z', padding + '👩‍💻Zx');
  await keys(YANK, padding + '👩‍💻ZXx');
  await keys(YANK, padding + '👩‍💻ZXXx');
  await keys(UNDO, original);
  await keys('Q', padding + '👩‍XQ💻x');
  await keys(BACK, original);
  await clear(original);
  assert('P2 row cut captures only X despite the repaired caret; yank repeats and undo restores the old cursor', true);

  check.ok(!existsSync(path.join(cwd, 'model-calls')), 'no implicit model call');
  check.ok(!tui.screen.includes('working…'), 'no automatic send');
  check.ok(!tui.raw.slice(narrowStart).includes('\u001b[2J'), 'no frame-overflow clear after resize');
  check.ok(!tui.frame.includes('queued'), 'no queue mutation');
  await keys('still-unsent', 'still-unsent');
  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
  check.ok(!existsSync(path.join(cwd, 'model-calls')));
  assert('P3 drafts stay unsent through exit, with zero model calls and bounded existing frame rows', true);
} catch (error) {
  await writeFile(path.join(root, 'pty.raw'), tui.raw);
  console.error(`SER-118 pty artifacts: ${root}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}
report();
