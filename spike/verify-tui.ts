/**
 * End-to-end verification of the Ink TUI through a real pty.
 *
 * Covers what only an interactive run can show: streaming text reaching the
 * screen, the permission prompt appearing with usable detail and actually gating
 * the write, exiting cleanly after a bash command, staying usable after a
 * cancelled turn, slash-command completion, and the local `/tasks` and `/usage` reports.
 *
 * Waits are anchored with `mark()`. Ink redraws the whole frame constantly, so an
 * unanchored wait for something like `you>` matches a frame from before the
 * action and returns immediately — which silently reads the file before the edit
 * lands, then sends `/exit` while the agent is still streaming (where input is
 * correctly ignored, so the app never exits).
 *
 * Every scenario runs against an owned HOME ({@link OWNED_HOME}), so the config,
 * sessions and allow rules under test are this suite's own and never the
 * developer's — see the note there before adding a scenario that reads one.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts [scenario]
 *      scenarios: approve | deny | alwaysAllow | safePassthrough | bashExit |
 *                 cancelThenContinue | multiline | chunkedEnter | compacting | cursor | completion | toolDetails |
 *                 agentsMd | usage | tasks | effort | model | plan | longAnswer | tallDraft |
 *                 tallDraftStreaming
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import path from 'node:path';

import { darwinDir, DARWIN_DIRNAME } from '../src/paths.js';
import { CONFIG_FILENAME, permissionRulesPath } from '../src/config.js';
import { AGENTS_DIRNAME } from '../src/agents/loader.js';
import { COMMANDS_DIRNAME } from '../src/commands/custom-commands.js';
import { SKILLS_DIRNAME } from '../src/skills/loader.js';
import { startTui, type TuiSession } from './tui-driver.js';
import { assert, header, report } from './shared.js';

/** A TUI that will not exit is a leaked-handle bug, so exits are bounded. */
const EXIT_TIMEOUT_MS = 30_000;

const WORK_DIR = '/tmp/darwin-tui';

/**
 * A HOME this suite owns, repointed before anything resolves one.
 *
 * Load-bearing since the config moved to `~/.darwin/config.json`: pty children
 * inherit this process's environment, so without an owned HOME the `effort` and
 * `model` scenarios would rewrite the developer's real config — and read back a
 * project-local file nothing writes any more. Repointing HOME here rather than
 * passing a per-child env override is deliberate: the in-process path helpers
 * (`permissionRulesPath()`, {@link HOME_CONFIG}) then name exactly where the TUI
 * under test writes, which is what makes those assertions faithful.
 */
const OWNED_HOME = '/tmp/darwin-tui-home';
/** The config file the TUI under test reads, inside {@link OWNED_HOME}. */
const HOME_CONFIG = path.join(OWNED_HOME, DARWIN_DIRNAME, CONFIG_FILENAME);
/** How the TUI names that file in a notice — `~` is literal on screen. */
const HOME_CONFIG_LABEL = `~/${DARWIN_DIRNAME}/${CONFIG_FILENAME}`;

const REAL_HOME = os.homedir();
process.env['HOME'] = OWNED_HOME;
// This suite makes real model calls, and an owned HOME hides `~/.aws` from the
// credential chain. Pointed back at the developer's own files (harmless when they
// do not exist, as on an instance role) so isolation cannot cost authentication.
process.env['AWS_CONFIG_FILE'] ??= path.join(REAL_HOME, '.aws', 'config');
process.env['AWS_SHARED_CREDENTIALS_FILE'] ??= path.join(REAL_HOME, '.aws', 'credentials');

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

/** Long path and replacement force both permission headline and detail projection bounds. */
const APPROVE_TARGET_DIR = path.join(TARGET_DIR, 'ser009-' + 'p'.repeat(90), 'nested-' + 'q'.repeat(70));
const APPROVE_TARGET = path.join(APPROVE_TARGET_DIR, 'calc.js');
const APPROVE_PREFIX = 'SER009-DETAIL-PREFIX-';
const APPROVE_REPLACEMENT = `  return n * 2; // ${APPROVE_PREFIX}${'x'.repeat(620)}`;
const APPROVE_EXPECTED = BUGGY.replace('  return n + 2;', APPROVE_REPLACEMENT);
const APPROVE_REQUEST =
  `Read ${APPROVE_TARGET}. Then use fileEditor str_replace to replace exactly \`  return n + 2;\` ` +
  `with exactly \`${APPROVE_REPLACEMENT}\`. Do not run shell commands or make any other edit.`;

const FIX_REQUEST =
  `The function in ${TARGET} is called double but it adds 2 instead of multiplying by 2. ` +
  `Read the file and fix it with a str_replace edit. Do not run any shell commands.`;

async function resetWorkDir(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(APPROVE_TARGET_DIR, { recursive: true });
  await writeFile(TARGET, BUGGY, 'utf8');
  await writeFile(APPROVE_TARGET, BUGGY, 'utf8');
  // Only the config, not the whole owned HOME: sessions live there too, and the
  // `alwaysAllow` scenario deliberately reads back what its first session wrote.
  // Removed rather than left in place so a scenario that says nothing about models
  // really does run on the built-in defaults, whatever an earlier one persisted.
  await mkdir(path.dirname(HOME_CONFIG), { recursive: true });
  await rm(HOME_CONFIG, { force: true });
  // Every scenario shares WORK_DIR, so they share its project key — and an allow
  // rule outlives the directory it was granted in. Left behind, the rule
  // `alwaysAllow` writes silences the permission prompt every later scenario is
  // waiting for. Resolved after the mkdir above: the key canonicalizes through
  // realpath, which needs WORK_DIR to exist.
  await rm(permissionRulesPath(WORK_DIR), { force: true });
}

