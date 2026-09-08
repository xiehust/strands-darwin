/**
 * Free checks for the config-gated terminal-mediated attention notification
 * (SER-078, `terminalNotify`).
 *
 * Three layers. The unit contract proves the exact bytes: one OSC 9 sequence
 * (`ESC ] 9 ; darwin · <project> · <body> ESC \`), ST-terminated and never BEL; the
 * tmux passthrough wrapper (`ESC P tmux ; … ESC \` with inner ESCs doubled); the
 * sanitizer stripping ESC/BEL/`;`/newlines/other C0/C1 controls from the project
 * name and capping the text at 120 code points; `notifyTerminal` writing exactly once
 * when enabled on a TTY, nothing when disabled or on a pipe, and never throwing for a
 * broken writer. The source layer greps: the sequence bytes are written by one
 * module, and no headless driver, child-agent or hook code imports it. The pty layer
 * launches the real CLI (only model construction is replaced — see
 * `fixtures/terminal-bell-cli.ts`) and counts raw OSC 9 sequences: enabled, exactly
 * one at permission publication and one more per completed turn, with the exact
 * payload; enabled under a `TMUX` environment, the same count arrives wrapped in the
 * passthrough DCS and nothing arrives bare; disabled (the default), zero anywhere —
 * the off path is byte-identical to before the feature existed. The pty runs pin
 * `TMUX` explicitly so a Host running the suite inside tmux sees the same bytes.
 * No model or network calls.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_TERMINAL_NOTIFY_CODE_POINTS,
  TERMINAL_NOTIFY_BODY,
  TERMINAL_NOTIFY_ST,
  formatTerminalNotification,
  isInsideTmux,
  notifyTerminal,
  sanitizeNotifyText,
  terminalNotifySequence,
  terminalNotifyTitle,
  wrapForTmuxPassthrough,
} from '../src/tui/terminal-notify.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const HOME = ownPrivateHome('terminal-notify');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/terminal-bell-cli.ts');
const EXIT_TIMEOUT_MS = 20_000;

const ESC = '\u001b';
const BEL = '\u0007';

/** Every bare (un-wrapped) OSC 9 payload in the raw pty output, in write order. */
// eslint-disable-next-line no-control-regex
const bareNotifications = (raw: string): string[] =>
  [...raw.matchAll(/(?<!\u001b)\u001b\]9;([^\u0007\u001b]*)\u001b\\/g)].map((m) => m[1] as string);
/** Every tmux-passthrough-wrapped OSC 9 payload (`ESC P tmux ; ESC ESC ] 9 ; text ESC ESC \ ESC \`). */
// eslint-disable-next-line no-control-regex
const wrappedNotifications = (raw: string): string[] =>
  [...raw.matchAll(/\u001bPtmux;\u001b\u001b\]9;([^\u0007\u001b]*)\u001b\u001b\\\u001b\\/g)].map((m) => m[1] as string);
/** Any DCS passthrough at all — the disabled run must hold none. */
const passthroughs = (raw: string): number => raw.split(`${ESC}Ptmux;`).length - 1;
/** BELs outside OSC payloads — the notification must never add one. */
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const bells = (raw: string): number => raw.replace(OSC, '').split(BEL).length - 1;

