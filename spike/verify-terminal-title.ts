/**
 * Free checks for the config-gated terminal window/tab title (SER-073).
 *
 * Two layers. The unit contract pins the pure module: the exact title text and
 * OSC 2 bytes for the base states (`idle`, `working`, `waiting for approval`), the
 * ` · N queued` suffix a waiting queue adds to whichever base holds, and the
 * restore; the precedence of the base derivation, end-first truncation at the
 * exported cap, control-character
 * stripping (a project name can never inject a second sequence), and the writer's
 * change-only rule plus its TTY / config guards and single restore. The pty layer
 * launches the real CLI through the terminal-bell fixture (only model
 * construction is replaced — see `fixtures/terminal-bell-cli.ts`), whose first
 * turn publishes a permission prompt, and reads the raw, un-stripped OSC 2
 * sequences: with the title enabled (the default) exactly one write per state
 * transition — idle, working, waiting for approval, working, idle, then a plain
 * second turn and the restore at `/exit`; with `terminalTitle: false`, zero
 * sequences anywhere. The queued suffix is not exercised in the pty: the fixture's
 * turns are too short to type a second prompt into deterministically, and while
 * its permission prompt is up the keyboard belongs to the prompt, not the
 * composer — the pure and writer assertions carry it. No model or network calls.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_TERMINAL_TITLE_CODE_POINTS,
  TERMINAL_TITLE_SEPARATOR,
  createTerminalTitleWriter,
  deriveTerminalTitleState,
  formatTerminalTitle,
  terminalTitleRestore,
  terminalTitleSequence,
} from '../src/tui/terminal-title.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui, stripAnsi } from './tui-driver.js';

const HOME = ownPrivateHome('terminal-title');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/terminal-bell-cli.ts');
const EXIT_TIMEOUT_MS = 20_000;

/** Every OSC 2 payload in the raw pty output, in write order. */
// eslint-disable-next-line no-control-regex
const titles = (raw: string): string[] => [...raw.matchAll(/\u001b\]2;([^\u0007]*)\u0007/g)].map((m) => m[1] as string);

