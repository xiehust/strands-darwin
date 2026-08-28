/**
 * Free checks for the config-gated terminal attention bell (SER-043).
 *
 * Two layers. The unit contract proves `ringTerminalBell` writes exactly one BEL
 * when enabled, performs no write at all when disabled, and never throws for a
 * broken writer. The pty layer launches the real CLI (only model construction is
 * replaced — see `fixtures/terminal-bell-cli.ts`) and counts raw, un-stripped
 * `\x07` bytes: with the bell enabled, exactly one at permission publication and
 * one more per completed turn; with it disabled (the default), zero anywhere —
 * the off path is byte-identical to before the feature existed. No model or
 * network calls.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TERMINAL_BELL, ringTerminalBell } from '../src/tui/terminal-bell.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const HOME = ownPrivateHome('terminal-bell');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/terminal-bell-cli.ts');
const EXIT_TIMEOUT_MS = 20_000;

/** Counts raw BEL bytes; the driver's ANSI stripping never sees them. */
const bells = (raw: string): number => raw.split('\u0007').length - 1;

function unitContract(): void {
  header('terminal bell — unit contract');

  const writes: string[] = [];
  ringTerminalBell(true, (chunk) => writes.push(chunk));
  assert('enabled writes exactly one BEL', writes.length === 1 && writes[0] === TERMINAL_BELL);
  assert('the BEL is the raw \\x07 control byte', TERMINAL_BELL === '\u0007');

  ringTerminalBell(false, (chunk) => writes.push(chunk));
  assert('disabled performs no write at all', writes.length === 1);

  let threw = false;
  try {
    ringTerminalBell(true, () => {
      throw new Error('broken stdout');
    });
  } catch {
    threw = true;
  }
  assert('a broken writer cannot throw out of the bell', !threw);
}

async function writeConfig(bell: boolean): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    // Deliberately invalid: any accidental provider call fails loudly instead of
    // passing this free suite silently.
    model: 'us.anthropic.invalid-terminal-bell-fixture',
    memory: false,
    ...(bell ? { terminalBell: true } : {}),
  }));
}

/**
 * One scripted interactive session: a turn whose tool call publishes a permission
 * prompt (denied with Escape), then a plain second turn. `expected` is the exact
 * bell count after each anchor; the disabled run expects zero throughout.
 */
async function ptyScenario(bell: boolean): Promise<void> {
  header(`terminal bell — pty, terminalBell ${bell ? 'enabled' : 'disabled (default)'}`);
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await writeConfig(bell);

  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 50 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('no BEL before any turn', bells(tui.raw) === 0);

    // Turn 1: the fixture model requests a gated fileEditor write.
    const beforeTurn1 = tui.mark();
    tui.submit('please write the file');
    await tui.waitFor('esc=deny', { from: beforeTurn1, timeoutMs: 60_000 });
    if (bell) {
      await tui.waitUntil(() => bells(tui.raw) === 1, { timeoutMs: 10_000, label: 'one BEL at permission publication' });
      assert('exactly one BEL when the permission prompt is published', bells(tui.raw) === 1);
    } else {
      assert('no BEL at permission publication when disabled', bells(tui.raw) === 0);
    }

    tui.send('\u001b'); // Escape = deny; the model then answers with text.
    await tui.waitFor('bell fixture done', { from: beforeTurn1, timeoutMs: 60_000 });
    if (bell) {
      await tui.waitUntil(() => bells(tui.raw) === 2, { timeoutMs: 10_000, label: 'a second BEL at turn completion' });
      assert('exactly one more BEL when the turn completes', bells(tui.raw) === 2);
    }

    // Turn 2: no tool call, so completion is the only bell moment.
    const beforeTurn2 = tui.mark();
    tui.submit('again');
    await tui.waitFor('bell fixture done', { from: beforeTurn2, timeoutMs: 60_000 });
    if (bell) {
      await tui.waitUntil(() => bells(tui.raw) === 3, { timeoutMs: 10_000, label: 'one BEL for the second turn' });
      // Hold the count briefly so a late duplicate would still fail the run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('exactly one BEL per completed turn, never more', bells(tui.raw) === 3);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert('zero BEL bytes anywhere with the bell disabled', bells(tui.raw) === 0);
    }

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('the session exits cleanly', code === 0);
    if (!bell) {
      assert('the disabled run stays BEL-free through exit', bells(tui.raw) === 0);
    }
  } finally {
    tui.kill();
  }
}

unitContract();
await ptyScenario(true);
await ptyScenario(false);
report();
