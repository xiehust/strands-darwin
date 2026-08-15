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
 *                 cancelThenContinue | multiline | chunkedEnter | cursor | completion | backgroundDetails |
 *                 agentsMd | usage | tasks | effort | model | plan
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

const FIX_REQUEST =
  `The function in ${TARGET} is called double but it adds 2 instead of multiplying by 2. ` +
  `Read the file and fix it with a str_replace edit. Do not run any shell commands.`;

async function resetWorkDir(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await writeFile(TARGET, BUGGY, 'utf8');
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
    tui.submit(FIX_REQUEST);

    await tui.waitFor('called double but it adds', { timeoutMs: 60_000, from: turnStart });
    assert('user message appears in history', tui.screen.includes('called double but it adds'));

    // Reading the file is a read: it must run without asking.
    await tui.waitFor('fileEditor view', { timeoutMs: 120_000, from: turnStart });
    assert('read tool call was rendered', tui.screen.includes('fileEditor view'));

    // Anchored on the box's LAST line, not its first: 'permission required' is the
    // heading, and a frame arriving in chunks satisfies it while the details and the
    // y/n line are still on their way — which fails the asserts below for a reason
    // that has nothing to do with permissions.
    await tui.waitFor('allow?', { timeoutMs: 180_000, from: turnStart, settleMs: 400 });
    assert('permission prompt appeared', tui.screen.includes('permission required'));
    assert('prompt is labelled as a write', /permission required\s*\(write\b/.test(tui.screen));
    // Provenance rides the summary line, so the heading line is unchanged and the
    // box gains no row. `[parent]` is rendered even with no delegation in flight:
    // a label that only shows up sometimes leaves the user guessing on the prompts
    // that matter, which are exactly the ones a concurrent child queued.
    assert('prompt says which agent asked', /\[parent\] fileEditor str_replace/.test(tui.screen));
    assert(
      'the source label did not push the box off the frame',
      tui.screen.includes('allow?') && tui.screen.includes('Path:') && tui.screen.includes('With:'),
    );
    assert('prompt says why the call was flagged', tui.screen.includes('outside the project'));
    assert('prompt shows the file path', tui.screen.includes(TARGET));
    assert('prompt shows the Path label', tui.screen.includes('Path:'));
    assert('prompt shows the replacement block', tui.screen.includes('With:'));
    assert('prompt offers the y/n choice', tui.screen.includes('allow?'));
    // The wildcard offers, on the same row as y/n: a second option row is a row
    // of the box, and the box already competes with the header for frame height.
    assert(
      'prompt offers a wildcard rule derived from this call',
      tui.screen.includes(`always: a=${TARGET_DIR}/`),
    );
    assert('prompt offers the whole tool as well', tui.screen.includes('A=all fileEditor'));

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
    tui.send('\r');
    tui.send('slash-delta');
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
    assert('skills are advertised in the header', tui.screen.includes('skills: commit-message'));
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
async function backgroundDetailsToggle(): Promise<void> {
  header('TUI — Ctrl+B toggles background details without editing the draft');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const draft = 'draft stays here';
    tui.send(draft);
    await tui.waitFor(`you> ${draft}`, { timeoutMs: 30_000, settleMs: 400 });

    const beforeExpanded = tui.mark();
    tui.send('\u0002'); // ctrl+b
    await tui.waitFor('background details: expanded', {
      timeoutMs: 30_000,
      from: beforeExpanded,
      settleMs: 400,
    });
    assert('Ctrl+B reports expanded mode', tui.screen.slice(beforeExpanded).includes('background details: expanded'));
    assert('expanding preserves the existing draft', tui.screen.slice(beforeExpanded).includes(`you> ${draft}`));

    const beforeCompact = tui.mark();
    tui.send('\u0002');
    await tui.waitFor('background details: compact', {
      timeoutMs: 30_000,
      from: beforeCompact,
      settleMs: 400,
    });
    assert('Ctrl+B reports compact mode', tui.screen.slice(beforeCompact).includes('background details: compact'));
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

const SCENARIOS = {
  approve: approvePath,
  deny: denyPath,
  alwaysAllow: alwaysAllowRule,
  safePassthrough,
  bashExit: exitAfterBash,
  cancelThenContinue,
  multiline: multilineInput,
  chunkedEnter,
  cursor: cursorEditing,
  completion: slashCompletion,
  backgroundDetails: backgroundDetailsToggle,
  agents: agentDispatches,
  agentsMd: agentsMdHeader,
  usage: usageReport,
  tasks: taskMonitoring,
  effort: effortCommand,
  model: modelCommand,
  plan: planHeader,
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
