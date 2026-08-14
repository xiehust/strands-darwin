/**
 * End-to-end verification of the Ink TUI through a real pty.
 *
 * Covers what only an interactive run can show: streaming text reaching the
 * screen, the permission prompt appearing with usable detail and actually gating
 * the write, exiting cleanly after a bash command, staying usable after a
 * cancelled turn, slash-command completion, and the local `/usage` report.
 *
 * Waits are anchored with `mark()`. Ink redraws the whole frame constantly, so an
 * unanchored wait for something like `you>` matches a frame from before the
 * action and returns immediately — which silently reads the file before the edit
 * lands, then sends `/exit` while the agent is still streaming (where input is
 * correctly ignored, so the app never exits).
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts [scenario]
 *      scenarios: approve | deny | safePassthrough | bashExit | cancelThenContinue |
 *                 completion | agentsMd | usage
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';

import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
import { assert, header, report } from './shared.js';

/** A TUI that will not exit is a leaked-handle bug, so exits are bounded. */
const EXIT_TIMEOUT_MS = 30_000;

const WORK_DIR = '/tmp/darwin-tui';
/**
 * The gated file lives OUTSIDE the project root on purpose: in the `default`
 * permission mode an in-project edit is statically safe and never prompts, so
 * the approve/deny scenarios gate on an outside-the-project write — one of the
 * calls that still requires confirmation.
 */
const TARGET_DIR = '/tmp/darwin-tui-target';
const TARGET = path.join(TARGET_DIR, 'calc.js');

/** `double` adds instead of multiplying — a one-line fix the model can make. */
const BUGGY = `function double(n) {
  return n + 2;
}
module.exports = { double };
`;

const FIX_REQUEST =
  `The function in ${TARGET} is called double but it adds 2 instead of multiplying by 2. ` +
  `Read the file and fix it with a str_replace edit. Do not run any shell commands.`;

async function resetWorkDir(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await writeFile(TARGET, BUGGY, 'utf8');
}

