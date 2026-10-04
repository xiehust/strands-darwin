/** Real production CLI in a pty: busy ticks must not repaint an unchanged draft. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { assert, header, ownPrivateHome, report } from './shared.js';
import { reconstructTerminalLines } from './terminal-state.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const HOME = ownPrivateHome('working-redraw');
const ROOT = path.join(HOME, 'project');
const DRAFT = 'stable-draft-keep';
const count = (text: string, needle: string): number => text.split(needle).length - 1;

async function main(): Promise<void> {
  header('working redraw — animation does not erase or reprint an unchanged composer');
  await mkdir(ROOT);
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    memory: false, trajectory: false, updateCheck: false,
  }));
  // Warning rows plus long Static history reproduce the viewport-edge cursor
  // bug in Ink's unpatched height-changing incremental path, without a provider.
  for (const directory of ['commands', 'agents', 'skills/commit-message']) {
    await mkdir(path.join(ROOT, '.darwin', directory), { recursive: true });
  }
  await writeFile(path.join(ROOT, '.darwin/commands/COMMIT-MESSAGE.md'), 'must lose to skill\n');
  await writeFile(path.join(ROOT, '.darwin/agents/broken.md'),
    '---\nname: broken\ndescription: Missing a prompt.\ntools: [not-a-tool]\n---\n');
  await writeFile(path.join(ROOT, '.darwin/skills/commit-message/SKILL.md'),
    '---\nname: commit-message\ndescription: Write a commit message.\n---\n\n# Commit message\n');
  const tui = startTui({
    cwd: ROOT, cols: 120, rows: 50,
    entry: path.join(REPO_ROOT, 'spike/fixtures/model-retry-cli.ts'),
    env: { HOME, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
  });
  const visible = () => reconstructTerminalLines(tui.raw, 50).slice(-50).join('\n');
  try {
    await tui.waitFor('you>', { timeoutMs: 30_000 });
    for (let index = 0; index < 3; index += 1) {
      const from = tui.mark();
      tui.submit('/help');
      await tui.waitFor('help — local controls', { from, settleMs: 100 });
    }
    tui.send('/');
    await tui.waitFor('commands (', { settleMs: 150 });
    tui.send('\u001b');
    await tui.waitUntil(() => tui.frame.includes('you> /') && !tui.frame.includes('commands ('), {
      timeoutMs: 5_000, settleMs: 150, label: 'menu shrink preserves the draft after long history',
    });
    assert('height-changing menu shrink keeps the input row and erases the menu',
      visible().includes('you> /') && !visible().includes('commands ('));
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('you> /'), { timeoutMs: 5_000, settleMs: 100 });
    const beforeTyping = tui.raw.length;
    const beforeTypingMark = tui.mark();
    tui.send('typing-probe');
    await tui.waitFor('you> typing-probe', { from: beforeTypingMark, settleMs: 100 });
    // Ready/header text stays visible but should not be emitted again merely
    // because the draft changed. Anchored waits must understand partial paints.
    await tui.waitFor('◆ DARWIN · ready', { from: beforeTypingMark });
    const typing = tui.raw.slice(beforeTyping);
    assert('typing does not repaint the loaded-capabilities or shortcut rows',
      !typing.includes('loaded:') && !typing.includes('/ for actions'));
    assert('typing leaves those stationary header rows visible',
      tui.frame.includes('loaded:') && tui.frame.includes('/ for actions'));
    assert('typing does not erase the whole frame', !typing.includes('\u001b[2K'));
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('typing-probe'), { timeoutMs: 5_000, settleMs: 100 });
    tui.submit('wait for the local fixture');
    await tui.waitFor('throttled, retry 2/2', { timeoutMs: 30_000 });
    tui.send(DRAFT);
    await tui.waitFor(`you> ${DRAFT}`, { settleMs: 150 });
    const start = tui.raw.length;
    // Observe several real 90 ms ticks inside the fixture's bounded 2.5 s wait.
    await delay(650);
    const ticks = tui.raw.slice(start);
    assert('working animation continues through multiple frames', count(ticks, 'DARWIN') >= 3);
    assert('busy ticks never reprint the stationary draft', !ticks.includes(DRAFT));
    assert('busy ticks do not erase the whole live frame', !ticks.includes('\u001b[2K'));
    assert('busy ticks never clear the screen or scrollback', !/\u001b\[(?:2|3)J/.test(ticks));
    assert('the terminal still shows the complete editable draft', visible().includes(`you> ${DRAFT}`));
    assert('the pty driver reconstructs the unchanged draft across partial paints', tui.frame.includes(`you> ${DRAFT}`));
    assert('the hardware cursor remains visible while working', tui.cursorVisible === true);
    assert('the observation stayed inside the same model call',
      (await readFile(path.join(ROOT, 'model-retry-model-calls'), 'utf8')) === '1');

    tui.send('\u0003');
    await tui.waitFor('cancelled during retry wait', { timeoutMs: 10_000, settleMs: 150 });
    assert('cancellation preserves the unsent draft', visible().includes(`you> ${DRAFT}`));
    const idle = tui.raw.length;
    await delay(250);
    assert('animation stops after cancellation', tui.raw.length === idle);
    // Ctrl+U clears the draft; /exit is a local command and makes no model call.
    tui.send('\u0015');
    await tui.waitUntil(() => !visible().includes(DRAFT), { timeoutMs: 5_000, settleMs: 100 });
    assert('the pty driver drops the erased draft rather than retaining an older paint', !tui.frame.includes(DRAFT));
    tui.submit('/exit');
    assert('the session exits cleanly', await tui.exitedWithin(10_000) === 0);
  } finally {
    tui.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  assert('working redraw suite completed', false);
}).finally(report);