function unitContract(): void {
  header('terminal notify — composition and exact bytes');

  assert('the terminator is ST (ESC \\), never BEL', TERMINAL_NOTIFY_ST === `${ESC}\\` && !TERMINAL_NOTIFY_ST.includes(BEL));
  assert('the title is the terminal title\'s head: `darwin · <project>`', terminalNotifyTitle('strands-darwin') === 'darwin · strands-darwin');
  assert('an empty project drops its segment rather than leaving a dangling separator', terminalNotifyTitle('') === 'darwin');
  assert('the permission body is the title\'s state word', TERMINAL_NOTIFY_BODY.permission === 'waiting for approval');
  assert('the turn-complete body reads `turn complete`', TERMINAL_NOTIFY_BODY['turn-complete'] === 'turn complete');
  assert('permission reads `darwin · <project> · waiting for approval`',
    formatTerminalNotification({ projectBasename: 'strands-darwin', moment: 'permission' }) === 'darwin · strands-darwin · waiting for approval');
  assert('turn complete reads `darwin · <project> · turn complete`',
    formatTerminalNotification({ projectBasename: 'strands-darwin', moment: 'turn-complete' }) === 'darwin · strands-darwin · turn complete');

  const sequence = terminalNotifySequence('darwin · strands-darwin · turn complete');
  assert('the sequence is OSC 9, ST-terminated: ESC ] 9 ; <text> ESC \\',
    sequence === `${ESC}]9;darwin · strands-darwin · turn complete${ESC}\\`);
  assert('the sequence holds no BEL byte', !sequence.includes(BEL));
  assert('the payload never begins with a ConEmu-style `<digit>;` sub-command', /^\u001b\]9;[^\d]/.test(sequence));
  assert('it is not OSC 777 and not OSC 99', !sequence.includes(']777;') && !sequence.includes(']99;'));

  header('terminal notify — tmux passthrough wrapper');
  const wrapped = wrapForTmuxPassthrough(sequence);
  assert('the wrapper is `ESC P tmux ;` … `ESC \\` with every inner ESC doubled',
    wrapped === `${ESC}Ptmux;${ESC}${ESC}]9;darwin · strands-darwin · turn complete${ESC}${ESC}\\${ESC}\\`);
  assert('the wrapper contains the bare sequence with ESCs doubled and nothing else',
    wrapped === `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`);
  assert('TMUX set means inside tmux', isInsideTmux({ TMUX: '/tmp/tmux-1000/default,123,0' }) === true);
  assert('TMUX absent or empty means not inside tmux', isInsideTmux({}) === false && isInsideTmux({ TMUX: '' }) === false);

  header('terminal notify — payload hygiene');
  assert('ESC is stripped', sanitizeNotifyText(`a${ESC}]2evil${BEL}b`) === 'a]2evilb');
  assert('BEL is stripped', !sanitizeNotifyText(`x${BEL}y`).includes(BEL) && sanitizeNotifyText(`x${BEL}y`) === 'xy');
  assert('`;` is stripped (the OSC field separator)', sanitizeNotifyText('4;1;50') === '4150');
  assert('newlines and carriage returns are stripped', sanitizeNotifyText('a\nb\r\nc') === 'abc');
  assert('other C0 controls, DEL and C1 (including the C1 ST U+009C) are stripped',
    sanitizeNotifyText('a\u0000\u0001\u001f\u007f\u0080\u009c\u009fb') === 'ab');
  assert('printable non-ASCII survives', sanitizeNotifyText('démo · 项目') === 'démo · 项目');
  const injected = formatTerminalNotification({ projectBasename: `proj${ESC}]9;fake${ESC}\\;4;1;50\n`, moment: 'permission' });
  assert('a hostile project name cannot inject a second sequence or a ConEmu sub-command',
    injected === 'darwin · proj]9fake\\4150 · waiting for approval' && !injected.includes(ESC) && !injected.includes(';'));
  const seqFromHostile = terminalNotifySequence(`t${ESC}\\${ESC}]9;u`);
  assert('the sequence builder sanitizes at the seam too: exactly one ESC ] and one ESC \\',
    seqFromHostile.split(ESC).length - 1 === 2 && seqFromHostile === `${ESC}]9;t\\]9u${ESC}\\`);

  const long = 'p'.repeat(200);
  const capped = formatTerminalNotification({ projectBasename: long, moment: 'turn-complete' });
  assert(`the text is capped at ${MAX_TERMINAL_NOTIFY_CODE_POINTS} code points, ending in …`,
    [...capped].length === MAX_TERMINAL_NOTIFY_CODE_POINTS && capped.endsWith('…') && MAX_TERMINAL_NOTIFY_CODE_POINTS === 120);
  const exact = formatTerminalNotification({ projectBasename: 'x'.repeat(120 - 'darwin ·  · turn complete'.length), moment: 'turn-complete' });
  assert('a text exactly at the cap is untouched', [...exact].length === 120 && !exact.includes('…'));
  const astral = formatTerminalNotification({ projectBasename: '😀'.repeat(200), moment: 'turn-complete' });
  assert('the cap counts code points, not UTF-16 units', [...astral].length === MAX_TERMINAL_NOTIFY_CODE_POINTS && astral.endsWith('…'));

  header('terminal notify — the write seam');
  const writes: string[] = [];
  const write = (chunk: string): void => { writes.push(chunk); };
  const input = { projectBasename: 'strands-darwin', moment: 'permission' as const };

  notifyTerminal(true, input, { isTTY: true, insideTmux: false, write });
  assert('enabled on a TTY writes exactly once', writes.length === 1);
  assert('…and the write is the bare OSC 9 sequence with the composed text',
    writes[0] === `${ESC}]9;darwin · strands-darwin · waiting for approval${ESC}\\`);

  notifyTerminal(false, input, { isTTY: true, insideTmux: false, write });
  assert('disabled performs no write at all', writes.length === 1);
  notifyTerminal(false, input, { isTTY: true, insideTmux: true, write });
  assert('disabled inside tmux performs no write either', writes.length === 1);

  notifyTerminal(true, input, { isTTY: false, insideTmux: false, write });
  assert('a non-TTY stdout gets no sequence', writes.length === 1);

  notifyTerminal(true, input, { isTTY: true, insideTmux: true, write });
  assert('inside tmux the one write is the passthrough-wrapped sequence',
    writes.length === 2 && writes[1] === wrapForTmuxPassthrough(`${ESC}]9;darwin · strands-darwin · waiting for approval${ESC}\\`));

  notifyTerminal(true, { projectBasename: 'strands-darwin', moment: 'turn-complete' }, { isTTY: true, insideTmux: false, write });
  assert('turn complete writes its own body', writes.length === 3 && writes[2] === `${ESC}]9;darwin · strands-darwin · turn complete${ESC}\\`);
  assert('no write ever carries a BEL', writes.every((chunk) => !chunk.includes(BEL)));

  let threw = false;
  try {
    notifyTerminal(true, input, {
      isTTY: true,
      insideTmux: false,
      write: () => {
        throw new Error('broken stdout');
      },
    });
  } catch {
    threw = true;
  }
  assert('a broken writer cannot throw out of the notification', !threw);
}