async function approvePath(): Promise<void> {
  header('TUI — streaming, permission prompt, approved edit');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    // The quit hint, not the product name: `darwin` also occurs in the temp paths
    // this scenario works in, so waiting for or asserting on the name alone would
    // pass without a header ever being drawn.
    await tui.waitFor('/exit to quit', { timeoutMs: 60_000 });
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('TUI rendered its header', tui.screen.includes('/exit to quit'));
    assert('provider and session are shown', /bedrock\/us\.anthropic/.test(tui.screen));
    // On the model line, not a line of its own: the header shares the frame with
    // the permission box, and one extra line pushes the box off a 50-row terminal.
    assert('prompt caching is shown as on', tui.screen.includes('· cache on'));
    assert('the permission mode is shown', tui.screen.includes('mode: default'));

    const turnStart = tui.mark();
    tui.submit(FIX_REQUEST);

    await tui.waitFor('called double but it adds', { timeoutMs: 60_000, from: turnStart });
    assert('user message appears in history', tui.screen.includes('called double but it adds'));

    // Reading the file is a read: it must run without asking.
    await tui.waitFor('fileEditor view', { timeoutMs: 120_000, from: turnStart });
    assert('read tool call was rendered', tui.screen.includes('fileEditor view'));

    await tui.waitFor('permission required', { timeoutMs: 180_000, from: turnStart });
    assert('permission prompt appeared', tui.screen.includes('permission required'));
    assert('prompt is labelled as a write', /permission required\s*\(write\b/.test(tui.screen));
    assert('prompt says why the call was flagged', tui.screen.includes('outside the project'));
    assert('prompt shows the file path', tui.screen.includes(TARGET));
    assert('prompt shows the Path label', tui.screen.includes('Path:'));
    assert('prompt shows the replacement block', tui.screen.includes('With:'));
    assert('prompt offers the y/n choice', tui.screen.includes('allow?'));
    // The permission box replaces the input box, so the newest frame ends with
    // the prompt's y/n line rather than an editable `you>` line.
    assert('input box is replaced while awaiting permission', awaitsPermission(tui.screen));
    assert('assistant text was streamed to the screen', tui.screen.includes('agent'));

    const afterAnswer = tui.mark();
    tui.send('y');

    // A finished write shows as a tool result with the success mark. The prompt's
    // own text also contains "str_replace", hence both the mark and the ✓.
    await tui.waitFor(/✓ fileEditor str_replace/, { timeoutMs: 180_000, from: afterAnswer });
    await waitForIdle(tui, 240_000);

    const after = await readFile(TARGET, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').trim()}`);

    // The model may write either operand order.
    assert('approved edit was applied to disk', /(n\s*\*\s*2|2\s*\*\s*n)/.test(after));
    assert('the bug is gone', !after.includes('n + 2'));
    assert('completed tool call shows a success mark', tui.screen.includes('✓'));

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly on /exit', code === 0);
  } finally {
    tui.kill();
  }
}

async function denyPath(): Promise<void> {
  header('TUI — denied edit leaves the file alone');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const turnStart = tui.mark();
    tui.submit(FIX_REQUEST);
    await tui.waitFor('permission required', { timeoutMs: 180_000, from: turnStart });

    const afterAnswer = tui.mark();
    tui.send('n');

    // Blocked marker on the tool result, then the model's follow-up.
    await tui.waitFor('⊘', { timeoutMs: 120_000, from: afterAnswer });
    await waitForIdle(tui, 240_000);

    const after = await readFile(TARGET, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').trim()}`);

    assert('file was NOT modified after denial', after.includes('n + 2'));
    assert('denied tool call is marked as blocked', tui.screen.includes('⊘'));
    assert(
      'agent explained itself after the denial',
      /den(y|ied)|permission|approv/i.test(tui.screen.slice(afterAnswer)),
    );

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after a denial', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * The other half of the `default` mode contract: statically safe calls must run
 * with NO prompt. An allowlisted command and an in-project edit both complete
 * while the screen never shows the permission box.
 */
async function safePassthrough(): Promise<void> {
  header('TUI — default mode runs safe calls without prompting');

  await resetWorkDir();
  const inProject = path.join(WORK_DIR, 'calc.js');
  await writeFile(inProject, BUGGY, 'utf8');
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // Safe bash: echo is allowlisted, so the command runs straight through.
    const bashTurn = tui.mark();
    tui.submit('Run the shell command `echo darwin-safe-ok` and tell me its output. Run nothing else.');
    await tui.waitFor(/✓ bash/, { timeoutMs: 180_000, from: bashTurn });
    await waitForIdle(tui, 240_000);
    assert('safe bash command completed', tui.screen.slice(bashTurn).includes('darwin-safe-ok'));
    assert(
      'no permission prompt for an allowlisted command',
      !tui.screen.slice(bashTurn).includes('permission required'),
    );

    // Safe write: the file is inside the project root.
    const editTurn = tui.mark();
    tui.submit(
      `The function in ${inProject} is called double but it adds 2 instead of multiplying by 2. ` +
        `Read the file and fix it with a str_replace edit. Do not run any shell commands.`,
    );
    await tui.waitFor(/✓ fileEditor str_replace/, { timeoutMs: 240_000, from: editTurn });
    await waitForIdle(tui, 240_000);

    const after = await readFile(inProject, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').trim()}`);
    assert('in-project edit reached disk', /(n\s*\*\s*2|2\s*\*\s*n)/.test(after));
    assert(
      'no permission prompt for an in-project edit',
      !tui.screen.slice(editTurn).includes('permission required'),
    );

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * Regression for the shutdown hang: a session that has run a bash command must
 * still exit on `/exit`.
 *
 * The other scenarios all tell the model not to run shell commands, which is
 * exactly why they never caught it — the vended bash tool keeps a persistent
 * shell whose stdio pipes hold the event loop open unless it is killed.
 */
async function exitAfterBash(): Promise<void> {
  header('TUI — /exit still works after a bash command');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // `printf` rather than `echo`: echo is on the static safe list now, and this
    // scenario needs a command that still raises the prompt.
    const turnStart = tui.mark();
    tui.submit("Run the shell command `printf 'darwin-bash-ok\\n'` and tell me its output.");
    await tui.waitFor('permission required', { timeoutMs: 180_000, from: turnStart });
    assert('bash run was gated as execute', /permission required\s*\(execute\b/.test(tui.screen));

    const afterAnswer = tui.mark();
    tui.send('y');

    await tui.waitFor(/✓ bash/, { timeoutMs: 180_000, from: afterAnswer });
    assert('command output reached the screen', tui.screen.includes('darwin-bash-ok'));
    await waitForIdle(tui, 240_000);

    // The actual regression: this used to hang forever.
    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after running a bash command', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * Regression for two bugs in the Ctrl+C path, both invisible until a cancelled
 * turn is followed by more work.
 *
 * 1. The permission queue must survive the cancellation. Ctrl+C has to reject
 *    whatever confirmation the agent loop is blocked on, but the session outlives
 *    the turn — closing the queue instead (as an earlier version did) left every
 *    later write and command silently denied with no prompt on screen, which reads
 *    as the model refusing to work.
 * 2. The process must still exit afterwards. A cancelled turn leaks the model's
 *    HTTP socket, so `/exit` hung forever until the CLI grew a forced-exit
 *    backstop — which is why the exit wait here is bounded.
 */
async function cancelThenContinue(): Promise<void> {
  header('TUI — a cancelled turn still leaves permissions working');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // A long answer with no tool use, so there is a streaming window to interrupt.
    const firstTurn = tui.mark();
    tui.submit(
      'Explain in about 400 words why code review matters. Do not use any tools, just write prose.',
    );
    await tui.waitFor('working…', { timeoutMs: 60_000, from: firstTurn });

    const beforeInterrupt = tui.mark();
    tui.send('\u0003'); // ctrl+c mid-turn: cancel this turn, keep the session

    await tui.waitFor('interrupted', { timeoutMs: 60_000, from: beforeInterrupt });
    assert('ctrl+c mid-turn reports an interrupt rather than exiting', true);
    await waitForIdle(tui, 120_000);

    // The actual regression: a gated write in the next turn must still prompt.
    const secondTurn = tui.mark();
    tui.submit(FIX_REQUEST);
    await tui.waitFor('permission required', { timeoutMs: 240_000, from: secondTurn });
    assert('a later turn still raises a permission prompt', true);
    assert(
      'the prompt is still a write confirmation',
      /permission required\s*\(write\b/.test(tui.screen.slice(secondTurn)),
    );

    const afterAnswer = tui.mark();
    tui.send('y');
    await tui.waitFor(/✓ fileEditor str_replace/, { timeoutMs: 240_000, from: afterAnswer });
    await waitForIdle(tui, 240_000);

    const after = await readFile(TARGET, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').trim()}`);
    assert('approval after a cancelled turn still reaches disk', /(n\s*\*\s*2|2\s*\*\s*n)/.test(after));

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after a cancelled turn', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * Completion needs a skills directory, so this runs in the repo root where
 * `.darwin/skills/commit-message` lives. Nothing is submitted, so the agent never
 * runs. The repo also has its own AGENTS.md, which makes this the one scenario
 * that sees the header's preload line.
 */
async function slashCompletion(): Promise<void> {
  header('TUI — slash-command completion');

  const tui = startTui({ cwd: REPO_ROOT });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('skills are advertised in the header', tui.screen.includes('skills: commit-message'));
    assert('the header reports the preloaded AGENTS.md', /AGENTS\.md: loaded \(/.test(tui.screen));

    const beforeSlash = tui.mark();
    tui.send('/');
    await tui.waitFor('skills (', { timeoutMs: 30_000, from: beforeSlash });
    // The list header and its rows can land in separate chunks, so the row has to
    // be waited for rather than asserted straight after the header appears.
    await tui.waitFor('/commit-message', { timeoutMs: 30_000, from: beforeSlash });

    assert('completion list appeared', tui.screen.slice(beforeSlash).includes('skills ('));
    assert(
      'the skill is listed as a command',
      tui.screen.slice(beforeSlash).includes('/commit-message'),
    );
    assert('the list explains the keys', /to select/.test(tui.screen.slice(beforeSlash)));

    // Narrowing to a prefix that matches nothing hides the list again. Ink
    // redraws the whole frame, so the output after the mark is the new frame.
    const beforeNarrow = tui.mark();
    tui.send('zzz');
    // Settle before asserting an absence: a frame still arriving would satisfy
    // "the list is gone" for the wrong reason.
    await tui.waitFor('/zzz', { timeoutMs: 30_000, from: beforeNarrow, settleMs: 400 });
    const redrawn = tui.screen.slice(beforeNarrow);
    console.log(`  frame after /zzz: ${JSON.stringify(redrawn.slice(0, 400))}`);
    assert('completion list disappears when nothing matches', !redrawn.includes('skills ('));

    tui.send('\u0003'); // ctrl+c while idle exits
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('ctrl+c exits when idle', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * An AGENTS.md the model is not getting in full — or not getting at all — has to be
 * visible in the header: rules that were silently trimmed or skipped still read to
 * the user as rules in effect. Nothing is submitted in either case, so this is
 * header rendering only and needs no model call (about a second each).
 */
async function agentsMdHeader(): Promise<void> {
  header('TUI — an oversized AGENTS.md is reported as truncated');

  const dir = '/tmp/darwin-agents-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'AGENTS.md'),
    `# Rules\n\n${`${'padding '.repeat(8)}\n`.repeat(6000)}`,
    'utf8',
  );

  const tui = startTui({ cwd: dir });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const shown = /AGENTS\.md: loaded \(([^)]+)\)/.exec(tui.screen)?.[1];
    console.log(`  header says: AGENTS.md: loaded (${shown})`);

    assert('the header reports the file', shown !== undefined);
    assert('it reports the size on disk', /KB/.test(shown ?? ''));
    assert('it warns that the file was truncated', /truncated to 32 KB/.test(tui.screen));

    tui.send('\u0003'); // ctrl+c while idle exits
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('startup with oversized instructions still exits cleanly', code === 0);
  } finally {
    tui.kill();
  }

  header('TUI — an unreadable AGENTS.md is reported, not passed over in silence');

  // A directory in the file's place: unreadable without a chmod, so the case also
  // holds when the suite runs as root.
  const brokenDir = '/tmp/darwin-agents-tui-broken';
  await rm(brokenDir, { recursive: true, force: true });
  await mkdir(path.join(brokenDir, 'AGENTS.md'), { recursive: true });

  const broken = startTui({ cwd: brokenDir });
  try {
    await broken.waitFor('you>', { timeoutMs: 60_000 });
    const reason = /AGENTS\.md: skipped — (.+)/.exec(broken.screen)?.[1];
    console.log(`  header says: AGENTS.md: skipped — ${reason}`);

    assert('the header says the file was skipped', reason !== undefined);
    assert('it says why', /EISDIR|illegal operation/i.test(reason ?? ''));
    assert('it is not also reported as loaded', !broken.screen.includes('AGENTS.md: loaded'));

    broken.send('\u0003');
    assert('the session starts and exits normally regardless', (await broken.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    broken.kill();
  }
}

/**
 * `/usage` is answered locally from the SDK's meter, so it has four things to
 * prove: the counters start at zero, asking costs no turn of its own, one real
 * turn moves them, and — the reason the report is local at all — it still answers
 * while a turn is streaming. A short prose answer with no tools is enough to move
 * them.
 */
async function usageReport(): Promise<void> {
  header('TUI — /usage reports the run\'s token counts');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('the header advertises the command', tui.screen.includes('/usage for token counts'));

    const beforeBaseline = tui.mark();
    tui.submit('/usage');
    await tui.waitFor('token usage', { timeoutMs: 30_000, from: beforeBaseline, settleMs: 400 });

    const baseline = parseUsage(tui.screen.slice(beforeBaseline));
    console.log(`  baseline: ${JSON.stringify(baseline)}`);
    assert('all four counters are reported', baseline !== undefined);
    assert(
      'nothing is counted before the first turn',
      baseline?.input === 0 && baseline?.output === 0,
    );
    // The whole point of reading the meter instead of asking the model.
    assert('asking did not start a turn', !tui.screen.slice(beforeBaseline).includes('working…'));

    const turn = tui.mark();
    tui.submit('Reply with the single word: ready. Do not use any tools.');
    await tui.waitFor('working…', { timeoutMs: 60_000, from: turn });
    await waitForIdle(tui, 240_000);

    const beforeSecond = tui.mark();
    tui.submit('/usage');
    await tui.waitFor('token usage', { timeoutMs: 30_000, from: beforeSecond, settleMs: 400 });

    const after = parseUsage(tui.screen.slice(beforeSecond));
    console.log(`  after one turn: ${JSON.stringify(after)}`);
    assert('input tokens were counted', (after?.input ?? 0) > 0);
    assert('output tokens were counted', (after?.output ?? 0) > 0);
    // Cache counters are not asserted non-zero: whether a short prompt clears the
    // model's minimum cacheable prefix is the model's business, not this feature's
    // (verify-prompt-cache-live.ts is what proves caching itself).
    assert('cache counters are reported too', after?.cacheRead !== undefined && after?.cacheWrite !== undefined);

    await usageDuringATurn(tui);

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after a usage report', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * The mid-turn half: a long turn is when the cost question actually comes up, and
 * a keyboard that is dead until the agent finishes is what made the command look
 * broken.
 *
 * Counting to sixty is deliberate — the stream has to still be running when the
 * report is asked for, and ordering is how that is proven: the report must appear
 * BEFORE the turn's last word. A prompt typed in the same window must not be sent
 * (the SDK runs one turn at a time) but must say so rather than vanish.
 */
async function usageDuringATurn(tui: TuiSession): Promise<void> {
  const turn = tui.mark();
  tui.submit('Count from 1 to 60 in words, one per line. Do not use any tools.');
  await tui.waitFor('working…', { timeoutMs: 60_000, from: turn });
  assert('the busy hint says /usage still works', tui.screen.includes('/usage reports tokens'));

  const duringTurn = tui.mark();
  tui.submit('/usage');
  await tui.waitFor('token usage', { timeoutMs: 60_000, from: duringTurn, settleMs: 400 });
  const during = parseUsage(tui.screen.slice(duringTurn));
  console.log(`  mid-turn: ${JSON.stringify(during)}`);
  assert('the report is drawn during a streaming turn', during !== undefined);
  // The meter accumulates a model call when it finishes, so these totals exclude
  // the turn being watched — which the report has to say, or unchanged numbers
  // look like a stuck counter.
  assert(
    'the report says the in-flight turn is not counted yet',
    tui.screen.slice(duringTurn).includes('not counted yet'),
  );

  // Anything needing the model waits — with a reason on screen, not silence.
  const beforeQueued = tui.mark();
  tui.submit('this must not be sent mid-turn');
  await tui.waitFor('still working', { timeoutMs: 30_000, from: beforeQueued });
  assert(
    'a prompt typed mid-turn is refused with a reason',
    tui.screen.slice(beforeQueued).includes('still working'),
  );
  // It stays in the draft on purpose, so clear it before /exit is typed into the
  // same line.
  tui.send('\u007f'.repeat(40));

  await tui.waitFor(/sixty/i, { timeoutMs: 240_000, from: turn });
  const region = tui.screen.slice(duringTurn);
  assert(
    'the report came before the turn finished',
    region.indexOf('token usage') < region.search(/sixty/i),
  );
  await waitForIdle(tui, 240_000);
  assert('the turn survived being asked', tui.screen.slice(turn).includes('token usage'));
}

/**
 * Reads the rendered report back into numbers.
 *
 * Takes the LAST match of each label: the report is drawn into a scrollback that
 * already holds every earlier frame, and the header line advertising `/usage`
 * plus the echoed command are on screen too.
 */
function parseUsage(
  screen: string,
): { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined {
  const read = (label: string): number | undefined => {
    const matches = [...screen.matchAll(new RegExp(`${label}\\s+([\\d,]+)`, 'g'))];
    const value = matches[matches.length - 1]?.[1];
    return value === undefined ? undefined : Number(value.replace(/,/g, ''));
  };

  const input = read('input');
  const cacheRead = read('cache read');
  const cacheWrite = read('cache write');
  const output = read('output');
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) {
    return undefined;
  }
  return { input, cacheRead, cacheWrite, output };
}

/**
 * Waits until the newest frame shows an idle prompt.
 *
 * `you>` alone is not enough: the input box renders that text while disabled
 * during a turn too. The `working…` hint is what distinguishes busy from idle, so
 * idleness is "the most recent prompt was drawn after the most recent hint".
 */
async function waitForIdle(tui: TuiSession, timeoutMs: number): Promise<void> {
  await tui.waitUntil((screen) => screen.lastIndexOf('you>') > screen.lastIndexOf('working…'), {
    timeoutMs,
    label: 'an idle prompt',
    // A frame arrives in pieces, so a busy frame read between its prompt line and
    // its `working…` hint reads as idle. Acting on that sends `/exit` mid-turn,
    // where input is correctly ignored, and the app then never exits.
    settleMs: 400,
  });
}

/** True when the newest frame is the permission box rather than the input box. */
function awaitsPermission(screen: string): boolean {
  const tail = screen.trimEnd().slice(-400);
  return tail.includes('allow?') && !/you>\s*$/.test(tail);
}

const SCENARIOS = {
  approve: approvePath,
  deny: denyPath,
  safePassthrough,
  bashExit: exitAfterBash,
  cancelThenContinue,
  completion: slashCompletion,
  agentsMd: agentsMdHeader,
  usage: usageReport,
} as const;

async function main(): Promise<void> {
  const only = process.argv[2];
  const names = (
    only !== undefined && only in SCENARIOS ? [only] : Object.keys(SCENARIOS)
  ) as (keyof typeof SCENARIOS)[];

  for (const name of names) {
    const started = Date.now();
    await SCENARIOS[name]();
    console.log(`  (${name} took ${Math.round((Date.now() - started) / 1000)}s)`);
  }
  report();
}

await main();