function unitContract(): void {
  header('terminal title — composition and exact bytes');

  const project = 'strands-darwin';
  assert('idle reads `darwin · <project> · idle`',
    formatTerminalTitle({ projectBasename: project, state: 'idle' }) === 'darwin · strands-darwin · idle');
  assert('working reads `darwin · <project> · working`',
    formatTerminalTitle({ projectBasename: project, state: 'working' }) === 'darwin · strands-darwin · working');
  assert('a published permission prompt reads `waiting for approval`',
    formatTerminalTitle({ projectBasename: project, state: 'waiting for approval' }) === 'darwin · strands-darwin · waiting for approval');
  assert('a queue behind a running turn reads `working · N queued`',
    formatTerminalTitle({ projectBasename: project, state: 'working · 2 queued' }) === 'darwin · strands-darwin · working · 2 queued');
  assert('a queue behind a permission prompt reads `waiting for approval · N queued`',
    formatTerminalTitle({ projectBasename: project, state: 'waiting for approval · 1 queued' }) === 'darwin · strands-darwin · waiting for approval · 1 queued');
  assert('the transient idle-with-queue moment reads `idle · N queued`',
    formatTerminalTitle({ projectBasename: project, state: 'idle · 1 queued' }) === 'darwin · strands-darwin · idle · 1 queued');

  assert('the sequence is OSC 2, BEL-terminated: ESC ] 2 ; <title> BEL',
    terminalTitleSequence('darwin · strands-darwin · idle') === '\u001b]2;darwin · strands-darwin · idle\u0007');
  assert('the queued form is the same sequence shape',
    terminalTitleSequence('darwin · strands-darwin · working · 2 queued') === '\u001b]2;darwin · strands-darwin · working · 2 queued\u0007');
  assert('restore is the bare project basename in the same sequence',
    terminalTitleRestore(project) === '\u001b]2;strands-darwin\u0007');
  assert('the sequence never uses OSC 0 (icon name) or a title stack',
    !terminalTitleSequence('x').includes(']0;') && !terminalTitleRestore('x').includes('[22;') && !terminalTitleRestore('x').includes('[23;'));

  header('terminal title — state derivation: base precedence, queue as suffix');
  assert('a permission prompt outranks a running turn; the queue rides as a suffix',
    deriveTerminalTitleState({ permissionPending: true, busy: true, queued: 4 }) === 'waiting for approval · 4 queued');
  assert('a running turn with a queue reads `working · N queued`',
    deriveTerminalTitleState({ permissionPending: false, busy: true, queued: 2 }) === 'working · 2 queued');
  assert('a running turn without a queue reads `working`, no suffix',
    deriveTerminalTitleState({ permissionPending: false, busy: true, queued: 0 }) === 'working');
  assert('a permission prompt without a queue reads `waiting for approval`, no suffix',
    deriveTerminalTitleState({ permissionPending: true, busy: true, queued: 0 }) === 'waiting for approval');
  assert('an idle session with a queue reads `idle · N queued`',
    deriveTerminalTitleState({ permissionPending: false, busy: false, queued: 1 }) === 'idle · 1 queued');
  assert('nothing pending is idle, no suffix',
    deriveTerminalTitleState({ permissionPending: false, busy: false, queued: 0 }) === 'idle');
  assert('the suffix reuses the title separator',
    deriveTerminalTitleState({ permissionPending: false, busy: true, queued: 3 }) === `working${TERMINAL_TITLE_SEPARATOR}3 queued`);

  header('terminal title — bounded and sanitized');
  const long = 'p'.repeat(200);
  const bounded = formatTerminalTitle({ projectBasename: long, state: 'working' });
  assert(`the whole title is capped at ${MAX_TERMINAL_TITLE_CODE_POINTS} code points`,
    [...bounded].length === MAX_TERMINAL_TITLE_CODE_POINTS);
  assert('truncation is end-first: the app name survives, the tail becomes `…`',
    bounded.startsWith('darwin · ppp') && bounded.endsWith('…') && !bounded.includes('working'));
  const exact = formatTerminalTitle({ projectBasename: 'x'.repeat(MAX_TERMINAL_TITLE_CODE_POINTS - 'darwin ·  · idle'.length), state: 'idle' });
  assert('a title exactly at the cap is untouched', [...exact].length === MAX_TERMINAL_TITLE_CODE_POINTS && !exact.includes('…'));
  const emoji = formatTerminalTitle({ projectBasename: '🧬'.repeat(100), state: 'idle' });
  assert('the cap counts code points, not UTF-16 units', [...emoji].length === MAX_TERMINAL_TITLE_CODE_POINTS && emoji.endsWith('…'));

  const hostile = formatTerminalTitle({ projectBasename: 'evil\u0007\u001b]2;pwned\u001b\\\n\r\t\u007f\u009cname', state: 'idle' });
  assert('BEL, ESC, ST, newlines, DEL and C1 controls are stripped from the project name',
    hostile === 'darwin · evil]2;pwned\\name · idle');
  assert('the emitted sequence therefore contains exactly one ESC and one BEL',
    terminalTitleSequence(hostile).split('\u001b').length === 2 && terminalTitleSequence(hostile).split('\u0007').length === 2);
  assert('the restore sequence is sanitized the same way',
    terminalTitleRestore('a\u0007b\u001bc') === '\u001b]2;abc\u0007');
  assert('an empty project name (the filesystem root) drops its segment',
    formatTerminalTitle({ projectBasename: '', state: 'idle' }) === 'darwin · idle');

  header('terminal title — writer: change-only, guards, single restore');
  {
    const writes: string[] = [];
    const writer = createTerminalTitleWriter({ isTTY: true, write: (chunk) => writes.push(chunk) });
    writer.show({ projectBasename: 'proj', state: 'idle' }, true);
    writer.show({ projectBasename: 'proj', state: 'idle' }, true);
    assert('the same title twice is one write', writes.length === 1 && writes[0] === '\u001b]2;darwin · proj · idle\u0007');
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    writer.show({ projectBasename: 'proj', state: 'waiting for approval' }, true);
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    writer.show({ projectBasename: 'proj', state: 'working · 1 queued' }, true);
    writer.show({ projectBasename: 'proj', state: 'working · 1 queued' }, true);
    writer.show({ projectBasename: 'proj', state: 'working · 2 queued' }, true);
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    writer.show({ projectBasename: 'proj', state: 'idle' }, true);
    assert('every transition is exactly one write, in order — a queue growing 1 → 2 → 0 during a turn is three distinct writes', JSON.stringify(writes) === JSON.stringify([
      '\u001b]2;darwin · proj · idle\u0007',
      '\u001b]2;darwin · proj · working\u0007',
      '\u001b]2;darwin · proj · waiting for approval\u0007',
      '\u001b]2;darwin · proj · working\u0007',
      '\u001b]2;darwin · proj · working · 1 queued\u0007',
      '\u001b]2;darwin · proj · working · 2 queued\u0007',
      '\u001b]2;darwin · proj · working\u0007',
      '\u001b]2;darwin · proj · idle\u0007',
    ]));
    assert('lastTitle reports the title, not the sequence', writer.lastTitle === 'darwin · proj · idle');
    writer.restore();
    writer.restore();
    assert('restore writes the bare project name exactly once', writes.length === 9 && writes[8] === '\u001b]2;proj\u0007');
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    assert('nothing is written after restore', writes.length === 9);
  }
  {
    const writes: string[] = [];
    const writer = createTerminalTitleWriter({ isTTY: false, write: (chunk) => writes.push(chunk) });
    writer.show({ projectBasename: 'proj', state: 'idle' }, true);
    writer.show({ projectBasename: 'proj', state: 'working' }, true);
    writer.restore();
    assert('a non-TTY stdout gets no sequence at all, not even the restore', writes.length === 0 && writer.lastTitle === undefined);
  }
  {
    const writes: string[] = [];
    const writer = createTerminalTitleWriter({ isTTY: true, write: (chunk) => writes.push(chunk) });
    writer.show({ projectBasename: 'proj', state: 'idle' }, false);
    writer.show({ projectBasename: 'proj', state: 'working' }, false);
    writer.restore();
    assert('terminalTitle: false writes nothing, and a writer that never wrote never restores', writes.length === 0);
  }
  {
    let threw = false;
    try {
      const writer = createTerminalTitleWriter({ isTTY: true, write: () => { throw new Error('broken stdout'); } });
      writer.show({ projectBasename: 'proj', state: 'idle' }, true);
      writer.restore();
    } catch {
      threw = true;
    }
    assert('a broken writer cannot throw out of the title', !threw);
  }
  assert('the pty driver strips the title from screen text',
    stripAnsi('a\u001b]2;darwin · proj · waiting for approval\u0007b') === 'ab');
}

