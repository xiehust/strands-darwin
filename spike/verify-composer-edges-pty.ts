/** SER-105: real Ink/CLI PTY; offline model fixture, no provider calls for editing. */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { layoutEditor, moveVertical, moveToRowEdge } from '../src/tui/prompt-editor.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-composer-edges-'));
const cwd = path.join(root, 'project');
const home = path.join(root, 'home');
await mkdir(cwd);
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(path.join(home, '.darwin/config.json'), '{}');
await writeFile(path.join(cwd, 'find-me.txt'), '');
const tui = startTui({ cwd, cols: 70, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const start = '\u001b[1;5H';
const end = '\u001b[1;5F';
const up = '\u001b[A';
const back = '\u007f';
const text = `a👩‍💻e\u0301${'z'.repeat(72)}\nbeta🌿end`;
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 15_000, settleMs: 100, label });

// Compare every displayed row, including soft wraps and explicit LF, with the
// exact source projection. Insert a witness at an expected UTF-16 offset to
// observe the real editor cursor without adding a test-only runtime hook.
async function draft(expected: string, columns: number): Promise<void> {
  const rows = layoutEditor(expected, columns, { offset: expected.length, affinity: 'upstream' }).rows;
  const wanted = rows.map((row) => `${row.prefix}${row.text}`.trimEnd());
  await settled(() => {
    const lines = tui.frame.replaceAll('\r', '').split('\n');
    const first = lines.findIndex((line) => line.startsWith('you> '));
    return first >= 0 && JSON.stringify(lines.slice(first, first + wanted.length).map((line) => line.trimEnd())) === JSON.stringify(wanted);
  }, `whole raw draft ${JSON.stringify(expected)}`);
}
async function move(key: string, alreadyThere = false): Promise<void> {
  const mark = tui.raw.length;
  tui.send(key);
  if (alreadyThere) {
    // Ink does not repaint a no-op. Give the real PTY a separate input event
    // before the insertion witness checks the same offset.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } else {
    await settled(() => tui.raw.length > mark, `cursor repaint for ${JSON.stringify(key)}`);
  }
}
async function at(offset: number, columns: number): Promise<void> {
  tui.send('!');
  await draft(`${text.slice(0, offset)}!${text.slice(offset)}`, columns);
  tui.send(back);
  await draft(text, columns);
}

header('SER-105 — real PTY multiline composer boundaries and owner precedence');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  tui.send(text.replace('\n', '\u000a'));
  await draft(text, 70);
  for (const columns of [70, 24]) {
    if (columns === 24) {
      tui.resize(columns, 24);
      await draft(text, columns);
    }
    // The end is on a separate logical line. One Up lands in a soft-wrapped
    // visual row of the first line; neither modified key may stop at that row.
    if (columns === 24) await move(end); // first pass already starts at draft end
    await move(up);
    const middle = moveVertical(layoutEditor(text, columns, { offset: text.length, affinity: 'upstream' }), -1).cursor;
    const row = layoutEditor(text, columns, middle);
    check.ok(row.cursor.row > 0 && row.cursor.row < row.rows.length - 1);
    await move(start);
    await at(0, columns);
    await move(end);
    await move(up);
    await move(end);
    await at(text.length, columns);

    const localKeys = [['\u001b[H', 'start'], ['\u001b[F', 'end'], ['\u0001', 'start'], ['\u0005', 'end']] as const;
    for (const [index, [key, edge]] of localKeys.entries()) {
      if (index > 0) await move(end); // first witness left the cursor at draft end
      await move(up);
      await move(key, columns === 24 && edge === 'end');
      await at(moveToRowEdge(row, edge).offset, columns);
    }
    assert(`${columns}-column PTY: modified whole-draft, plain/readline visual-row, exact raw UTF-16 cursor`, true);
  }

  // A completion menu owns its selection keys, not the draft's edge chords.
  tui.send(start);
  tui.send('\u0013'); // stash unsent multiline draft into the existing draft slot
  await draft('', 24);
  tui.send('@f');
  await settled(() => tui.frame.includes('❯ find-me.txt'), 'completion menu');
  tui.send(end);
  await draft('@f', 24);
  check.ok(tui.frame.includes('❯ find-me.txt'));
  tui.send(back.repeat(2));
  await draft('', 24);
  assert('completion remains open for its own keys; edge movement does not accept or submit', true);

  // The offline fixture asks for a gated bash call after this one explicit send.
  tui.send('permission\r');
  await tui.waitFor('permission preparing', { timeoutMs: 60_000 });
  tui.send('keep');
  await writeFile(path.join(cwd, 'release-permission'), '');
  await settled(() => tui.frame.includes('allow? y n') && tui.frame.includes('[parent] bash'), 'permission owner');
  tui.send(start);
  await new Promise((resolve) => setTimeout(resolve, 100));
  tui.send(end);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check.ok(tui.frame.includes('allow? y n') && tui.frame.includes('[parent] bash'));
  tui.send('n');
  await draft('keep', 24);
  tui.send('!');
  await draft('keep!', 24); // ignored edge keys left cursor at the draft's end
  assert('permission owns both modified keys; hidden draft and cursor remain unchanged', true);

  tui.send('\u0012'); // Ctrl+R: history search owns the keyboard
  await settled(() => tui.frame.includes('search'), 'history search owner');
  tui.send(start + end);
  await settled(() => tui.frame.includes('search'), 'search retains ownership');
  tui.send('\u001b');
  await draft('keep!', 24);
  tui.send('~');
  await draft('keep!~', 24);
  assert('history search ignores both modified keys and restores exact draft/cursor', true);
  // The finished fixture turn also supplies a real rewind checkpoint. Its
  // chooser, like history search, must consume modified edges before editing.
  tui.send(back.repeat(6));
  await draft('', 24);
  tui.send('/rewind\r');
  await settled(() => tui.frame.includes('rewind prompts'), 'rewind search owner');
  tui.send(start);
  await new Promise((resolve) => setTimeout(resolve, 100));
  tui.send(end);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check.ok(tui.frame.includes('rewind prompts'));
  tui.send('\u001b');
  await draft('/rewind', 24);
  tui.send('!');
  await draft('/rewind!', 24);
  assert('rewind chooser owns both modified keys; Escape restores the unsent command and cursor', true);

  check.deepEqual((await readFile(path.join(cwd, 'model-calls'), 'utf8')).trim().split('\n'), ['"permission"', '"tool result"']);
  check.ok(!existsSync(path.join(cwd, 'yank-permission-sentinel')));
  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
  assert('only the explicit fixture submission and its tool-result continuation called the model', true);
} catch (error) {
  await writeFile(path.join(root, 'pty.raw'), tui.raw);
  console.error(`SER-105 pty artifacts: ${root}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}
report();