/** Recursively lists `.ts`/`.tsx` files under a directory. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function sourceContract(): Promise<void> {
  header('terminal notify — one writer, never imported by headless/agents/hooks');
  const src = path.join(REPO_ROOT, 'src');
  const files = await sourceFiles(src);
  const writers: string[] = [];
  const importers: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    // Both spellings of the OSC 9 introducer: the escaped source form and a raw byte.
    if (text.includes(']9;') || text.includes('\\u001B]9;') || text.includes('\\u001b]9;') || text.includes('\\x1b]9;')) writers.push(rel);
    if (/terminal-notify\.js/.test(text) && rel !== 'src/tui/terminal-notify.ts') importers.push(rel);
  }
  assert('src/tui/terminal-notify.ts is the sole place in src/ that spells the OSC 9 introducer',
    writers.length === 1 && writers[0] === 'src/tui/terminal-notify.ts');
  assert('only the two interactive drivers import it (App.tsx turn end, cli-main.ts permission publication)',
    importers.sort().join(',') === 'src/cli-main.ts,src/tui/App.tsx');
  const forbidden = importers.filter((rel) => /^src\/headless|^src\/agents\/|^src\/hooks\//.test(rel));
  assert('no headless driver, child-agent or hook module imports it', forbidden.length === 0);
}

async function writeConfig(notify: boolean): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    // Deliberately invalid: any accidental provider call fails loudly instead of
    // passing this free suite silently.
    model: 'us.anthropic.invalid-terminal-notify-fixture',
    memory: false,
    ...(notify ? { terminalNotify: true } : {}),
  }));
}

type Scenario = 'disabled' | 'enabled' | 'enabled-tmux';

/**
 * One scripted interactive session: a turn whose tool call publishes a permission
 * prompt (denied with Escape), then a plain second turn. `expected` payloads are
 * checked exactly after each anchor; the disabled run expects nothing throughout.
 */