/** Writes {@link HOME_CONFIG} — the only config the TUI under test will read. */
async function writeHomeConfig(config: unknown): Promise<void> {
  await mkdir(path.dirname(HOME_CONFIG), { recursive: true });
  await writeFile(HOME_CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
    // The inference-profile prefix is deliberately not pinned: this asserts that the
    // header names the provider and a Bedrock Claude model, not which one the
    // built-in defaults happen to select.
    assert('provider and session are shown', /bedrock\/(us|eu|apac|global)\.anthropic\./.test(tui.screen));
    // On the model line, not a line of its own: the header shares the frame with
    // the permission box, and one extra line pushes the box off a 50-row terminal.
    assert('prompt caching is shown as on', tui.screen.includes('· cache on'));
    assert('the permission mode is shown', tui.screen.includes('mode: default'));

    const turnStart = tui.mark();
    tui.submit(APPROVE_REQUEST);
    await tui.waitFor('working…', { timeoutMs: 60_000, from: turnStart });
    const hiddenDraft = 'draft survives permission';
    tui.send(hiddenDraft);
    await tui.waitFor(`you> ${hiddenDraft}`, { timeoutMs: 30_000, from: turnStart, settleMs: 400 });

    await tui.waitFor(APPROVE_TARGET, { timeoutMs: 60_000, from: turnStart });
    assert('user message appears in history', tui.screen.includes(APPROVE_TARGET));

    // Reading the file is a read: it must run without asking.
    await tui.waitFor('fileEditor view', { timeoutMs: 120_000, from: turnStart });
    assert('read tool call was rendered', tui.screen.includes('fileEditor view'));

    // Anchored on the box's LAST line, not its first: 'permission required' is the
    // heading, and a frame arriving in chunks satisfies it while the details and the
    // y/n line are still on their way — which fails the asserts below for a reason
    // that has nothing to do with permissions.
    await tui.waitFor('allow?', { timeoutMs: 180_000, from: turnStart, settleMs: 400 });
    // `frame` is the terminal driver's latest complete Ink repaint, not a match
    // against text retained from an older frame in accumulated pty output.
    const permissionFrame = tui.frame;
    assert('permission prompt appeared in the newest frame', permissionFrame.includes('permission required'));
    assert('prompt is labelled as a write', /permission required\s*\(write\b/.test(permissionFrame));
    assert('source and bounded summary coexist',
      /\[parent\]\s*fileEditor str_replace:[\s\S]*… truncated \d+ code points/.test(permissionFrame));
    assert('prompt says why the call was flagged', permissionFrame.includes('outside the project'));
    assert('detail prefix and explicit marker coexist',
      permissionFrame.includes(APPROVE_PREFIX) && /… truncated \d+ code points/.test(permissionFrame));
    assert('the omitted replacement tail is absent', !permissionFrame.includes('x'.repeat(200)));
    assert('prompt keeps detail labels', permissionFrame.includes('Path:') && permissionFrame.includes('With:'));
    assert('prompt offers y and n on the reachable decision row', /allow\?\s+y\s+n/.test(permissionFrame));
    // The wildcard offers stay on the same row as y/n so all decision keys remain
    // reachable without adding another row to the 50-row frame.
    assert('prompt offers the narrow wildcard rule', permissionFrame.includes('always: a=/tmp/darwin-tui-target/…'));
    assert('prompt offers the whole tool as well', permissionFrame.includes('A=all fileEditor'));

    assert('input box is replaced while awaiting permission', awaitsPermission(permissionFrame));
    assert('assistant text was streamed to the screen', tui.screen.includes('agent'));

    // The permission box owns every keyboard and paste event. Use ignored keys
    // only: decision keys would correctly answer the prompt instead.
    tui.send('blocked\u001b[D\u007f\u001b[200~PASTED\u001b[201~');
    const afterAnswer = tui.mark();
    tui.send('y');
    await tui.waitFor(`you> ${hiddenDraft}`, { timeoutMs: 60_000, from: afterAnswer, settleMs: 400 });
    assert('permission-time keyboard and paste leave the hidden draft exact', tui.frame.includes(`you> ${hiddenDraft}`));
    assert('permission-time text never enters the restored draft', !tui.frame.includes('blocked') && !tui.frame.includes('PASTED'));

    // The exact disk content below is the approval proof. Wait for the turn to
    // finish rather than for an immutable tool row that may have scrolled off 50 rows.
    await waitForIdle(tui, 240_000);

    const after = await readFile(APPROVE_TARGET, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').slice(0, 160)}…`);

    assert('approved edit was applied exactly to disk', after === APPROVE_EXPECTED);
    assert('the bug is gone', !after.includes('n + 2'));

    tui.send('\u0015'); // ctrl+u clears the retained permission-ownership draft
    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly on /exit', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * The wildcard path: answering with `a` approves the call AND writes the rule to
 * the project-keyed `permission-rules.json` under `~/.darwin`, so the same kind
 * of call is never asked about again.
 *
 * Model-driven, because the permission box only exists inside a turn — but the
 * assertions are on the notice, the file on disk, and (after a restart) the
 * absence of a second prompt, none of which depend on what the model chose to do
 * beyond making the one gated write.
 */
async function alwaysAllowRule(): Promise<void> {
  header('TUI — "always allow" writes a rule and stops asking');

  await resetWorkDir();
  // Resolved after resetWorkDir(): the project key canonicalizes through
  // realpath, which needs WORK_DIR to exist. The scenario child inherits this
  // process's HOME, so computing the path in-process is faithful to where the
  // TUI under test actually writes. resetWorkDir() has already removed it — the
  // second session below asserts exactly one rule is live, so a rule left by an
  // earlier scenario or an earlier run would fail that.
  const rulesFile = permissionRulesPath(WORK_DIR);
  const tui = startTui({ cwd: WORK_DIR });
  const expectedRule = `fileEditor:${TARGET_DIR}/**`;

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const turnStart = tui.mark();
    tui.submit(FIX_REQUEST);
    await tui.waitFor('allow?', { timeoutMs: 180_000, from: turnStart, settleMs: 400 });

    const afterAnswer = tui.mark();
    tui.send('a');

    await tui.waitFor('always allowing', { timeoutMs: 120_000, from: afterAnswer });
    assert(
      'the accepted rule is reported with the file it went to',
      tui.screen.slice(afterAnswer).includes(`always allowing ${expectedRule} — saved to`),
    );

    await tui.waitFor(/✓ fileEditor str_replace/, { timeoutMs: 180_000, from: afterAnswer });
    await waitForIdle(tui, 240_000);

    const written = await readFile(rulesFile, 'utf8');
    console.log(`  rules file now: ${written.replace(/\s+/g, ' ').trim()}`);
    assert(
      'the rule was persisted to the project-keyed permission-rules.json',
      (JSON.parse(written) as { allow?: string[] }).allow?.includes(expectedRule) === true,
    );

    tui.submit('/exit');
    assert('TUI exited cleanly after saving a rule', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  // Second session, same directory: the rule is loaded from the rules file, so
  // the same write must now run unprompted — and the header must say a rule is
  // live.
  await writeFile(TARGET, BUGGY, 'utf8');
  const resumed = startTui({ cwd: WORK_DIR });

  try {
    await resumed.waitFor('you>', { timeoutMs: 60_000 });
    assert('the header reports the loaded rule', /mode: default · 1 allow rule/.test(resumed.screen));

    const turnStart = resumed.mark();
    resumed.submit(FIX_REQUEST);
    await resumed.waitFor(/✓ fileEditor str_replace/, { timeoutMs: 180_000, from: turnStart });
    await waitForIdle(resumed, 240_000);

    assert(
      'the covered write was never asked about again',
      !resumed.screen.slice(turnStart).includes('permission required'),
    );
    const after = await readFile(TARGET, 'utf8');
    assert('the unprompted edit landed on disk', /(n\s*\*\s*2|2\s*\*\s*n)/.test(after));

    resumed.submit('/exit');
    assert('TUI exited cleanly in the second session', (await resumed.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    resumed.kill();
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
 * Multiline composition is entirely local: bracketed paste and explicit newline
 * bindings must redraw the draft without spending a model call, while plain Enter
 * keeps its submit meaning. `/exit` makes that last contract cheap to prove.
 */
async function multilineInput(): Promise<void> {
  header('TUI — multiline paste and manual newlines');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const beforePaste = tui.mark();
    tui.send('\u001b[200~paste-alpha\r\npaste-beta\u001b[201~');
    await tui.waitFor('...> paste-beta', { timeoutMs: 30_000, from: beforePaste, settleMs: 400 });
    const pasted = tui.screen.slice(beforePaste);
    assert('bracketed paste keeps the first line', pasted.includes('you> paste-alpha'));
    assert('bracketed paste keeps and renders the second line', pasted.includes('...> paste-beta'));
    assert('pasting multiline text does not submit it', !pasted.includes('working…'));

    const beforeCtrlJ = tui.mark();
    tui.send('\n');
    await tui.waitFor('...> ', { timeoutMs: 30_000, from: beforeCtrlJ, settleMs: 400 });
    tui.send('ctrlj-gamma');
    await tui.waitFor('...> ctrlj-gamma', { timeoutMs: 30_000, from: beforeCtrlJ, settleMs: 400 });
    assert('ctrl+j inserts a visible newline', tui.screen.slice(beforeCtrlJ).includes('...> ctrlj-gamma'));

    tui.send('\\');
    await tui.waitFor('ctrlj-gamma\\', { timeoutMs: 30_000, settleMs: 400 });
    const beforeBackslashEnter = tui.mark();
    // Keep Enter and following text in one pty write. Real terminals may batch
    // them into one Ink event as `\rslash-delta`; that path must consume the
    // continuation marker before inserting the following text.
    tui.send('\rslash-delta');
    await tui.waitFor('...> slash-delta', {
      timeoutMs: 30_000,
      from: beforeBackslashEnter,
      settleMs: 400,
    });
    const continued = tui.screen.slice(beforeBackslashEnter);
    assert('backslash plus Enter inserts a newline', continued.includes('...> slash-delta'));
    assert(
      'the continuation backslash is consumed',
      /\.\.\.> ctrlj-gamma\r?\n\.\.\.> slash-delta/.test(continued),
    );
    assert('manual newlines do not submit the draft', !continued.includes('working…'));

    // Backspace remains append-only, but it must be able to cross a line boundary.
    const beforeJoin = tui.mark();
    tui.send('\n\u007f-joined');
    await tui.waitFor('...> slash-delta-joined', { timeoutMs: 30_000, from: beforeJoin, settleMs: 400 });
    assert('backspace can remove a draft newline', tui.screen.slice(beforeJoin).includes('slash-delta-joined'));

    // Clear the draft, then prove ordinary Enter still submits a local command.
    tui.send('\u007f'.repeat(100));
    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('plain Enter still submits', code === 0);
  } finally {
    tui.kill();
  }
}

/** CRLF may arrive in the same stdin event as text; it must still submit once. */
async function chunkedEnter(): Promise<void> {
  header('TUI — batched text plus CRLF submits');

  const dir = '/tmp/darwin-chunked-enter-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const continuationTui = startTui({ cwd: dir });

  try {
    await continuationTui.waitFor('you>', { timeoutMs: 60_000 });

    const beforeContinuation = continuationTui.mark();
    continuationTui.submitChunk('/exit\\');
    await continuationTui.waitFor('...> ', {
      timeoutMs: 30_000,
      from: beforeContinuation,
      settleMs: 400,
    });
    const continuation = continuationTui.screen.slice(beforeContinuation);
    assert('batched CRLF keeps backslash continuation semantics', continuation.includes('you> /exit'));
    assert('batched continuation does not submit', !continuation.includes('working…'));

    // If the backslash was consumed, the complete draft trims to `/exit`. If it
    // survived, this would send `/exit\\` to the model and the process would stay up.
    continuationTui.send('\r');
    const continuationCode = await continuationTui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('batched continuation consumes the backslash', continuationCode === 0);
  } finally {
    continuationTui.kill();
  }

  const submitTui = startTui({ cwd: dir });
  try {
    await submitTui.waitFor('you>', { timeoutMs: 60_000 });
    submitTui.submitCrLf('/exit');
    const code = await submitTui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('text and CRLF in one write submits exactly once', code === 0);
  } finally {
    submitTui.kill();
  }
}

/** Compaction owns a disabled editor: keyboard and paste cannot create a draft. */
async function compactingInputOwnership(): Promise<void> {
  header('TUI — compaction owns keyboard and paste input');

  await resetWorkDir();
  await writeHomeConfig({ preserveRecentMessages: 0 });
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const seedTurn = tui.mark();
    tui.submit('Reply with exactly COMPACT_SEED. Do not use tools.');
    await tui.waitFor('COMPACT_SEED', { timeoutMs: 240_000, from: seedTurn });
    await waitForIdle(tui, 240_000);

    const compact = tui.mark();
    tui.submit('/compact');
    await tui.waitFor('compacting conversation…', { timeoutMs: 60_000, from: compact, settleMs: 400 });
    assert('the compacting editor hides the terminal cursor', tui.cursorVisible === false);

    tui.send('blocked-keys\u001b[D\u007f');
    tui.send('\u001b[200~blocked-paste\u001b[201~');
    await tui.waitFor(/conversation (?:compacted|already compact)/, {
      timeoutMs: 240_000,
      from: compact,
      settleMs: 400,
    });
    await tui.waitFor('you>', { timeoutMs: 30_000, from: compact, settleMs: 400 });
    assert('keyboard input is ignored throughout compaction', !tui.frame.includes('blocked-keys'));
    assert('paste input is ignored throughout compaction', !tui.frame.includes('blocked-paste'));
    assert('the editor returns empty and editable after compaction', /you>\s*(?:\r?\n|$)/.test(tui.frame) && tui.cursorVisible === true);

    tui.submit('/exit');
    assert('TUI exits cleanly after compaction input ownership', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

/** Keyboard cursor editing is local and makes no model call. */
async function cursorEditing(): Promise<void> {
  header('TUI — keyboard cursor editing');

  const dir = '/tmp/darwin-cursor-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tui = startTui({ cwd: dir, cols: 40, rows: 20 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    let mark = tui.mark();
    tui.send('ac\u001b[Db');
    await tui.waitFor('you> abc', { timeoutMs: 30_000, from: mark, settleMs: 400 });
    assert('left arrow moves insertion before the final character', tui.screen.slice(mark).includes('you> abc'));
    assert('mouse tracking stays disabled for native selection and scrollback', !tui.raw.includes('[?1000h') && !tui.raw.includes('[?1006h'));

    mark = tui.mark();
    tui.send('\u001b[H>\u001b[F<');
    await tui.waitFor('you> >abc<', { timeoutMs: 30_000, from: mark, settleMs: 400 });
    assert('home and end address the visible row edges', tui.screen.slice(mark).includes('you> >abc<'));

    mark = tui.mark();
    tui.send('\u001b[D\u001b[D\u001b[3~');
    await tui.waitFor('you> >ab<', { timeoutMs: 30_000, from: mark, settleMs: 400 });
    assert('delete removes the grapheme after the cursor', tui.screen.slice(mark).includes('you> >ab<'));

    tui.send('\u0004');

    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('cursor scenario exits cleanly', code === 0);
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Completion uses a temporary project with one skill, one custom command, and a
 * colliding command. Nothing is submitted, so this makes no model call.
 */
async function slashCompletion(): Promise<void> {
  header('TUI — slash-command completion');

  const dir = '/tmp/darwin-completion-tui';
  const stateDir = darwinDir(dir);
  const commandsDir = path.join(stateDir, COMMANDS_DIRNAME);
  const agentsDir = path.join(stateDir, AGENTS_DIRNAME);
  const skillDir = path.join(stateDir, SKILLS_DIRNAME, 'commit-message');
  await rm(dir, { recursive: true, force: true });
  await mkdir(commandsDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(commandsDir, 'review.md'), 'Review $ARGUMENTS.\n', 'utf8');
  await writeFile(path.join(commandsDir, 'COMMIT-MESSAGE.md'), 'must lose to skill\n', 'utf8');
  await writeFile(
    path.join(agentsDir, 'broken.md'),
    '---\nname: broken\ndescription: Missing a prompt.\ntools: [not-a-tool]\n---\n',
    'utf8',
  );

  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: commit-message\ndescription: Write a commit message.\n---\n\n# Commit message\n',
    'utf8',
  );

  const tui = startTui({ cwd: dir });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    await tui.waitFor('skill /commit-message', { timeoutMs: 30_000, settleMs: 400 });
    assert(
      'skills are advertised in the header after required built-ins',
      tui.screen.includes('skills: developer, self-evolution-research, commit-message'),
    );
    assert(
      'a command colliding with a skill is warned and skipped',
      tui.screen.includes('command skipped:') && tui.screen.includes('skill /commit-message'),
    );
    assert(
      'an invalid custom agent is warned and skipped',
      tui.screen.includes('agent skipped:') && tui.screen.includes('agent system prompt is empty'),
    );


    const beforeTasks = tui.mark();
    tui.submit('/tasks');
    await tui.waitFor('background tasks — none in this run', { timeoutMs: 30_000, from: beforeTasks, settleMs: 400 });
    const emptyTasks = tui.screen.slice(beforeTasks);
    assert('/tasks reports an explicit empty current-run state without starting a turn', emptyTasks.includes('background tasks — none in this run') && !emptyTasks.includes('working…'));

    const beforeTasksArgument = tui.mark();
    tui.submit('/tasks extra');
    await tui.waitFor('/tasks takes no arguments', { timeoutMs: 30_000, from: beforeTasksArgument, settleMs: 400 });
    assert('/tasks rejects arguments without starting a turn', !tui.screen.slice(beforeTasksArgument).includes('working…'));

    const beforeTasksTabArgument = tui.mark();
    tui.submit('/tasks\textra');
    await tui.waitFor('/tasks takes no arguments', { timeoutMs: 30_000, from: beforeTasksTabArgument, settleMs: 400 });
    assert('/tasks rejects non-space argument separators locally', !tui.screen.slice(beforeTasksTabArgument).includes('working…'));

    // The trajectory report: a local read of the recorder's own counters, so it must
    // answer without a model call, and must name the file something else can read.
    const beforeTrajectory = tui.mark();
    tui.submit('/trajectory');
    await tui.waitFor('trajectory: recording', { timeoutMs: 30_000, from: beforeTrajectory, settleMs: 400 });
    const trajectoryReport = tui.screen.slice(beforeTrajectory);
    assert(
      '/trajectory reports the record without starting a turn',
      trajectoryReport.includes('trajectory: recording') && !trajectoryReport.includes('working…'),
    );
    assert('/trajectory names the file it is appending to', trajectoryReport.includes('trajectory.jsonl'));
    assert('/trajectory says how to replay the session', trajectoryReport.includes('darwin trajectory replay'));

    const beforeTrajectoryArgument = tui.mark();
    tui.submit('/trajectory extra');
    await tui.waitFor('/trajectory takes no arguments', { timeoutMs: 30_000, from: beforeTrajectoryArgument, settleMs: 400 });
    assert(
      '/trajectory rejects arguments without starting a turn',
      !tui.screen.slice(beforeTrajectoryArgument).includes('working…'),
    );

    const beforeSlash = tui.mark();
    tui.send('/');
    await tui.waitFor('commands (', { timeoutMs: 30_000, from: beforeSlash });
    // The six-row menu truncates the full catalogue, so narrow once for each
    // project-defined kind rather than mistaking warning/header text for a row.
    const beforeCustom = tui.mark();
    tui.send('r');
    await tui.waitFor('❯ /review', { timeoutMs: 30_000, from: beforeCustom, settleMs: 400 });
    assert('the custom command is listed', tui.screen.slice(beforeCustom).includes('❯ /review'));

    const beforeSkill = tui.mark();
    tui.send('\u007fc');
    await tui.waitFor('  /commit-message', { timeoutMs: 30_000, from: beforeSkill, settleMs: 400 });
    const skillRows = tui.screen.slice(beforeSkill);
    assert('the skill is listed as a command', skillRows.includes('  /commit-message'));
    assert('a colliding custom command is not duplicated', skillRows.match(/  \/commit-message/gi)?.length === 1);

    const beforeAll = tui.mark();
    tui.send('\u007f');
    await tui.waitFor('❯ /agents', { timeoutMs: 30_000, from: beforeAll, settleMs: 400 });
    const completed = tui.screen.slice(beforeSlash);
    assert('completion list appeared', completed.includes('commands ('));
    // The built-ins are listed too, and first: a command that only appears in the
    // header hint is one nobody finds. Matched on the row markers ('❯ ' for the
    // selected row, two spaces otherwise) — a bare '/exit' also occurs in the
    // header line, so it would pass with no list on screen at all.
    assert('the built-ins are listed first', completed.includes('❯ /agents'));
    assert('the built-in /compact is listed', completed.includes('  /compact'));
    assert('the built-in /effort is listed', completed.includes('  /effort'));
    assert('the built-in /exit is listed', completed.includes('  /exit'));
    assert('the built-in /tasks is listed', completed.includes('  /tasks'));
    assert('the built-in /trajectory is listed', completed.includes('  /trajectory'));
    assert('the built-in /usage is listed', completed.includes('  /usage'));
    assert(
      'runtime completion order is built-ins, custom commands, then skills',
      completed.indexOf('/review') < completed.lastIndexOf('/commit-message'),
    );
    assert('the list explains the keys', /to select/.test(completed));

    // Narrowing to a prefix that matches nothing hides the list again. Ink
    // redraws the whole frame, so the output after the mark is the new frame.
    const beforeNarrow = tui.mark();
    tui.send('zzz');
    // Settle before asserting an absence: a frame still arriving would satisfy
    // "the list is gone" for the wrong reason.
    await tui.waitFor('/zzz', { timeoutMs: 30_000, from: beforeNarrow, settleMs: 400 });
    const redrawn = tui.screen.slice(beforeNarrow);
    console.log(`  frame after /zzz: ${JSON.stringify(redrawn.slice(0, 400))}`);
    assert('completion list disappears when nothing matches', !redrawn.includes('commands ('));

    tui.send('\u0003'); // ctrl+c while idle exits
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('ctrl+c exits when idle', code === 0);
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Zero-model proof that Ctrl+B is display-only and preserves the prompt draft. */
async function toolDetailsToggle(): Promise<void> {
  header('TUI — Ctrl+B toggles tool details without editing the draft');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const draft = 'draft stays here';
    tui.send(draft);
    await tui.waitFor(`you> ${draft}`, { timeoutMs: 30_000, settleMs: 400 });

    const beforeExpanded = tui.mark();
    tui.send('\u0002'); // ctrl+b
    await tui.waitFor('tool details: expanded', {
      timeoutMs: 30_000,
      from: beforeExpanded,
      settleMs: 400,
    });
    assert('Ctrl+B reports expanded mode', tui.screen.slice(beforeExpanded).includes('tool details: expanded'));
    assert('expanding preserves the existing draft', tui.screen.slice(beforeExpanded).includes(`you> ${draft}`));

    const beforeCompact = tui.mark();
    tui.send('\u0002');
    await tui.waitFor('tool details: compact', {
      timeoutMs: 30_000,
      from: beforeCompact,
      settleMs: 400,
    });
    assert('Ctrl+B reports compact mode', tui.screen.slice(beforeCompact).includes('tool details: compact'));
    assert('compacting still preserves the existing draft', tui.screen.slice(beforeCompact).includes(`you> ${draft}`));
    assert('the toggle never starts a model turn', !tui.screen.slice(beforeExpanded).includes('working…'));

    tui.send('\u007f'.repeat(draft.length));
    tui.submit('/exit');
    assert('TUI exits cleanly after detail toggles', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

/**
 * Zero-model proof that dispatch state is observable from the TUI.
 *
 * `/agents` reads the runtime's dispatch registry the way `/tasks` reads the
 * background manager: locally, mid-turn or idle, without a model call. The empty
 * wording is asserted verbatim because it is the one thing that keeps this report
 * from being read as the *catalogue* of definitions the header advertises.
 */
async function agentDispatches(): Promise<void> {
  header('TUI — /agents reports dispatch state without a model call');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const beforeEmpty = tui.mark();
    tui.submit('/agents');
    await tui.waitFor('subagent dispatches — none in this run', {
      timeoutMs: 30_000,
      from: beforeEmpty,
      settleMs: 400,
    });
    const empty = tui.screen.slice(beforeEmpty);
    assert(
      '/agents reports an explicit empty current-run state without starting a turn',
      empty.includes('subagent dispatches — none in this run') && !empty.includes('working…'),
    );
    assert(
      'the empty report cannot be mistaken for the agent catalogue',
      !empty.includes('subagent dispatches — this run'),
    );

    const beforeArgument = tui.mark();
    tui.submit('/agents extra');
    await tui.waitFor('/agents takes no arguments', { timeoutMs: 30_000, from: beforeArgument, settleMs: 400 });
    assert(
      '/agents rejects arguments without starting a turn',
      !tui.screen.slice(beforeArgument).includes('working…'),
    );

    const beforeTabArgument = tui.mark();
    tui.submit('/agents\textra');
    await tui.waitFor('/agents takes no arguments', { timeoutMs: 30_000, from: beforeTabArgument, settleMs: 400 });
    assert(
      '/agents rejects non-space argument separators locally',
      !tui.screen.slice(beforeTabArgument).includes('working…'),
    );

    const beforeCompletion = tui.mark();
    tui.send('/age');
    await tui.waitFor('❯ /agents', { timeoutMs: 30_000, from: beforeCompletion, settleMs: 400 });
    assert(
      '/agents is discoverable in the completion menu',
      tui.screen.slice(beforeCompletion).includes('list subagent dispatches'),
    );

    tui.send('\u007f'.repeat(4));
    tui.submit('/exit');
    assert('TUI exits cleanly after reading dispatch state', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
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
    // This scenario uses the default Bedrock model, whose four numeric buckets
    // remain the compatibility contract. Whether either cache count is non-zero
    // is the model's business (verify-prompt-cache-live.ts proves caching itself).
    assert('Bedrock cache counters are reported too', after?.cacheRead !== undefined && after?.cacheWrite !== undefined);

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
 * BEFORE the turn's last word. An edited prompt in the same window must be retained,
 * not queued; after idle it starts only when Enter is pressed a second time.
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

  const retainedDraft = 'Reply with exactly SECOND_TURN_DONE. Do not use tools.';
  const beforeEdit = tui.mark();
  tui.send('Reply with exactly SECOND_TURN_DNE. Do not use tools.');
  // Move before "DNE" and insert the missing O: terminal-observable proof that
  // the streaming editor is active at its cursor, not merely appendable.
  tui.send('\u001b[D'.repeat(21));
  tui.send('O');
  await tui.waitFor(`you> ${retainedDraft}`, {
    timeoutMs: 30_000,
    from: beforeEdit,
    settleMs: 400,
  });
  assert('cursor-position editing works while streaming', tui.frame.includes(`you> ${retainedDraft}`));
  assert('Ink leaves the terminal cursor visible while streaming', tui.cursorVisible === true);

  // Anything needing the model waits — with a reason on screen, not silence.
  const beforeRefused = tui.mark();
  tui.send('\r');
  await tui.waitFor('still working', { timeoutMs: 30_000, from: beforeRefused, settleMs: 400 });
  assert('a prompt typed mid-turn is refused with a reason', tui.screen.slice(beforeRefused).includes('still working'));
  assert('the refused prompt remains exact in the editor', tui.frame.includes(`you> ${retainedDraft}`));

  await tui.waitFor(/sixty/i, { timeoutMs: 240_000, from: turn });
  const region = tui.screen.slice(duringTurn);
  assert(
    'the report came before the turn finished',
    region.indexOf('token usage') < region.search(/sixty/i),
  );
  await waitForIdle(tui, 240_000);
  assert('the turn survived being asked', tui.screen.slice(turn).includes('token usage'));
  assert('the retained prompt is still exact after the original turn', tui.frame.includes(`you> ${retainedDraft}`));

  // A queue would start by itself as soon as status returns to idle. Hold a quiet
  // interval and inspect output after the mark before explicitly submitting.
  const idleMark = tui.mark();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert('the retained prompt is not automatically sent after idle', !tui.screen.slice(idleMark).includes('working…'));

  const secondTurn = tui.mark();
  tui.send('\r');
  await tui.waitFor('working…', { timeoutMs: 60_000, from: secondTurn });
  await tui.waitFor('SECOND_TURN_DONE', { timeoutMs: 240_000, from: secondTurn });
  await waitForIdle(tui, 240_000);
  assert('explicit Enter starts and completes the retained second turn', tui.screen.slice(secondTurn).includes('SECOND_TURN_DONE'));
}


/**
 * Real model/pty coverage for task notices and a local list read during streaming.
 * The model starts manager-owned jobs through the real bash tool; no test-only
 * registry access is involved.
 */
async function taskMonitoring(): Promise<void> {
  header('TUI — background task monitoring');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR, args: ['--yolo'] });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const idleMarker = path.join(WORK_DIR, 'release-idle-task');
    const successTurn = tui.mark();
    tui.submit(`Use bash start to run exactly \`while [ ! -f ${idleMarker} ]; do sleep .1; done; printf 'task-notice-ok\\n'\`, then immediately finish your answer without waiting or calling bash status/output.`);
    await tui.waitFor(/✓ bash/, { timeoutMs: 180_000, from: successTurn });
    await waitForIdle(tui, 240_000);
    const idleStart = tui.mark();
    await writeFile(idleMarker, 'release');

    await tui.waitFor(' succeeded in ', { timeoutMs: 30_000, from: idleStart, settleMs: 400 });
    assert('a successful task completion appears while idle without further input', tui.screen.slice(idleStart).includes('background task bg-'));

    const streamingMarker = path.join(WORK_DIR, 'release-streaming-task');
    const failureTurn = tui.mark();
    tui.submit(`Use bash start to run exactly \`while [ ! -f ${streamingMarker} ]; do sleep .1; done; exit 7\`, then immediately finish your answer without waiting or calling bash status/output.`);
    await tui.waitFor(/✓ bash/, { timeoutMs: 180_000, from: failureTurn });
    await waitForIdle(tui, 240_000);

    const streamingTurn = tui.mark();
    tui.submit('Write the numbers 1 through 80 in words, one per line, then end with the exact marker TASK_TURN_COMPLETE. Do not use any tools.');
    await tui.waitFor('working…', { timeoutMs: 60_000, from: streamingTurn });
    const duringTurn = tui.mark();
    tui.submit('/tasks');
    await tui.waitFor('background tasks — this run (2)', { timeoutMs: 60_000, from: duringTurn, settleMs: 400 });
    assert('/tasks renders during a streaming turn', tui.screen.slice(duringTurn).includes('succeeded') && tui.screen.slice(duringTurn).includes('running'));
    await writeFile(streamingMarker, 'release');
    await tui.waitFor('failed (exit 7)', { timeoutMs: 30_000, from: duringTurn, settleMs: 400 });
    assert('a completion notice appears during streaming with failure metadata', tui.screen.slice(duringTurn).includes('background task bg-'));
    await tui.waitFor('TASK_TURN_COMPLETE', { timeoutMs: 240_000, from: duringTurn });
    const streamingRegion = tui.screen.slice(duringTurn);
    assert('/tasks and completion both appear before the active turn completes', streamingRegion.indexOf('background tasks —') < streamingRegion.indexOf('TASK_TURN_COMPLETE') && streamingRegion.indexOf('failed (exit 7)') < streamingRegion.indexOf('TASK_TURN_COMPLETE'));
    await waitForIdle(tui, 240_000);

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exits cleanly after monitored background tasks', code === 0);
  } finally {
    tui.kill();
  }
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

/**
 * `/effort` has to prove four things a unit test cannot: the level reaches the
 * header, changing it costs no turn, the change is written to
 * `~/.darwin/config.json` where the next session will read it, and a level the
 * model cannot serve is clamped visibly instead of failing the next request.
 *
 * Pins `us.anthropic.claude-sonnet-4-6` in {@link HOME_CONFIG} rather than leaning
 * on the built-in defaults: the clamp is only observable on a model that serves
 * adaptive thinking but not `xhigh`, and the default model is an Opus-tier one that
 * accepts the whole ladder. Writing the config also proves `/effort` edits a file
 * the user already has, not just one it creates.
 */
async function effortCommand(): Promise<void> {
  header('TUI — /effort sets thinking depth');

  await resetWorkDir();
  // Flat form on purpose: `/effort` then has to write the root key, which is the
  // shape a first-time user's file has.
  await writeHomeConfig({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6' });
  const tui = startTui({ cwd: WORK_DIR });
  const configFile = HOME_CONFIG;

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    // On the model line, not a line of its own: the header shares the frame with
    // the permission box, and one extra line pushes the box off a 50-row terminal.
    assert('the default level is shown in the header', tui.screen.includes('· effort high'));
    assert('the header advertises the command', tui.screen.includes('/effort sets thinking depth'));

    const beforeReport = tui.mark();
    tui.submit('/effort');
    await tui.waitFor('thinking effort: high', { timeoutMs: 30_000, from: beforeReport, settleMs: 400 });
    assert('a bare /effort reports the level', tui.screen.slice(beforeReport).includes('thinking effort: high'));
    // The point of answering locally: asking must not spend a model call.
    assert('asking did not start a turn', !tui.screen.slice(beforeReport).includes('working…'));

    const beforeSet = tui.mark();
    tui.submit('/effort low');
    await tui.waitFor('saved to', { timeoutMs: 30_000, from: beforeSet, settleMs: 400 });
    assert('the new level is confirmed', tui.screen.slice(beforeSet).includes('thinking effort: low'));
    assert('…and reported as persisted', tui.screen.slice(beforeSet).includes(`saved to ${HOME_CONFIG_LABEL}`));
    assert('the header follows the change', tui.screen.slice(beforeSet).includes('· effort low'));

    const saved = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    console.log(`  written config: ${JSON.stringify(saved)}`);
    assert('the level reached the config file', saved['thinkingEffort'] === 'low');

    // Sonnet 4.6 does not serve xhigh. Sending it anyway would fail every
    // subsequent request, so the clamp has to be both applied and stated.
    const beforeClamp = tui.mark();
    tui.submit('/effort xhigh');
    await tui.waitFor('Opus only', { timeoutMs: 30_000, from: beforeClamp, settleMs: 400 });
    const clamped = tui.screen.slice(beforeClamp);
    assert('an Opus-only level is clamped', clamped.includes('Opus only'));
    // Sliced, not searched whole: the startup frame said 'effort high' too, so the
    // assertion would pass without the clamp ever reaching the header.
    assert('the header shows what will actually happen', clamped.includes('· effort high'));

    const beforeBad = tui.mark();
    tui.submit('/effort turbo');
    await tui.waitFor('is not a thinking effort level', { timeoutMs: 30_000, from: beforeBad, settleMs: 400 });
    const refused = tui.screen.slice(beforeBad);
    assert('an unknown level is refused', refused.includes('is not a thinking effort level'));
    assert('…listing the valid ones', refused.includes('low, medium, high, xhigh, max'));
    assert('…and changing nothing', refused.includes('(unchanged)'));
    // A refused command must not reach the model as a prompt either.
    assert('a bad level did not start a turn', !refused.includes('working…'));

    // The level was clamped, but xhigh is what the user asked for, so xhigh is what
    // gets remembered — the same file on an Opus model should give them xhigh.
    const afterClamp = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    assert('the requested level is what was persisted', afterClamp['thinkingEffort'] === 'xhigh');

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after changing effort', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * `/model` has to prove five things a unit test cannot: the catalogue reaches the
 * screen with the live entry marked, switching costs no turn, the header follows
 * the switch, the new switch state is written to `~/.darwin/config.json`, and an
 * argument that resolves to nothing changes nothing.
 *
 * Deliberately makes no model calls at all — `/model` never sends anything — so
 * this scenario is free apart from starting the TUI. Both entries are Bedrock for
 * the same reason; the cross-provider switch is proven against real models in
 * `spike/verify-model-command.ts --live`.
 *
 * Writes its own two-entry catalogue rather than using the preset one, so the
 * assertions describe a file a reader can see here.
 */
async function modelCommand(): Promise<void> {
  header('TUI — /model switches between configured models');

  await resetWorkDir();
  const configFile = HOME_CONFIG;
  await writeHomeConfig({
    models: [
      { enable: true, name: 'fast', provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6' },
      { enable: false, name: 'deep', provider: 'bedrock', model: 'global.anthropic.claude-opus-5' },
    ],
  });

  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('the header names the enabled model', tui.screen.includes('bedrock/us.anthropic.claude-sonnet-4-6'));

    const beforeList = tui.mark();
    tui.submit('/model');
    await tui.waitFor('2 models configured', { timeoutMs: 30_000, from: beforeList, settleMs: 400 });
    const listed = tui.screen.slice(beforeList);
    assert('a bare /model lists the catalogue', listed.includes('2 models configured'));
    assert('…marking the live entry', listed.includes('* 1. fast'));
    assert('…and offering the other', listed.includes('2. deep'));
    // The point of answering locally: listing must not spend a model call.
    assert('listing did not start a turn', !listed.includes('working…'));

    const beforeSwitch = tui.mark();
    tui.submit('/model deep');
    await tui.waitFor('saved to', { timeoutMs: 30_000, from: beforeSwitch, settleMs: 400 });
    const switched = tui.screen.slice(beforeSwitch);
    assert('the switch is confirmed by name', switched.includes('deep'));
    assert('…and reported as persisted', switched.includes(`saved to ${HOME_CONFIG_LABEL}`));
    // Sliced, not searched whole: the startup frame named the old model, so an
    // unsliced assertion would pass without the header ever following.
    assert('the header follows the switch', switched.includes('bedrock/global.anthropic.claude-opus-5'));
    assert('switching did not start a turn', !switched.includes('working…'));

    const saved = JSON.parse(await readFile(configFile, 'utf8')) as {
      models: { name: string; enable: boolean }[];
    };
    console.log(`  written config: ${JSON.stringify(saved.models.map((m) => `${m.name}=${m.enable}`))}`);
    assert('the target entry was switched on', saved.models[1]?.enable === true);
    assert('…and the previous one off', saved.models[0]?.enable === false);

    const beforeSame = tui.mark();
    tui.submit('/model deep');
    await tui.waitFor('already on deep', { timeoutMs: 30_000, from: beforeSame, settleMs: 400 });
    assert('switching to the live model says so', tui.screen.slice(beforeSame).includes('already on deep'));

    // Both model ids contain "claude", so this must refuse rather than pick one.
    const beforeAmbiguous = tui.mark();
    tui.submit('/model claude');
    await tui.waitFor('matches more than one model', { timeoutMs: 30_000, from: beforeAmbiguous, settleMs: 400 });
    assert(
      'an ambiguous argument is refused',
      tui.screen.slice(beforeAmbiguous).includes('matches more than one model'),
    );

    const beforeMiss = tui.mark();
    tui.submit('/model gemini');
    await tui.waitFor('no configured model matches', { timeoutMs: 30_000, from: beforeMiss, settleMs: 400 });
    const missed = tui.screen.slice(beforeMiss);
    assert('an unknown model is refused', missed.includes('no configured model matches'));
    // A refused command must not reach the model as a prompt either.
    assert('a bad argument did not start a turn', !missed.includes('working…'));

    const afterRefusals = JSON.parse(await readFile(configFile, 'utf8')) as {
      models: { enable: boolean }[];
    };
    assert('the refusals changed nothing on disk', afterRefusals.models[1]?.enable === true);

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after switching model', code === 0);
  } finally {
    tui.kill();
  }
}

async function planHeader(): Promise<void> {
  header('TUI — CLI plan override is visible without a model call');
  await resetWorkDir();
  await writeHomeConfig({ permissionMode: 'yolo' });
  const rulesFile = permissionRulesPath(WORK_DIR);
  await mkdir(path.dirname(rulesFile), { recursive: true });
  await writeFile(rulesFile, '{"allow":["bash"]}\n', 'utf8');
  const tui = startTui({ cwd: WORK_DIR, args: ['--permission-mode', 'plan'] });
  try {
    await tui.waitFor('mode: plan — read-only; write and execute calls are denied', {
      timeoutMs: 60_000,
      settleMs: 300,
    });
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('the header shows the effective CLI-selected plan mode', tui.screen.includes('mode: plan — read-only'));
    assert('the configured yolo mode is not presented as effective', !tui.screen.includes('mode: yolo'));
    assert('loaded allow rules are visibly ignored in plan mode', tui.screen.includes('1 allow rule(s) ignored'));
    tui.submit('/exit');
    assert('TUI exited cleanly from plan mode', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

/**
 * A long answer must scroll, not flicker.
 *
 * Ink repaints the live region in place only while it fits the viewport; one row
 * over, and every render becomes `clearTerminal` + the whole static transcript
 * written straight to stdout, at text-delta rate — the screen strobes and the
 * scrollback is erased with it (`spike/probe-live-frame-overflow.tsx` measures
 * the mechanism in isolation). So the assertion is on the raw pty bytes: no
 * whole-screen clear during a turn whose answer is several times taller than the
 * terminal, and the finished answer still complete in the transcript.
 *
 * A deliberately short terminal: 20 rows makes an over-tall live region certain
 * without needing a 500-line answer, and the header alone takes a third of it.
 */
async function longAnswer(): Promise<void> {
  header('TUI — a long streamed answer does not repaint the whole screen');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR, cols: 100, rows: 20 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const beforeTurn = tui.mark();
    const rawBeforeTurn = tui.raw.length;
    tui.submit(
      'Print the numbers 1 to 120, one per line, formatted as "row 1", "row 2" and so on. ' +
        'No other text, no code fences. Do not use any tools.',
    );
    await tui.waitFor('working…', { timeoutMs: 60_000, from: beforeTurn });

    // Progressive: finished lines reach `<Static>` while the turn is still running,
    // so the top of the answer is in the scrollback long before the block closes.
    // Before that change the transcript stayed empty until the very last frame, so
    // this is the assertion that tells the two apart.
    await tui.waitFor('row 60', { timeoutMs: 240_000, from: beforeTurn });
    const midTurn = tui.screen.slice(beforeTurn);
    assert('the start of the answer is already in the transcript mid-turn',
      /row 1(?!\d)/.test(midTurn) && midTurn.includes('working…'));

    await tui.waitFor('row 120', { timeoutMs: 240_000, from: beforeTurn });
    await waitForIdle(tui, 240_000);

    const rawTurn = tui.raw.slice(rawBeforeTurn);
    const clears = clearCount(rawTurn);
    console.log(`  full-screen clears during the turn: ${clears}`);
    console.log(`  bytes written for a 120-line answer: ${rawTurn.length}`);
    assert('the screen (and the scrollback) is never cleared while streaming', clears === 0);

    // Bounding the *live* region must not bound the transcript, and committing lines
    // as they finish must not lose or duplicate any of them.
    const transcript = tui.screen.slice(beforeTurn);
    assert('the whole answer still reached the transcript',
      /row 1(?!\d)/.test(transcript) && transcript.includes('row 60') && transcript.includes('row 120'));
    // No count assertions on accumulated pty output: every row that passed through
    // the live tail was drawn once per repaint, so "exactly once" is not a property
    // of these bytes. Duplication is proved where a stable projection exists —
    // `verify-stream-into-static.ts` over the reducer's history and its replay.
    assert('nothing is left in the live region once the answer is history',
      !tui.frame.includes('scrolled out of the live view'));

    // The tail is still load-bearing — for the shape that has no finished lines to
    // commit. This assertion used to ride on the 120-line answer above; committing
    // finished lines means that answer no longer needs a tail at all, so the check
    // moves to the shape that does rather than being dropped.
    const paragraphStart = tui.mark();
    const rawBeforeParagraph = tui.raw.length;
    tui.submit(
      'Write one single paragraph of at least 1200 characters about rivers, as one line ' +
        'with no line breaks at all and no lists. Do not use any tools.',
    );
    await tui.waitFor('working…', { timeoutMs: 60_000, from: paragraphStart });
    await tui.waitUntil(
      (screen) => /… \d+ earlier lines? scrolled out of the live view/.test(screen.slice(paragraphStart)),
      { timeoutMs: 240_000, label: 'the scrolled-out notice on an unbroken paragraph' },
    );
    await waitForIdle(tui, 240_000);
    assert('an unbroken paragraph is still shown as a bounded tail that says what it hides',
      /… \d+ earlier lines? scrolled out of the live view/.test(tui.screen.slice(paragraphStart)));
    assert('and it too never clears the screen', clearCount(tui.raw.slice(rawBeforeParagraph)) === 0);
    assert('the paragraph reached history whole',
      !tui.frame.includes('scrolled out of the live view'));

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after a long answer', code === 0);
  } finally {
    tui.kill();
  }
}

/**
 * A draft taller than the terminal is the other half of the live-frame contract.
 *
 * Measured before the fix (`.trellis/tasks/08-17-live-frame-chrome/research/`): in
 * an 80x24 terminal the first `ESC[3J` appeared at a **13-row draft** and every
 * further row cost 2 more — with no model streaming at all, just an idle session
 * being typed into. `ESC[3J` erases the scrollback, so this was the transcript
 * being destroyed by the editor.
 *
 * Free: bracketed paste is delivered to `usePaste` and never submits, and the
 * scenario leaves through the local `/exit`. Keep it that way — growing a draft
 * with `send("\n" + text)` would take the batched-Enter path and submit a prompt.
 */
async function tallDraft(): Promise<void> {
  header('TUI — a draft taller than the terminal keeps the frame inside it');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR, cols: 80, rows: 24 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const beforePaste = tui.mark();
    const rawBeforePaste = tui.raw.length;
    const rows = Array.from({ length: 40 }, (_, index) => `draft row ${index + 1}`);
    tui.send(`\u001b[200~${rows.join('\r\n')}\u001b[201~`);
    await tui.waitFor('...> draft row 40', { timeoutMs: 30_000, from: beforePaste, settleMs: 600 });

    assert('a 40-row draft never clears the screen or the scrollback',
      clearCount(tui.raw.slice(rawBeforePaste)) === 0);
    assert('the draft states the rows it is not showing',
      /… \d+ draft rows not shown \(\d+ above\)/.test(tui.frame));
    assert('the rows it shows are the newest, where the cursor is',
      tui.frame.includes('...> draft row 40'));
    assert('pasting a tall draft does not submit it',
      !tui.screen.slice(beforePaste).includes('working…'));

    // The pre-fix cost was per added row, so growing it again is its own assertion.
    const beforeMore = tui.mark();
    const rawBeforeMore = tui.raw.length;
    tui.send('\u001b[200~\r\ndraft row 41\u001b[201~');
    await tui.waitFor('...> draft row 41', { timeoutMs: 30_000, from: beforeMore, settleMs: 400 });
    assert('and one more row still does not', clearCount(tui.raw.slice(rawBeforeMore)) === 0);

    // Shrinking is the other trigger: Ink clears when a frame that filled the
    // viewport gets shorter (`isLeavingFullscreen`), so the window must never have
    // filled it in the first place.
    const beforeShrink = tui.mark();
    const rawBeforeShrink = tui.raw.length;
    tui.send('\u007f'.repeat(700));
    tui.send('x');
    await tui.waitFor('you> x', { timeoutMs: 30_000, from: beforeShrink, settleMs: 400 });
    assert('collapsing the draft back to one row does not clear either',
      clearCount(tui.raw.slice(rawBeforeShrink)) === 0);
    assert('the notice is gone once everything fits',
      !tui.frame.includes('draft rows not shown'));

    tui.send('\u007f');
    tui.submit('/exit');
    assert('tall-draft scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}


/**
 * The combination, in one frame: a streaming answer, a running-tool-free turn, and
 * a draft taller than the terminal typed while the answer arrives.
 *
 * Each participant is bounded on its own by now; this is the assertion that they
 * are bounded *together*, which is the only thing Ink actually cares about. It is
 * also what the share ceiling in `frame-budget.ts` exists for: served first, the
 * draft would take the whole frame and leave the answer nothing.
 *
 * Costs one model turn, like `longAnswer`.
 */
async function tallDraftStreaming(): Promise<void> {
  header('TUI — a tall draft and a streaming answer share one frame');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR, cols: 80, rows: 24 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const turnStart = tui.mark();
    const rawBeforeTurn = tui.raw.length;
    tui.submit(
      'Print the numbers 1 to 90, one per line, formatted as "row 1", "row 2" and so on. ' +
        'No other text, no code fences. Do not use any tools.',
    );
    await tui.waitFor('working…', { timeoutMs: 60_000, from: turnStart });

    // Paste a draft taller than the terminal while the answer is still arriving.
    const rows = Array.from({ length: 40 }, (_, index) => `draft row ${index + 1}`);
    tui.send(`\u001b[200~${rows.join('\r\n')}\u001b[201~`);
    await tui.waitFor('...> draft row 40', { timeoutMs: 60_000, from: turnStart, settleMs: 400 });

    // Sampled mid-answer, which is the only moment both participants are in the live
    // frame at once. The answer contributes its *uncommitted* rows only: finished
    // lines are in `<Static>` by now (`turn-state.ts`), so this frame does not carry
    // the scrolled-out notice a line-oriented answer used to need — asserting it here
    // would be asserting the absence of that feature.
    await tui.waitFor('row 30', { timeoutMs: 240_000, from: turnStart, settleMs: 300 });
    const shared = tui.frame;
    assert('the tall draft is windowed while the answer streams',
      /… \d+ draft rows not shown/.test(shared) && shared.includes('...> draft row 40'));
    assert('and the answer is still arriving in the same frame',
      shared.includes('working…') && /row \d+/.test(shared));

    await tui.waitFor('row 90', { timeoutMs: 240_000, from: turnStart });

    // A windowed draft has no `you>` row — that row is one of the ones scrolled out
    // of the window — so `waitForIdle` (which keys on `you>` being newer than
    // `working…`) cannot be used until the draft fits again. Backspaces, not ctrl+u:
    // that kills to the *row* start, which would leave 39 rows in front of `/exit`
    // and submit the lot as a prompt.
    const beforeClear = tui.mark();
    tui.send('\u007f'.repeat(700));
    tui.send('x');
    await tui.waitFor('you> x', { timeoutMs: 60_000, from: beforeClear, settleMs: 400 });
    await waitForIdle(tui, 240_000);

    assert('the screen is never cleared with both a tall draft and a long answer',
      clearCount(tui.raw.slice(rawBeforeTurn)) === 0);
    assert('the answer still reached the transcript in full',
      /row 1(?!\d)/.test(tui.screen.slice(turnStart)) && tui.screen.slice(turnStart).includes('row 90'));

    tui.send('\u007f');
    tui.submit('/exit');
    assert('tall-draft-while-streaming scenario exits cleanly',
      (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

/** Whole-screen (and scrollback) clears in a slice of raw pty output. */
function clearCount(raw: string): number {
  return raw.split('\u001b[3J').length - 1;
}

const SCENARIOS = {
  approve: approvePath,
  deny: denyPath,
  alwaysAllow: alwaysAllowRule,
  safePassthrough,
  bashExit: exitAfterBash,
  cancelThenContinue,
  multiline: multilineInput,
  chunkedEnter,
  compacting: compactingInputOwnership,
  cursor: cursorEditing,
  completion: slashCompletion,
  toolDetails: toolDetailsToggle,
  agents: agentDispatches,
  agentsMd: agentsMdHeader,
  usage: usageReport,
  tasks: taskMonitoring,
  effort: effortCommand,
  model: modelCommand,
  plan: planHeader,
  longAnswer,
  tallDraft,
  tallDraftStreaming,
} as const;

async function main(): Promise<void> {
  const only = process.argv[2];
  const names = (
    only !== undefined && only in SCENARIOS ? [only] : Object.keys(SCENARIOS)
  ) as (keyof typeof SCENARIOS)[];

  // One clean owned HOME per run: a config, session or allow rule left by an
  // earlier run must not be what a scenario ends up asserting against.
  await rm(OWNED_HOME, { recursive: true, force: true });
  await mkdir(OWNED_HOME, { recursive: true });
  console.log(`  (HOME for this run: ${OWNED_HOME})`);

  for (const name of names) {
    const started = Date.now();
    await SCENARIOS[name]();
    console.log(`  (${name} took ${Math.round((Date.now() - started) / 1000)}s)`);
  }
  report();
}

await main();