async function writeConfig(title: boolean): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    // Deliberately invalid: any accidental provider call fails loudly instead of
    // passing this free suite silently.
    model: 'us.anthropic.invalid-terminal-title-fixture',
    memory: false,
    ...(title ? {} : { terminalTitle: false }),
  }));
}

/**
 * One scripted interactive session: a turn whose tool call publishes a permission
 * prompt (denied with Escape), then a plain second turn, then `/exit`. With the
 * title on, `expected` is the exact ordered sequence of titles — one per
 * transition, none per frame; off expects no OSC 2 anywhere.
 */
async function ptyScenario(title: boolean): Promise<void> {
  header(`terminal title — pty, terminalTitle ${title ? 'enabled (default)' : 'disabled'}`);
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await writeConfig(title);
  const T = (state: string): string => `darwin · project · ${state}`;

  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 50 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    if (title) {
      await tui.waitUntil(() => titles(tui.raw).length >= 1, { timeoutMs: 10_000, label: 'the idle title at startup' });
      assert('the ready App writes the idle title once', JSON.stringify(titles(tui.raw)) === JSON.stringify([T('idle')]));
      assert('the title never reaches the ANSI-stripped screen', !tui.screen.includes('darwin · project'));
    } else {
      assert('no title at startup when disabled', titles(tui.raw).length === 0);
    }

    // Turn 1: the fixture model requests a gated bash write → permission prompt.
    const beforeTurn1 = tui.mark();
    tui.submit('please write the file');
    await tui.waitFor('esc=deny', { from: beforeTurn1, timeoutMs: 60_000 });
    if (title) {
      await tui.waitUntil(() => titles(tui.raw).includes(T('waiting for approval')), { timeoutMs: 10_000, label: 'waiting for approval title' });
      assert('working, then waiting for approval — one write each',
        JSON.stringify(titles(tui.raw)) === JSON.stringify([T('idle'), T('working'), T('waiting for approval')]));
    } else {
      assert('no title at permission publication when disabled', titles(tui.raw).length === 0);
    }

    tui.send('\u001b'); // Escape = deny; the model then answers with text.
    await tui.waitFor('bell fixture done', { from: beforeTurn1, timeoutMs: 60_000 });
    if (title) {
      await tui.waitUntil(() => titles(tui.raw).length >= 5, { timeoutMs: 10_000, label: 'idle title after the turn' });
      assert('the answer denies back to working, completion returns to idle',
        JSON.stringify(titles(tui.raw)) === JSON.stringify([T('idle'), T('working'), T('waiting for approval'), T('working'), T('idle')]));
    }

    // Turn 2: no tool call — working, idle, nothing else despite many frames.
    const beforeTurn2 = tui.mark();
    tui.submit('again');
    await tui.waitFor('bell fixture done', { from: beforeTurn2, timeoutMs: 60_000 });
    if (title) {
      await tui.waitUntil(() => titles(tui.raw).length >= 7, { timeoutMs: 10_000, label: 'idle title after turn 2' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('a plain turn is exactly two writes: streaming frames add none',
        JSON.stringify(titles(tui.raw).slice(5)) === JSON.stringify([T('working'), T('idle')]));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('zero OSC 2 sequences anywhere with the title disabled', titles(tui.raw).length === 0);
    }

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('the session exits cleanly', code === 0);
    if (title) {
      const all = titles(tui.raw);
      assert('exit restores the bare project name once, as the last sequence',
        all.length === 8 && all[7] === 'project');
    } else {
      assert('the disabled run stays free of OSC 2 through exit', titles(tui.raw).length === 0);
    }
  } finally {
    tui.kill();
  }
}

unitContract();
await ptyScenario(true);
await ptyScenario(false);
report();