async function ptyScenario(scenario: Scenario): Promise<void> {
  header(`terminal notify — pty, ${scenario === 'disabled' ? 'terminalNotify disabled (default)' : scenario === 'enabled' ? 'terminalNotify enabled' : 'terminalNotify enabled inside tmux (TMUX set)'}`);
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await writeConfig(scenario !== 'disabled');

  const wrappedRun = scenario === 'enabled-tmux';
  const seen = wrappedRun ? wrappedNotifications : bareNotifications;
  const other = wrappedRun ? bareNotifications : wrappedNotifications;
  const tui = startTui({
    cwd: ROOT,
    entry: ENTRY,
    cols: 120,
    rows: 50,
    env: { TMUX: wrappedRun ? '/tmp/tmux-1000/default,4242,0' : '' },
  });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('no notification before any turn', seen(tui.raw).length === 0 && other(tui.raw).length === 0);

    // Turn 1: the fixture model requests a gated bash write.
    const beforeTurn1 = tui.mark();
    tui.submit('please write the file');
    await tui.waitFor('esc=deny', { from: beforeTurn1, timeoutMs: 60_000 });
    if (scenario !== 'disabled') {
      await tui.waitUntil(() => seen(tui.raw).length === 1, { timeoutMs: 10_000, label: 'one notification at permission publication' });
      assert('exactly one notification when the permission prompt is published', seen(tui.raw).length === 1);
      assert('…reading `darwin · project · waiting for approval`', seen(tui.raw)[0] === 'darwin · project · waiting for approval');
    } else {
      assert('no notification at permission publication when disabled', seen(tui.raw).length === 0);
    }

    tui.send('\u001b'); // Escape = deny; the model then answers with text.
    await tui.waitFor('bell fixture done', { from: beforeTurn1, timeoutMs: 60_000 });
    if (scenario !== 'disabled') {
      await tui.waitUntil(() => seen(tui.raw).length === 2, { timeoutMs: 10_000, label: 'a second notification at turn completion' });
      assert('exactly one more notification when the turn completes', seen(tui.raw).length === 2);
      assert('…reading `darwin · project · turn complete`', seen(tui.raw)[1] === 'darwin · project · turn complete');
    }

    // Turn 2: no tool call, so completion is the only notification moment.
    const beforeTurn2 = tui.mark();
    tui.submit('again');
    await tui.waitFor('bell fixture done', { from: beforeTurn2, timeoutMs: 60_000 });
    if (scenario !== 'disabled') {
      await tui.waitUntil(() => seen(tui.raw).length === 3, { timeoutMs: 10_000, label: 'one notification for the second turn' });
      // Hold the count briefly so a late duplicate would still fail the run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('exactly one notification per completed turn, never more', seen(tui.raw).length === 3);
      assert(wrappedRun ? 'inside tmux nothing arrives bare' : 'outside tmux nothing arrives wrapped', other(tui.raw).length === 0);
      assert(wrappedRun ? 'exactly three passthrough DCS, one per notification' : 'no passthrough DCS outside tmux',
        passthroughs(tui.raw) === (wrappedRun ? 3 : 0));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('zero OSC 9 sequences anywhere with the notification disabled', bareNotifications(tui.raw).length === 0 && wrappedNotifications(tui.raw).length === 0);
      assert('zero passthrough DCS with the notification disabled', passthroughs(tui.raw) === 0);
    }
    assert('the notification never adds a bell (terminalBell stays off here)', bells(tui.raw) === 0);

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('the session exits cleanly', code === 0);
    if (scenario === 'disabled') {
      assert('the disabled run stays notification-free through exit', bareNotifications(tui.raw).length === 0 && wrappedNotifications(tui.raw).length === 0);
    }
  } finally {
    tui.kill();
  }
}

unitContract();
await sourceContract();
await ptyScenario('enabled');
await ptyScenario('enabled-tmux');
await ptyScenario('disabled');
report();
