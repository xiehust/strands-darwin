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
 *                 cancelThenContinue | multiline | chunkedEnter | compacting | cursor | completion |
 *                 pathCompletion | recall | recallEmpty | resume | bang | queue | clear | mcpStderr | mcp |
 *                 toolDetails |
 *                 agentsMd | usage | tasks | effort | model | plan | longAnswer | tallDraft |
 *                 tallDraftStreaming | drainPrompt
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import path from 'node:path';

import {
  Agent,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import {
  createSessionManager,
  sessionPaths,
  snapshotPath,
  trajectoryPath,
  writePointer,
} from '../src/agent/session.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { darwinDir, DARWIN_DIRNAME } from '../src/paths.js';
import { CONFIG_FILENAME, permissionRulesPath } from '../src/config.js';
import { AGENTS_DIRNAME } from '../src/agents/loader.js';
import { COMMANDS_DIRNAME } from '../src/commands/custom-commands.js';
import { SKILLS_DIRNAME } from '../src/skills/loader.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { recordStream } from '../src/trajectory/stream.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
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
/**
 * Short, unique anchor for waits that only need "the target path was drawn".
 *
 * The full path is ~170 characters and does **not** appear contiguously in the
 * stripped output: it is drawn across a wrap. Waiting on it and then asserting it was
 * self-fulfilling — the wait *was* the assertion — and it is why the wait
 * occasionally spent its whole 60s budget with the run otherwise healthy. Wait on
 * this anchor; compare the full path with {@link withoutWhitespace}.
 */
const APPROVE_TARGET_ANCHOR = 'ser009-pppppppppp';
const APPROVE_REPLACEMENT = `  return n * 2; // ${APPROVE_PREFIX}${'x'.repeat(620)}`;
/**
 * What the file must look like after the approved edit — structurally.
 *
 * Deliberately *not* byte-equality with a 620-character replacement. That asserted
 * the model can transcribe 620 identical characters exactly, which it manages
 * roughly half the time (two failures in three full-suite runs on 2026-08-17), and
 * which is not what this scenario is for. What must hold is that approving the prompt
 * applied the edit *darwin was asked to apply*: the buggy line replaced in place, the
 * marker present, a long run of `x` behind it, and nothing else in the file touched.
 * The exact length still matters where it is darwin's business — the permission box's
 * `… truncated N code points` marker, asserted on the frame above.
 */
function approvedEditIsExact(after: string): boolean {
  const [before, ...rest] = BUGGY.split('  return n + 2;');
  if (before === undefined || rest.length !== 1) return false;
  const suffix = rest[0] as string;
  const match = after.match(/^([\s\S]*?)  return n \* 2; \/\/ SER009-DETAIL-PREFIX-(x+)([\s\S]*)$/u);
  if (match === null) return false;
  const [, head, xs, tail] = match as unknown as [string, string, string, string];
  // Everything around the replaced line is untouched, and the replacement is long
  // enough to have exercised the projection bound.
  return head === before && tail === suffix && xs.length >= 200;
}
const APPROVE_REQUEST =
  `Read ${APPROVE_TARGET}. Then use fileEditor str_replace to replace exactly \`  return n + 2;\` ` +
  `with exactly \`${APPROVE_REPLACEMENT}\`. Do not run shell commands or make any other edit.`;

const FIX_REQUEST =
  `The function in ${TARGET} is called double but it adds 2 instead of multiplying by 2. ` +
  `Read the file and fix it with a str_replace edit. Do not run any shell commands.`;

/** Local-only model used to seed a real restorable SDK snapshot and trajectory. */
class ResumeFixtureModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.resume-recap', contextWindowLimit: 200_000 };
  calls = 0;

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'last completed answer' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

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
    await tui.waitFor('/exit quits', { timeoutMs: 60_000 });
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('TUI rendered its header', tui.screen.includes('/exit quits'));
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

    await tui.waitFor(APPROVE_TARGET_ANCHOR, { timeoutMs: 60_000, from: turnStart });
    assert('user message appears in history',
      withoutWhitespace(tui.screen).includes(withoutWhitespace(APPROVE_TARGET)));

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
    assert('prompt keeps detail labels, the Diff stat included',
      permissionFrame.includes('Path:') && /Diff \(\+1 -1\):/.test(permissionFrame));
    // The edit is presented as a line diff computed from the tool input itself:
    // the buggy line under `- `, the replacement under `+ `, markers that are
    // plain text and therefore survive the ANSI strip this suite asserts through.
    // Neither regex may span a wrap boundary: the 641-code-point replacement token
    // wraps onto marker-less continuation rows (measured at 116 box columns), so
    // the `+` row is asserted up to `//` and the prefix by the assertion above.
    assert('diff shows the removed line under its minus marker', /- +return n \+ 2;/.test(permissionFrame));
    assert('diff shows the replacement under its plus marker', /\+ +return n \* 2; \/\//.test(permissionFrame));
    assert('the raw Replace/With blocks are the diff now',
      !permissionFrame.includes('Replace:') && !permissionFrame.includes('With:'));
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
    // Draining, not a plain idle wait: the request says not to run shell commands and
    // the model mostly obeys, but when it does not, the extra call raises a second
    // permission box this scenario never answers — every assertion passes and the run
    // then burns its whole timeout. See the known-flake note in
    // `.trellis/spec/frontend/tui-testing.md`.
    await settleTurn(tui, 240_000);

    const after = await readFile(APPROVE_TARGET, 'utf8');
    console.log(`  calc.js now: ${after.replace(/\n/g, ' ').slice(0, 160)}…`);

    assert('approved edit was applied in place, and nothing else was', approvedEditIsExact(after));
    assert('the bug is gone', !after.includes('n + 2'));

    // SER-023: the finished edit's compact diff excerpt and the +N -N stat reach
    // the transcript without Ctrl+T. The stat sits between the command and the
    // path on the finished `✓` row — this scenario's deliberately huge path
    // truncates the row's end, so a suffix stat would never be visible — and the
    // permission box (whose label also states the stat) never draws a `✓` row,
    // so the anchor cannot match box output. The `+ ` diff row is asserted only
    // up to `//` because the 641-code-point replacement wraps onto marker-less
    // continuation rows (see the frame assertions above).
    const afterApproval = tui.screen.slice(afterAnswer);
    const summaryAt = afterApproval.search(/✓ fileEditor str_replace \(\+1 -1\):/);
    assert('the +1 -1 stat rides the finished summary row', summaryAt >= 0);
    const finishedTranscript = summaryAt >= 0 ? afterApproval.slice(summaryAt) : '';
    assert('finished edit shows its removed line in the compact transcript',
      /- +return n \+ 2;/.test(finishedTranscript));
    assert('finished edit shows its added line in the compact transcript',
      /\+ +return n \* 2; \/\//.test(finishedTranscript));

    tui.send('\u0015'); // ctrl+u clears the retained permission-ownership draft
    // Anchored, so the following /exit cannot coalesce with the ctrl+u into one
    // pty event — normalizeDraftText strips the control, and '/exit' would then
    // land inside the still-present draft and submit as a model prompt.
    await tui.waitUntil(() => !tui.frame.includes(`you> ${hiddenDraft}`), {
      timeoutMs: 10_000,
      label: 'the cleared draft',
      settleMs: 200,
    });
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
      'loaded capabilities are summarized in the header',
      tui.screen.includes('loaded: 4 skills · 1 command · 1 agent'),
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

    // /export, on its free paths: usage and "nothing to export". This session is
    // recording but has closed no turn, so its record file does not exist yet —
    // exactly the absence rule the notice has to state instead of erroring or
    // writing an empty file.
    const beforeExportUsage = tui.mark();
    tui.submit('/export');
    await tui.waitFor('usage: /export <path>', { timeoutMs: 30_000, from: beforeExportUsage, settleMs: 400 });
    assert('/export without a path yields usage without starting a turn',
      !tui.screen.slice(beforeExportUsage).includes('working…'));

    const beforeExportEmpty = tui.mark();
    tui.submit('/export nothing-yet.md');
    await tui.waitFor('nothing to export', { timeoutMs: 30_000, from: beforeExportEmpty, settleMs: 400 });
    const exportEmpty = tui.screen.slice(beforeExportEmpty);
    assert('/export before any turn says why there is nothing to export',
      exportEmpty.includes('no recorded turns yet') && !exportEmpty.includes('working…'));
    assert('a nothing-to-export session writes no file', !existsSync(path.join(dir, 'nothing-yet.md')));

    // /status (SER-026): the consolidated read-only report must answer without a
    // model call, in a project with no MCP configured at all — absence is a normal
    // state ('none configured'), never an error. The skills fixture above is what
    // makes the skills line countable.
    const beforeStatusArgument = tui.mark();
    tui.submit('/status extra');
    await tui.waitFor('/status takes no arguments', { timeoutMs: 30_000, from: beforeStatusArgument, settleMs: 400 });
    assert('/status rejects arguments without starting a turn',
      !tui.screen.slice(beforeStatusArgument).includes('working…'));

    const beforeStatus = tui.mark();
    tui.submit('/status');
    await tui.waitFor('status — this session', { timeoutMs: 30_000, from: beforeStatus, settleMs: 400 });
    const statusReport = tui.screen.slice(beforeStatus);
    assert('/status answers without a model call', !statusReport.includes('working…'));
    assert('/status names the model and provider', /bedrock\/(us|eu|apac|global)\.anthropic\./.test(statusReport));
    assert('/status states the session id', statusReport.includes('session-'));
    assert('/status states the permission mode', /mode\s+default/.test(statusReport));
    assert('/status states no-MCP as a normal state', statusReport.includes('none configured'));
    assert('/status counts the loaded skills', /skills\s+4 — /.test(statusReport));
    assert('/status states the trajectory file',
      statusReport.includes('recording — ') && withoutWhitespace(statusReport).includes('trajectory.jsonl'));
    assert('/status states diagnostics off', /diagnostics\s+off/.test(statusReport));
    assert('an unreported spend metric stays not reported, never 0',
      statusReport.includes('cache read not reported') && !statusReport.includes('cache read 0'));
    assert('/status states the context estimate', /context\s+~/.test(statusReport) && statusReport.includes('tokens'));

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
    // Every built-in, not a sample: MAX_COMPLETIONS is what makes the whole list fit,
    // so a built-in added without growing it must fail here rather than silently
    // disappear behind the "… n more" row.
    assert('the built-in /clear is listed', completed.includes('  /clear'));
    assert('the built-in /compact is listed', completed.includes('  /compact'));
    assert('the built-in /context is listed', completed.includes('  /context'));
    assert('the built-in /effort is listed', completed.includes('  /effort'));
    assert('the built-in /exit is listed', completed.includes('  /exit'));
    // Matched with its description: '  /export' is not a prefix of any other row,
    // but the description is what tells /export apart from a custom command.
    assert('the built-in /export is listed', completed.includes('  /export — write this session’s transcript to a file'));
    // Matched with its description: the header's own mcp line also says 'mcp', so
    // the bare-name form could pass with the row missing.
    assert('the built-in /mcp is listed', completed.includes('  /mcp — MCP servers and their tools'));
    // Matched with its description: '  /mode' alone is also a prefix of the /model
    // row, so the bare-name form would pass with /mode missing entirely.
    assert('the built-in /mode is listed', completed.includes('  /mode — set the permission mode'));
    assert('the built-in /model is listed', completed.includes('  /model — list or switch models'));
    assert('the built-in /permissions is listed', completed.includes('  /permissions'));
    // Matched with its description: '  /status' could ride along in other transcript
    // text, and the description is what tells the built-in apart in the menu.
    assert('the built-in /status is listed', completed.includes('  /status — session configuration and state'));
    assert('the built-in /tasks is listed', completed.includes('  /tasks'));
    assert('the built-in /trajectory is listed', completed.includes('  /trajectory'));
    assert('the built-in /usage is listed', completed.includes('  /usage'));
    assert(
      'runtime completion order is built-ins, custom commands, then skills',
      completed.indexOf('/review') < completed.lastIndexOf('/commit-message'),
    );
    assert('the list explains the keys', /to select/.test(completed));


    // The full list is longer than the bounded menu. Walk below the initial window:
    // the marker must follow the selected identity, and Tab must accept that row.
    const beforeDownWindow = tui.mark();
    tui.send('\u001b[B'.repeat(15));
    await tui.waitFor('❯ /review', { timeoutMs: 30_000, from: beforeDownWindow, settleMs: 400 });
    assert('Down windows an overflowing slash menu around the selected candidate',
      tui.frame.includes('❯ /review') && (tui.frame.match(/❯/g)?.length ?? 0) === 1);
    assert('the slash window states omissions above', /… \d+ more not shown \(\d+ above/.test(tui.frame));
    const beforeTabAccept = tui.mark();
    tui.send('\t');
    await tui.waitUntil(() => !tui.frame.includes('commands (') && tui.frame.includes('you> /'), {
      timeoutMs: 30_000,
      from: beforeTabAccept,
      settleMs: 400,
    });
    assert('Tab accepts exactly the visibly selected slash candidate',
      tui.frame.includes('you> /review') && !tui.frame.includes('commands ('));

    // Reopen, then wrap upward from the first full-list item to the last. Enter has
    // the same acceptance contract as Tab and must not submit the accepted command.
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('commands (') && !tui.frame.includes('you> /review'), {
      timeoutMs: 10_000,
      label: 'slash draft cleared before reopening completion',
    });
    tui.send('/');
    await tui.waitFor('❯ /agents', { timeoutMs: 30_000, settleMs: 400 });
    const beforeWrap = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('❯ /commit-message', { timeoutMs: 30_000, from: beforeWrap, settleMs: 400 });
    assert('Up wraps and windows the last slash candidate with one visible marker',
      tui.frame.includes('❯ /commit-message') && (tui.frame.match(/❯/g)?.length ?? 0) === 1);
    const beforeEnterAccept = tui.mark();
    tui.send('\r');
    await tui.waitFor('you> /commit-message', { timeoutMs: 30_000, from: beforeEnterAccept, settleMs: 400 });
    assert('Enter accepts exactly the visibly selected slash candidate without submitting it',
      tui.frame.includes('you> /commit-message') && !tui.frame.includes('commands (') &&
      !tui.screen.slice(beforeEnterAccept).includes('working…'));

    // Restore the original no-match check's starting draft.
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('commands (') && !tui.frame.includes('you> /commit-message'), {
      timeoutMs: 10_000,
      label: 'accepted slash draft cleared before no-match check',
    });
    tui.send('/');
    await tui.waitFor('❯ /agents', { timeoutMs: 30_000, settleMs: 400 });

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

/**
 * `@` path completion, end to end, with no model call: nothing is ever submitted.
 *
 * The property that needs a real pty rather than a unit check is that accepting a
 * completion moves *text* and nothing else — so the fixture puts a unique string
 * inside the file being completed and a secret behind a symlink out of the project,
 * and both are asserted absent from everything the terminal ever showed.
 */
async function pathCompletion(): Promise<void> {
  header('TUI — @ completes workspace paths, and inserts only the path');

  const dir = '/tmp/darwin-path-tui';
  const outside = '/tmp/darwin-path-tui-outside';
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(path.join(dir, 'src', 'tui'), { recursive: true });
  await mkdir(path.join(dir, 'pad'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'ink'), { recursive: true });
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(dir, 'notes.md'), 'notes\n', 'utf8');
  await writeFile(path.join(dir, 'src', 'tui', 'AppFixture.tsx'), 'UNIQUE_TUI_FIXTURE_CONTENT\n', 'utf8');
  await writeFile(path.join(dir, 'node_modules', 'ink', 'index.js'), '// ink\n', 'utf8');
  await writeFile(path.join(dir, 'dist', 'bundle.js'), '// built\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE_TUI_SECRET\n', 'utf8');
  await symlink(outside, path.join(dir, 'escape'), 'dir');
  // Enough entries that the menu must drop some, so "what is not shown is stated" is
  // asserted on the real thing rather than on the helper that counts it.
  for (let index = 1; index <= 15; index += 1) {
    await writeFile(path.join(dir, 'pad', `p${String(index).padStart(2, '0')}.md`), 'pad\n', 'utf8');
  }

  const tui = startTui({ cwd: dir });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // The scan starts on this keystroke, not at startup, and is never awaited by the
    // editor — so the wait here is for the frame that arrives once it lands.
    const beforeTrigger = tui.mark();
    tui.send('@');
    await tui.waitFor('files (', { timeoutMs: 30_000, from: beforeTrigger, settleMs: 400 });
    const opened = tui.frame;
    assert('a bare @ opens the path menu, named as files', opened.includes('files ('));
    assert('the first workspace path is offered and selected', opened.includes('❯ notes.md'));
    assert('a directory is offered with its trailing slash', opened.includes('  src/'));
    assert('the menu is capped at MAX_COMPLETIONS rows', completionRowCount(opened) === MAX_COMPLETIONS);
    assert('and states how many matches it is not showing', /… \d+ more/.test(opened));
    assert('node_modules never appears', !opened.includes('node_modules'));
    assert('dist never appears', !opened.includes('dist/'));
    assert('a symlink out of the project never appears', !opened.includes('escape'));


    // Walk beyond the bounded prefix and accept the visibly selected path with Tab.
    const beforePathWindow = tui.mark();
    tui.send('\u001b[B'.repeat(10));
    await tui.waitFor('❯ pad/p08.md', { timeoutMs: 30_000, from: beforePathWindow, settleMs: 400 });
    assert('Down windows an overflowing path menu around the selected candidate',
      tui.frame.includes('❯ pad/p08.md') && (tui.frame.match(/❯/g)?.length ?? 0) === 1);
    assert('the path window states omissions above and below truthfully',
      /… \d+ more not shown \(\d+ above, \d+ below\)/.test(tui.frame));
    const beforePathTab = tui.mark();
    tui.send('\t');
    await tui.waitFor('you> pad/p08.md', { timeoutMs: 30_000, from: beforePathTab, settleMs: 400 });
    assert('Tab accepts exactly the visibly selected path candidate',
      tui.frame.includes('you> pad/p08.md') && !tui.frame.includes('files ('));

    // Reopen and wrap upward to the final full-list path. Enter accepts the same row
    // the marker names, without starting a turn.
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('files (') && !tui.frame.includes('you> pad/p08.md'), {
      timeoutMs: 10_000,
      label: 'path draft cleared before reopening completion',
    });
    tui.send('@');
    await tui.waitFor('❯ notes.md', { timeoutMs: 30_000, settleMs: 400 });
    const beforePathWrap = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('❯ src/tui/AppFixture.tsx', { timeoutMs: 30_000, from: beforePathWrap, settleMs: 400 });
    assert('Up wraps and windows the last path candidate with one visible marker',
      tui.frame.includes('❯ src/tui/AppFixture.tsx') && (tui.frame.match(/❯/g)?.length ?? 0) === 1);
    const beforePathEnter = tui.mark();
    tui.send('\r');
    await tui.waitFor('you> src/tui/AppFixture.tsx', { timeoutMs: 30_000, from: beforePathEnter, settleMs: 400 });
    assert('Enter accepts exactly the visibly selected path candidate without submitting it',
      tui.frame.includes('you> src/tui/AppFixture.tsx') && !tui.frame.includes('files (') &&
      !tui.screen.slice(beforePathEnter).includes('working…'));

    // Restore the bare query for the existing directory/file insertion checks.
    tui.send('\u0015');
    await tui.waitUntil(() => !tui.frame.includes('files (') && !tui.frame.includes('you> src/tui/AppFixture.tsx'), {
      timeoutMs: 10_000,
      label: 'accepted path draft cleared before insertion checks',
    });
    tui.send('@');
    await tui.waitFor('❯ notes.md', { timeoutMs: 30_000, settleMs: 400 });

    // Narrow, then accept a directory: the marker stays so the next keystroke keeps
    // completing inside it. Narrowed to `sr` rather than `src/` on purpose — accepting
    // a completion that is already spelled out changes no text, so there would be no
    // new frame to wait for.
    const beforeDirectory = tui.mark();
    tui.send('sr');
    await tui.waitFor('❯ src/', { timeoutMs: 30_000, from: beforeDirectory, settleMs: 400 });
    const beforeAcceptDirectory = tui.mark();
    tui.send('\t');
    await tui.waitFor('you> @src/', { timeoutMs: 30_000, from: beforeAcceptDirectory, settleMs: 400 });
    assert('accepting a directory keeps the query open one level down',
      tui.frame.includes('you> @src/') && tui.frame.includes('files ('));

    // Accept a file: the marker is gone and the draft is the plain path.
    const beforeFile = tui.mark();
    tui.send('tui/App');
    await tui.waitFor('❯ src/tui/AppFixture.tsx', { timeoutMs: 30_000, from: beforeFile, settleMs: 400 });
    const beforeAcceptFile = tui.mark();
    tui.send('\t');
    await tui.waitFor('you> src/tui/AppFixture.tsx', { timeoutMs: 30_000, from: beforeAcceptFile, settleMs: 400 });
    const accepted = tui.frame;
    assert('accepting a file leaves the plain path in the draft', accepted.includes('you> src/tui/AppFixture.tsx'));
    assert('the @ marker is gone once the mention resolves', !accepted.includes('you> @src/tui/AppFixture.tsx'));
    assert('and the menu closed with it', !accepted.includes('files ('));

    // The whole point of the Codex shape: a path, never the bytes behind it.
    assert('the completed file is never read into the terminal',
      !tui.screen.includes('UNIQUE_TUI_FIXTURE_CONTENT'));
    assert('nor is anything behind the escaping symlink',
      !tui.screen.includes('OUTSIDE_TUI_SECRET'));
    assert('completion starts no turn and calls no tool',
      !tui.screen.slice(beforeTrigger).includes('working…'));

    // A non-trigger @: an email address is one word, so the menu never opens.
    tui.send('\u007f'.repeat('src/tui/AppFixture.tsx '.length));
    const beforeEmail = tui.mark();
    tui.send('mail me@example.com');
    await tui.waitFor('you> mail me@example.com', { timeoutMs: 30_000, from: beforeEmail, settleMs: 400 });
    assert('an email address leaves the draft alone and opens no menu',
      tui.frame.includes('you> mail me@example.com') && !tui.frame.includes('files ('));

    // A trigger that matches nothing: recognized, but nothing to offer, so nothing
    // is drawn — this is what keeps a decorator or a handle in prose harmless.
    tui.send('\u007f'.repeat('mail me@example.com'.length));
    const beforeProse = tui.mark();
    tui.send('see @override in the sentence');
    await tui.waitFor('you> see @override in the sentence', { timeoutMs: 30_000, from: beforeProse, settleMs: 400 });
    assert('a trigger no workspace path matches opens no menu', !tui.frame.includes('files ('));

    tui.send('\u0004');
    assert('path completion scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

/**
 * Entry rows drawn under a completion menu's title, counted from the frame.
 *
 * Counted rather than assumed: `MAX_COMPLETIONS` is the promise that the menu never
 * grows past what `planPromptBox` was granted, and a regex for one row would pass
 * with twenty on screen.
 */
function completionRowCount(frame: string): number {
  const lines = frame.split('\n');
  const title = lines.findIndex((line) => /(?:commands|files) \(/.test(line));
  if (title === -1) return 0;
  let rows = 0;
  for (const line of lines.slice(title + 1)) {
    // The overflow row is indented like an entry and starts with a non-space, so it
    // has to be excluded explicitly or it counts as a twelfth completion.
    if (/^\s*…/.test(line)) break;
    if (!/^(?:❯ |  )\S/.test(line)) break;
    rows += 1;
  }
  return rows;
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
 * SER-028: resume restores human context from the trajectory without touching any
 * durable session artifact or invoking a model. The seed uses a real SDK Agent,
 * SessionManager and TrajectoryRecorder; the resumed process exits from its first
 * prompt, before any ordinary turn can run.
 */
async function resumedHumanContext(): Promise<void> {
  header('TUI — resumed session shows bounded read-only human context');

  await resetWorkDir();
  await writeHomeConfig({
    provider: 'bedrock',
    model: 'us.anthropic.invalid-no-network-resume-recap',
    // Keep recording enabled: startup must leave even an active recorder's existing
    // file byte-identical and append no runStarted line when no turn is sent.
    trajectory: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
  const sessionId = 'session-resume-recap';
  const model = new ResumeFixtureModel();
  const manager = createSessionManager(WORK_DIR, sessionId);
  const agent = new Agent({
    id: 'darwin',
    model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    sessionManager: manager,
    printer: false,
  });
  await agent.initialize();
  const trajectory = trajectoryPath(WORK_DIR, sessionId);
  const recorder = new TrajectoryRecorder({
    file: trajectory,
    run: {
      session: sessionId,
      agentId: 'darwin',
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'fake.resume-recap',
      permissionMode: 'default',
      thinkingEffort: 'high',
      resumed: false,
      restoredMessages: 0,
    },
  });
  const request = `last completed request ${'context '.repeat(120)}\n${Array.from({ length: 10 }, (_, i) => `request-line-${i}`).join('\n')}`;
  for await (const _event of recordStream(agent.stream(request), recorder.beginTurn(request))) {
    // Drain exactly as AgentRuntime.send's caller does.
  }
  await recorder.close();
  await manager.saveSnapshot({ target: agent, isLatest: true });
  await writePointer(WORK_DIR, sessionId);
  assert('the fixture made exactly one local model call while seeding', model.calls === 1);
  assert('the fixture snapshot contains one request/answer pair', agent.messages.length === 2);

  const snapshot = snapshotPath(WORK_DIR, sessionId, 'darwin');
  const pointer = sessionPaths(WORK_DIR).pointerFile;
  const before = await Promise.all([trajectory, snapshot, pointer].map(fileHash));
  const recordsBefore = (await readFile(trajectory, 'utf8')).split('\n').filter(Boolean).length;

  const tui = startTui({ cwd: WORK_DIR, args: ['--resume', sessionId], cols: 120, rows: 50 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 400 });
    const screen = tui.screen;
    const recapAt = screen.indexOf('resume recap · 2 restored model message(s)');
    const requestAt = screen.indexOf('last completed request');
    const answerAt = screen.indexOf('last completed answer');
    const promptAt = screen.lastIndexOf('you>');
    assert('recap, request and answer appear before the prompt',
      recapAt >= 0 && requestAt > recapAt && answerAt > requestAt && promptAt > answerAt);
    assert('the long request is bounded with an explicit marker', screen.includes('resume recap truncated'));
    assert('enabled recording adds no disabled-state warning',
      !screen.includes('trajectory recording is disabled for this run'));
    assert('earlier transcript omission is explicit', screen.includes('earlier session transcript omitted'));
    assert('the current 120x50 frame remains within its viewport', tui.frame.split('\n').length <= 50);

    tui.submit('/exit');
    assert('the resumed TUI exits without an ordinary model turn', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  const after = await Promise.all([trajectory, snapshot, pointer].map(fileHash));
  const recordsAfter = (await readFile(trajectory, 'utf8')).split('\n').filter(Boolean).length;
  assert('trajectory, snapshot and resume pointer are byte-identical after startup',
    before.every((hash, index) => hash === after[index]));
  assert('startup appended no trajectory record', recordsAfter === recordsBefore);

  header('TUI — fresh session has no resume recap');
  const fresh = startTui({ cwd: WORK_DIR, cols: 120, rows: 50 });
  try {
    await fresh.waitFor('you>', { timeoutMs: 60_000, settleMs: 400 });
    assert('fresh startup is unchanged', !fresh.screen.includes('resume recap'));
    fresh.submit('/exit');
    assert('fresh TUI exits without a model call', (await fresh.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    fresh.kill();
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
    // The visual-language pass folded the per-command header hints into the compact
    // `type / for commands` summary; /usage is advertised there and on the busy row.
    assert('the header advertises the command menu', tui.screen.includes('type / for commands'));

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
 * BEFORE the turn's last word. An edited prompt submitted in the same window is
 * queued (SER-027, superseding SER-010's retained-never-queued contract): listed,
 * counted on the busy hint, and sent by itself as the next turn when this one ends.
 */
async function usageDuringATurn(tui: TuiSession): Promise<void> {
  const turn = tui.mark();
  tui.submit('Count from 1 to 60 in words, one per line. Do not use any tools.');
  await tui.waitFor('working…', { timeoutMs: 60_000, from: turn });
  assert('the busy hint says /usage still works', tui.screen.includes('/usage reports tokens'));

  // SER-022: the busy hint is alive. Elapsed time and the session's reported spend
  // ride directly behind `working…` — before the static command hints, so they are
  // what survives truncation — and the elapsed value ticks with the spinner frame.
  const busyReadout = /working… · (\d+s|\d+m \d+s) · (?:↑[\d.]+[kM]? )?↓[\d.]+[kM]? tokens/;
  await tui.waitFor(busyReadout, { timeoutMs: 10_000, from: turn });
  assert('the busy hint carries the live elapsed/spend readout', busyReadout.test(tui.screen.slice(turn)));
  const elapsedSeen = (screen: string): Set<string> =>
    new Set([...screen.slice(turn).matchAll(new RegExp(busyReadout.source, 'g'))].map((match) => match[1] as string));
  await tui.waitUntil((screen) => elapsedSeen(screen).size > 1, {
    timeoutMs: 15_000,
    label: 'a second elapsed reading on the busy hint',
  });
  assert('the busy readout ticks while the turn runs', elapsedSeen(tui.screen).size > 1);

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

  const queuedPrompt = 'Reply with exactly SECOND_TURN_DONE. Do not use tools.';
  const beforeEdit = tui.mark();
  tui.send('Reply with exactly SECOND_TURN_DNE. Do not use tools.');
  // Move before "DNE" and insert the missing O: terminal-observable proof that
  // the streaming editor is active at its cursor, not merely appendable.
  tui.send('\u001b[D'.repeat(21));
  tui.send('O');
  await tui.waitFor(`you> ${queuedPrompt}`, {
    timeoutMs: 30_000,
    from: beforeEdit,
    settleMs: 400,
  });
  assert('cursor-position editing works while streaming', tui.frame.includes(`you> ${queuedPrompt}`));
  assert('Ink leaves the terminal cursor visible while streaming', tui.cursorVisible === true);

  // SER-027 (deliberately superseding SER-010's refusal): a prompt submitted
  // mid-turn is queued — it leaves the editor, is listed above the input box,
  // and the busy hint counts it.
  const beforeQueued = tui.mark();
  tui.send('\r');
  await tui.waitFor(`queued · ${queuedPrompt}`, { timeoutMs: 30_000, from: beforeQueued, settleMs: 400 });
  assert('a prompt submitted mid-turn is queued and listed', tui.frame.includes(`queued · ${queuedPrompt}`));
  assert('the queued prompt left the editor', !tui.frame.includes(`you> ${queuedPrompt}`));
  assert('the busy hint counts the queue', tui.frame.includes('· 1 queued'));
  // Marked after the editor emptied, so the transcript assertion below cannot
  // match a stale repaint of the draft row.
  const afterQueueListed = tui.mark();

  await tui.waitFor(/sixty/i, { timeoutMs: 240_000, from: turn });
  const region = tui.screen.slice(duringTurn);
  assert(
    'the report came before the turn finished',
    region.indexOf('token usage') < region.search(/sixty/i),
  );
  assert('the turn survived being asked', tui.screen.slice(turn).includes('token usage'));

  // The drain: when the first turn ends, the queued prompt is sent by itself as
  // the next turn — no second Enter — and recorded exactly as sent, then.
  await tui.waitFor('SECOND_TURN_DONE', { timeoutMs: 240_000, from: beforeQueued });
  await waitForIdle(tui, 240_000);
  assert('the queued prompt was sent when the turn ended and completed its own turn',
    tui.screen.slice(beforeQueued).includes('SECOND_TURN_DONE'));
  assert('the sent entry is a user row in the transcript, no longer a queued one',
    withoutWhitespace(tui.screen.slice(afterQueueListed)).includes(withoutWhitespace(`you> ${queuedPrompt}`)));
  assert('the drained queue leaves no listing behind', !tui.frame.includes('queued · '));
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

/**
 * Waits for an idle prompt, denying any permission box that appears on the way.
 *
 * For scenarios whose assertions are already done and which only need the turn to
 * *end*. A prompt nobody answers blocks the agent loop for as long as the harness is
 * willing to wait, so "unexpected prompt" has to be a case the teardown handles
 * rather than a case it hangs on. Denial, not approval: a stray call this scenario
 * never asked for should not run.
 */
async function settleTurn(tui: TuiSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let drained = 0; drained < 4; drained += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await tui.waitUntil((screen) => screen.lastIndexOf('you>') > screen.lastIndexOf('working…'), {
        timeoutMs: Math.min(remaining, 30_000),
        label: 'an idle prompt',
        settleMs: 400,
      });
      return;
    } catch {
      if (!awaitsPermission(tui.frame)) continue;
      console.log('  (draining a permission prompt this scenario did not ask for)');
      tui.send('\u001b'); // esc = deny
    }
  }
  await waitForIdle(tui, Math.max(1_000, deadline - Date.now()));
}

/**
 * Drops every space and line break, so a comparison cannot fail on a wrap.
 *
 * For asserting that a long path or command reached the screen: Ink breaks a string
 * wider than the terminal, and the break is not part of what is under test. Safe for
 * values that contain no significant whitespace — a path, a command, an id.
 */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
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

/**
 * `/mode` — the enforcement policy is live session state, and the header says so.
 *
 * Five things a unit test cannot show: the switch reaches the *header* (its one mode
 * row, moved, never doubled), it costs no turn, an unusable argument changes nothing,
 * an idle live frame does not grow by a row, and nothing at all is written to
 * `~/.darwin/config.json` — the one difference from `/effort` and `/model`, and the
 * whole point of the mode being session-scoped.
 *
 * Deliberately makes no model calls: `/mode` sends nothing, so this scenario is free
 * apart from starting the TUI. What the gate then *enforces* mid-session is proven
 * offline in `spike/verify-permission-mode-switch.ts`.
 */
async function modeCommand(): Promise<void> {
  header('TUI — /mode switches the permission mode for this session only');

  await resetWorkDir();
  await writeHomeConfig({ permissionMode: 'default' });

  const tui = startTui({ cwd: WORK_DIR });

  /**
   * The redrawn frame only: `tui.frame` is everything after Ink's last frame erase,
   * which also carries any `<Static>` notice written since — and a notice is
   * transcript, not live frame. The live frame starts at the header's title row, so
   * the last one of those is where the measurement begins.
   */
  const liveFrame = (): string => {
    const text = tui.frame.replaceAll('\r', '');
    let start = 0;
    for (const match of text.matchAll(/(?:^|\n)◆ DARWIN · [^\n]+\n/g)) {
      start = (match.index ?? 0) + (match[0].startsWith('\n') ? 1 : 0);
    }
    return text.slice(start);
  };
  /** Rows Ink redraws, trailing blanks dropped. */
  const frameRows = (): number => liveFrame().replace(/\s+$/, '').split('\n').length;
  /** The header's mode row, which must stay exactly one row however it reads. */
  const modeRows = (): number => (liveFrame().match(/^\s*mode: /gm) ?? []).length;

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('the header starts on the configured mode', tui.screen.includes('mode: default'));
    const rowsBefore = frameRows();
    assert('the header has exactly one mode row to start with', modeRows() === 1);

    const beforeReport = tui.mark();
    tui.submit('/mode');
    await tui.waitFor('permission mode: default', { timeoutMs: 30_000, from: beforeReport, settleMs: 400 });
    const reported = tui.screen.slice(beforeReport);
    assert('a bare /mode reports the mode in force', reported.includes('permission mode: default'));
    assert('…and names every mode it could be given', reported.includes('available: default, auto, plan, yolo'));
    assert('reporting did not start a turn', !reported.includes('working…'));

    const beforePlan = tui.mark();
    tui.submit('/mode plan');
    await tui.waitFor('mode: plan — read-only', { timeoutMs: 30_000, from: beforePlan, settleMs: 400 });
    const planned = tui.screen.slice(beforePlan);
    assert('the switch is confirmed', planned.includes('permission mode: plan'));
    assert('…naming the mode it came from', planned.includes('(was default)'));
    assert('…and stating that it is not remembered', planned.includes(`this session only — ${HOME_CONFIG_LABEL} is unchanged`));
    // Sliced, not searched whole: the startup frame already said `mode: default`.
    assert('the header follows the switch', planned.includes('mode: plan — read-only'));
    assert('switching did not start a turn', !planned.includes('working…'));
    assert('the header still has exactly one mode row', modeRows() === 1);
    assert('…and the live frame is no taller than before', frameRows() === rowsBefore);

    const beforeBad = tui.mark();
    tui.submit('/mode sudo');
    await tui.waitFor('is not a permission mode', { timeoutMs: 30_000, from: beforeBad, settleMs: 400 });
    const refused = tui.screen.slice(beforeBad);
    assert('an unusable argument is refused with the valid values', refused.includes('expected one of default, auto, plan, yolo'));
    assert('…says what is still in force', refused.includes('permission mode: plan — read-only') && refused.includes('(unchanged)'));
    assert('…and does not reach the model as a prompt', !refused.includes('working…'));
    assert('the header still shows plan after the refusal', tui.frame.includes('mode: plan — read-only'));

    const beforeSame = tui.mark();
    tui.submit('/mode plan');
    await tui.waitFor('already in plan mode', { timeoutMs: 30_000, from: beforeSame, settleMs: 400 });
    assert('switching to the mode already in force says so', tui.screen.slice(beforeSame).includes('already in plan mode'));

    const beforeYolo = tui.mark();
    tui.submit('/mode yolo');
    await tui.waitFor('mode: yolo — every tool call runs without confirmation', {
      timeoutMs: 30_000,
      from: beforeYolo,
      settleMs: 400,
    });
    assert('a widening switch is reported too', tui.screen.slice(beforeYolo).includes('permission mode: yolo'));
    assert('the header follows it', tui.frame.includes('mode: yolo'));
    assert('the header still has exactly one mode row in yolo', modeRows() === 1);
    assert('…and still no extra frame row', frameRows() === rowsBefore);

    const beforeBack = tui.mark();
    tui.submit('/mode default');
    await tui.waitFor('(was yolo)', { timeoutMs: 30_000, from: beforeBack, settleMs: 400 });
    assert('the header comes back to default', tui.frame.includes('mode: default'));

    // The one assertion that separates this command from /effort and /model: the file
    // the session was started from is byte-identical, so the next process starts from
    // configured policy again.
    const saved = JSON.parse(await readFile(HOME_CONFIG, 'utf8')) as Record<string, unknown>;
    console.log(`  config after four switches: ${JSON.stringify(saved)}`);
    assert('no switch was written to the config', saved['permissionMode'] === 'default');
    assert('…and nothing else was added to it', Object.keys(saved).length === 1);

    tui.submit('/exit');
    const code = await tui.exitedWithin(EXIT_TIMEOUT_MS);
    assert('TUI exited cleanly after changing the permission mode', code === 0);
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

/** The `session <id>` the header is currently showing, or '' if it is not on screen. */
function headerSessionId(frame: string): string {
  return /session (session-[0-9a-z-]+)/.exec(frame)?.[1] ?? '';
}

/**
 * `/clear` starts a new session; the one being left stays on disk.
 *
 * Free — no model call. What only a pty can show is here: the header moving to the
 * new session, the screen actually being cleared *once*, the old transcript being
 * gone from it, and one notice naming both ids so the saved session is still
 * findable. What files survive a switch is `spike/verify-clear-session.ts`, which can
 * assert bytes; this scenario asserts the previous session's directory is still
 * there, and that the resume pointer has not been handed to the empty new session.
 */
async function clearSession(): Promise<void> {
  header('TUI — /clear starts a new session and keeps the old one');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const firstSession = headerSessionId(tui.frame);
    assert('the header names the session it started in', firstSession !== '');

    // A canary in the first session's own state directory. Without a model call there
    // is no recorded turn and so no record of darwin's own making (the recorder opens
    // the file on the first turn), so these are the bytes that stand in for one — the
    // point being that a session switch neither deletes nor rewrites them.
    // `spike/verify-clear-session.ts` makes the same measurement over a real snapshot.
    const firstTrajectory = trajectoryPath(WORK_DIR, firstSession);
    const canary = '{"type":"canary","note":"stands in for a recorded turn"}\n';
    await mkdir(path.dirname(firstTrajectory), { recursive: true });
    await writeFile(firstTrajectory, canary, 'utf8');

    // Something in the transcript that must not survive the clear. A local report
    // rather than a turn: this scenario makes no model call.
    const beforeMarker = tui.mark();
    tui.submit('/agents');
    await tui.waitFor('subagent dispatches — none in this run', { timeoutMs: 30_000, from: beforeMarker, settleMs: 400 });
    assert('the transcript has content before the clear', tui.frame.includes('subagent dispatches'));

    const beforeArgument = tui.mark();
    tui.submit('/clear extra');
    await tui.waitFor('/clear takes no arguments', { timeoutMs: 30_000, from: beforeArgument, settleMs: 400 });
    const rejected = tui.screen.slice(beforeArgument);
    assert('/clear rejects arguments locally', !rejected.includes('working…'));
    assert('…and does not switch session', headerSessionId(tui.frame) === firstSession);

    const beforeTabArgument = tui.mark();
    tui.submit('/clear\textra');
    await tui.waitFor('/clear takes no arguments', { timeoutMs: 30_000, from: beforeTabArgument, settleMs: 400 });
    assert('/clear rejects non-space argument separators locally', !tui.screen.slice(beforeTabArgument).includes('working…'));

    const beforeClear = tui.mark();
    const rawBeforeClear = tui.raw.length;
    tui.submit('/clear');
    await tui.waitFor('cleared — new session', { timeoutMs: 60_000, from: beforeClear, settleMs: 600 });

    const secondSession = headerSessionId(tui.frame);
    assert('the header moves to a new session', secondSession !== '' && secondSession !== firstSession);
    const notice = tui.screen.slice(beforeClear);
    assert('the notice names the new session', notice.includes(`new session ${secondSession}`));
    assert('…and the previous one, so it stays findable', notice.includes(`Previous session ${firstSession}`));
    assert('…with the command that reopens it', notice.includes(`darwin --session ${firstSession}`));
    assert('/clear starts no model turn', !notice.includes('working…'));

    // One deliberate whole-screen clear, not the per-render clear the frame budget
    // exists to prevent (`.trellis/spec/frontend/live-frame.md`).
    assert('the screen is cleared exactly once', clearCount(tui.raw.slice(rawBeforeClear)) === 1);
    assert('the pre-clear transcript is gone from the frame', !tui.frame.includes('subagent dispatches'));
    assert('the prompt is usable again', tui.frame.includes('you>'));

    // The new session is empty and reports itself, not its predecessor.
    const beforeTrajectory = tui.mark();
    tui.submit('/trajectory');
    await tui.waitFor('trajectory: recording', { timeoutMs: 30_000, from: beforeTrajectory, settleMs: 400 });
    const trajectoryReport = withoutWhitespace(tui.screen.slice(beforeTrajectory));
    assert('/trajectory names the new session\u2019s record', trajectoryReport.includes(secondSession));
    assert('…and not the previous one\u2019s', !trajectoryReport.includes(firstSession));
    assert('…with nothing recorded in it yet', trajectoryReport.includes('recordsthisrun0'));

    // The previous session's bytes are exactly as they were, and `--resume` still
    // points at the session that has something to resume.
    assert('the previous session\u2019s trajectory keeps its bytes', (await readFile(firstTrajectory, 'utf8')) === canary);
    let pointer = '';
    try {
      pointer = await readFile(sessionPaths(WORK_DIR).pointerFile, 'utf8');
    } catch {
      // No pointer at all is the expected state here: no turn has completed.
      pointer = '';
    }
    assert('the empty new session does not claim --resume', !pointer.includes(secondSession));

    tui.submit('/exit');
    assert('TUI exits cleanly after a session switch', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}


/**
 * The teardown helper itself: an unanswered permission box must not hang a run.
 *
 * `settleTurn` exists because the model occasionally volunteers a call the request
 * asked it not to make, leaving a box the scenario never answers. That path was
 * insurance nobody had executed, and insurance nobody has executed is a guess. Here
 * the prompt is left unanswered *deliberately* — bash is always an execute call, so
 * in default mode the box is certain — and the assertion is that teardown denies it
 * and reaches an idle prompt.
 */
async function drainPrompt(): Promise<void> {
  header('TUI — teardown drains a permission prompt nobody answered');

  await resetWorkDir();
  const tui = startTui({ cwd: WORK_DIR });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const turnStart = tui.mark();
    // Redirection, so the gate always stops it: `echo` on its own is allowlisted and
    // would run straight through without a prompt (see `safePassthrough`).
    tui.submit('Run the shell command `echo drain > /tmp/darwin-tui/drain.txt` and then say done.');
    await tui.waitFor('allow?', { timeoutMs: 180_000, from: turnStart, settleMs: 400 });
    assert('a prompt is up and unanswered', awaitsPermission(tui.frame));

    // Not answered here: this is exactly the state that used to burn the timeout.
    await settleTurn(tui, 120_000);
    assert('teardown reached an idle prompt', !awaitsPermission(tui.frame));
    assert('and the unanswered call was denied, not run',
      tui.screen.slice(turnStart).includes('⊘'));

    tui.submit('/exit');
    assert('drain scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}


/**
 * Waits out one frame without anchoring on new output.
 *
 * For the keypresses that are asserted to change *nothing* — a cursor move, a recall
 * that holds at the oldest entry, a menu selection. Ink writes no new text for those, so
 * an anchored `waitFor` would burn its timeout on a screen that is already correct.
 */
function settle(ms = 600): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prompt recall, end to end, with **no model call**: the history it walks is seeded
 * straight into this project's trajectory records, which is exactly where a real
 * session's prompts already are.
 *
 * What only a pty can show is here rather than in `verify-prompt-recall.ts`: that the
 * key bindings coexist — `Up` recalls from an empty draft, moves the cursor inside a
 * multi-row draft, and is taken by the completion menu whenever one is open — and that
 * the records are byte-identical afterwards.
 */
async function promptRecall(): Promise<void> {
  header('TUI — Up recalls previous prompts without taking the cursor or the menu keys');

  const dir = '/tmp/darwin-recall-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Two sessions, so recall has to reach past the newest record, and one prompt repeated
  // twice in a row, so the collapse is observable rather than asserted about.
  const older = trajectoryPath(dir, 'session-20260101-000001');
  const newer = trajectoryPath(dir, 'session-20260102-000001');
  await mkdir(path.dirname(older), { recursive: true });
  await mkdir(path.dirname(newer), { recursive: true });
  const record = (seq: number, at: string, text: string): string =>
    `${JSON.stringify({ v: 1, seq, t: at, turn: 1, type: 'userInput', text })}\n`;
  await writeFile(
    older,
    record(1, '2026-01-01T00:00:01.000Z', 'RECALL_OLDEST from an earlier session') +
      // A skill expansion is recorded expanded, and must never be offered back.
      record(2, '2026-01-01T00:00:02.000Z', `# Skill instructions\nRECALL_EXPANSION_BODY ${'x'.repeat(4100)}`),
    'utf8',
  );
  await writeFile(
    newer,
    record(3, '2026-01-02T00:00:01.000Z', 'RECALL_MIDDLE prompt') +
      record(4, '2026-01-02T00:00:02.000Z', 'RECALL_NEWEST prompt') +
      record(5, '2026-01-02T00:00:03.000Z', 'RECALL_NEWEST prompt'),
    'utf8',
  );
  const digest = async (file: string): Promise<string> =>
    createHash('sha256').update(await readFile(file)).digest('hex');
  const before = [await digest(older), await digest(newer)];

  const tui = startTui({ cwd: dir, cols: 100, rows: 30 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // The read starts on this keystroke, not at startup, and is never awaited by the
    // editor — so the wait is for the frame that arrives once it lands.
    const beforeUp = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('you> RECALL_NEWEST prompt', { timeoutMs: 30_000, from: beforeUp, settleMs: 400 });
    const recalled = tui.frame;
    assert('Up on an empty draft recalls the newest prompt of this project',
      recalled.includes('you> RECALL_NEWEST prompt'));
    assert('and one row states where in history the draft came from',
      /history 1\/3 · ↑ older ↓ newer/.test(recalled));
    assert('recall starts no turn and calls no tool',
      !tui.screen.slice(beforeUp).includes('working…'));

    const beforeSecond = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('you> RECALL_MIDDLE prompt', { timeoutMs: 30_000, from: beforeSecond, settleMs: 400 });
    assert('the duplicate submission collapsed, so Up reaches the previous distinct prompt',
      tui.frame.includes('you> RECALL_MIDDLE prompt') && /history 2\/3/.test(tui.frame));

    const beforeThird = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('you> RECALL_OLDEST from an earlier session', { timeoutMs: 30_000, from: beforeThird, settleMs: 400 });
    const oldest = tui.frame;
    assert('recall reaches prompts from an earlier session of the same project',
      oldest.includes('you> RECALL_OLDEST from an earlier session'));
    assert('the oldest entry says so rather than wrapping around', /history 3\/3 \(oldest\)/.test(oldest));
    assert('and it states the prompt it refused to offer back',
      /long prompt\(s\) skipped/.test(oldest));

    // Nothing changes here, so there is no new frame to anchor on: the assertion is
    // that the draft and the row are still the same ones a beat later.
    tui.send('\u001b[A');
    await settle();
    assert('Up at the oldest entry holds still, and does not wrap to the newest',
      tui.frame.includes('you> RECALL_OLDEST from an earlier session') &&
        tui.frame.includes('history 3/3 (oldest)'));

    // An expanded skill body is in the record and must never be in the editor.
    assert('the expanded skill body is never offered back', !tui.screen.includes('RECALL_EXPANSION_BODY'));

    // Down walks forward, and past the newest it leaves the empty draft it started from.
    const beforeDown = tui.mark();
    tui.send('\u001b[B\u001b[B');
    await tui.waitFor('you> RECALL_NEWEST prompt', { timeoutMs: 30_000, from: beforeDown, settleMs: 400 });
    assert('Down walks back towards the newest prompt', /history 1\/3/.test(tui.frame));
    const beforePast = tui.mark();
    tui.send('\u001b[B');
    await tui.waitFor(/you>\s*(?:\r?\n|$)/, { timeoutMs: 30_000, from: beforePast, settleMs: 400 });
    const ended = tui.frame;
    assert('past the newest, the draft is the empty one the walk started from',
      !ended.includes('RECALL_NEWEST prompt'));
    assert('and the indicator row goes with it', !ended.includes('history 1/3'));

    // The binding: a multi-row draft keeps both arrows for cursor movement. Typed, so
    // the draft is not a recalled entry — recall never replaces text the user typed.
    // Text and the newline in separate *events*: a single write ending in `\n` is a
    // batched Enter and would submit the draft (`chunkedEnter`), which would cost this
    // scenario a model call — so each keystroke is awaited before the next is sent, and
    // Ctrl+J on its own inserts the row break.
    const beforeMultiline = tui.mark();
    tui.send('first typed row');
    await tui.waitFor('you> first typed row', { timeoutMs: 30_000, from: beforeMultiline, settleMs: 400 });
    const beforeBreak = tui.mark();
    tui.send('\n');
    await tui.waitFor('...> ', { timeoutMs: 30_000, from: beforeBreak, settleMs: 400 });
    const beforeSecondRow = tui.mark();
    tui.send('second typed row');
    await tui.waitFor('...> second typed row', { timeoutMs: 30_000, from: beforeSecondRow, settleMs: 400 });
    // Cursor movement changes no text, so — like the still Up above — there is no new
    // frame to anchor on and the assertion is what the frame shows a beat later.
    tui.send('\u001b[A');
    await settle();
    const moved = tui.frame;
    assert('Up in a multi-line draft moves the cursor and does not recall',
      moved.includes('you> first typed row') && moved.includes('...> second typed row') &&
        !moved.includes('RECALL_NEWEST'));
    assert('and no recall row is drawn for a draft the user typed', !moved.includes('history '));

    // Once at the top row, Up still must not replace typed text.
    tui.send('\u001b[A');
    await settle();
    assert('Up at the first row of a typed draft recalls nothing',
      tui.frame.includes('you> first typed row') && !tui.frame.includes('RECALL_NEWEST'));

    // The menu keeps both arrows. `/` opens the command menu, which is the state where
    // Up must select a row rather than reach into history.
    // Down (outside a walk) and End put the cursor back at the end of the draft, which
    // is where backspace has to start to clear it; it crosses the row break on the way
    // (see `multiline`).
    tui.send('\u001b[B');
    tui.send('\u001b[F');
    await settle(200);
    tui.send('\u007f'.repeat('first typed row\nsecond typed row'.length + 4));
    const beforeMenu = tui.mark();
    tui.send('/');
    await tui.waitFor('commands (', { timeoutMs: 30_000, from: beforeMenu, settleMs: 400 });
    tui.send('\u001b[A');
    await settle();
    const menu = tui.frame;
    assert('Up with a command menu open selects a row and does not recall',
      menu.includes('commands (') && menu.includes('you> /') && !menu.includes('RECALL_NEWEST'));
    assert('and draws no recall row either', !menu.includes('history 1/3'));

    tui.send('\u007f');
    tui.send('\u0004');
    assert('recall scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);

    // The whole feature is a reader: what it read is byte-identical afterwards.
    assert('every trajectory record is byte-identical after recall',
      (await digest(older)) === before[0] && (await digest(newer)) === before[1]);
    let pointerExists = true;
    try {
      await readFile(sessionPaths(dir).pointerFile, 'utf8');
    } catch {
      pointerExists = false;
    }
    assert('and the resume pointer was never written by a session that only recalled',
      !pointerExists);
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A project with no record at all, and a session configured not to write one: both
 * degrade to "no history" with a usable editor, and neither is an error.
 */
async function promptRecallWithoutRecord(): Promise<void> {
  header('TUI — no trajectory record degrades to no history, not to an error');

  const dir = '/tmp/darwin-recall-empty-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // `trajectory: false` is a supported configuration, so recall has to be usable in a
  // session that records nothing at all.
  await writeHomeConfig({ trajectory: false });

  const tui = startTui({ cwd: dir, cols: 100, rows: 30 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const beforeUp = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('history: no earlier prompts in this project', {
      timeoutMs: 30_000,
      from: beforeUp,
      settleMs: 400,
    });
    const empty = tui.frame;
    assert('a project with no record says so in one row',
      empty.includes('history: no earlier prompts in this project'));
    assert('nothing is reported as a failure',
      !tui.screen.slice(beforeUp).includes('could not') && !tui.screen.slice(beforeUp).includes('Error'));

    // Usable: the editor still takes text, and the notice goes away when it does.
    const beforeType = tui.mark();
    tui.send('still typable');
    await tui.waitFor('you> still typable', { timeoutMs: 30_000, from: beforeType, settleMs: 400 });
    assert('the editor is untouched by an empty history',
      tui.frame.includes('you> still typable') && !tui.frame.includes('no earlier prompts'));

    tui.send('\u007f'.repeat('still typable'.length));
    tui.send('\u0004');
    assert('empty-history scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
    await rm(HOME_CONFIG, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The `!` prefix (SER-024), free — no model call: a user-typed shell command runs
 * directly (in plan mode, deliberately: the gate's subject is model tool calls),
 * its live output reaches the panel while it runs, a submission during it is
 * queued and runs when it finishes (SER-027, superseding SER-010), Ctrl+C kills
 * it without costing the
 * session, and everything that ran is on screen and in the trajectory record —
 * as `shellCommand` records, never as `userInput` lines.
 */
async function bangShellCommand(): Promise<void> {
  header('TUI — ! runs a user shell command: live output, retention, cancel, record');

  const dir = '/tmp/darwin-bang-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await rm(HOME_CONFIG, { force: true });

  // Plan mode on purpose: `!` is user-authorized and must run where the model
  // could not — the strongest statement of the policy decision.
  const tui = startTui({ cwd: dir, cols: 100, rows: 30, args: ['--permission-mode', 'plan'] });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    await tui.waitFor('mode: plan', { timeoutMs: 60_000 });

    // A command slow enough to catch mid-flight: live tail, header status, hint.
    // Typed with extra whitespace after the `!`, so the normalized user row the
    // transcript commits is provably not just the draft echo.
    const beforeSlow = tui.mark();
    tui.submit("!  sh -c 'echo LIVE_TAIL_ROW; sleep 2'");
    await tui.waitFor('LIVE_TAIL_ROW', { timeoutMs: 30_000, from: beforeSlow, settleMs: 200 });
    const running = tui.frame;
    assert('the command echoes as a normalized user row',
      tui.screen.slice(beforeSlow).includes("!sh -c 'echo LIVE_TAIL_ROW; sleep 2'"));
    assert('live output reaches the panel while the command runs',
      running.includes('LIVE_TAIL_ROW') && running.includes('$ sh -c'));
    assert('the header states the running command', running.includes('running !'));
    assert('the hint row says how to cancel', running.includes('running ! command… ctrl+c cancels it'));

    // SER-027 (superseding SER-010): a submission while one runs is queued —
    // listed above the input box, counted on the busy hint — and a queued `!`
    // runs when the current one finishes, held and executed one at a time.
    const beforeQueued = tui.mark();
    tui.submit('!echo QUEUED_AFTER');
    await tui.waitFor('queued · !echo QUEUED_AFTER', { timeoutMs: 30_000, from: beforeQueued, settleMs: 200 });
    assert('a mid-command submission is queued, listed and leaves the editor',
      tui.frame.includes('queued · !echo QUEUED_AFTER') &&
      !tui.frame.includes('you> !echo QUEUED_AFTER'));
    assert('the busy hint counts the queue', tui.frame.includes('· 1 queued'));

    await tui.waitFor("$ sh -c 'echo LIVE_TAIL_ROW; sleep 2' (exit 0 in", { timeoutMs: 30_000, from: beforeSlow, settleMs: 300 });
    assert('the finished row states command and outcome',
      /\$ sh -c 'echo LIVE_TAIL_ROW; sleep 2' \(exit 0 in \d+m?s\)/.test(tui.screen.slice(beforeSlow)));
    // The drain: the queued command runs by itself once the session is free.
    await tui.waitFor('$ echo QUEUED_AFTER (exit 0 in', { timeoutMs: 30_000, from: beforeQueued, settleMs: 300 });
    assert('the queued ! command ran when the running one finished',
      tui.screen.slice(beforeQueued).includes('$ echo QUEUED_AFTER (exit 0 in'));
    assert('the drained queue leaves no listing behind', !tui.frame.includes('queued · '));

    // A non-zero exit is an error row with its real code, output kept.
    const beforeFail = tui.mark();
    tui.submit("!sh -c 'echo OOPS_LINE; exit 3'");
    await tui.waitFor('(exit 3 in', { timeoutMs: 30_000, from: beforeFail, settleMs: 300 });
    assert('a failing command reports its exit code', tui.screen.slice(beforeFail).includes('(exit 3 in'));
    assert('and its output', tui.screen.slice(beforeFail).includes('OOPS_LINE'));

    // Ctrl+C kills the running command without costing the session.
    const beforeCancel = tui.mark();
    tui.submit('!sleep 30');
    await tui.waitFor('running ! command…', { timeoutMs: 30_000, from: beforeCancel, settleMs: 200 });
    tui.send('\u0003');
    await tui.waitFor('killed by SIGTERM', { timeoutMs: 30_000, from: beforeCancel, settleMs: 300 });
    assert('ctrl+c kills the command and says so',
      tui.screen.slice(beforeCancel).includes('$ sleep 30 (killed by SIGTERM'));

    // A bare ! is a usage notice, not an error and not a prompt.
    const beforeBare = tui.mark();
    tui.submit('!');
    await tui.waitFor('! runs a shell command: !<command>', { timeoutMs: 30_000, from: beforeBare, settleMs: 200 });

    // None of the above was a model turn.
    assert('no turn ever started — the model was never called', !tui.screen.includes('working…'));

    tui.send('\u0004');
    assert('bang scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);

    // The record: every command is a `shellCommand` record; none is a `userInput`
    // line, so prompt recall will never offer one back.
    const sessionsRoot = path.dirname(path.dirname(trajectoryPath(dir, 'placeholder')));
    const { readdir } = await import('node:fs/promises');
    const sessionDirs = await readdir(sessionsRoot);
    assert('the session wrote exactly one record', sessionDirs.length === 1);
    const recordFile = trajectoryPath(dir, sessionDirs[0] as string);
    const lines = (await readFile(recordFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const shellRecords = lines.filter((record) => record['type'] === 'shellCommand');
    assert('every ! command reached the trajectory record — the queued one included', shellRecords.length === 4);
    assert('the record carries command, outcome and bounded output',
      shellRecords.some((record) =>
        record['command'] === "sh -c 'echo LIVE_TAIL_ROW; sleep 2'" && record['exitCode'] === 0 &&
        (record['output'] as string).includes('LIVE_TAIL_ROW')) &&
      shellRecords.some((record) => record['exitCode'] === 3 && (record['output'] as string).includes('OOPS_LINE')) &&
      shellRecords.some((record) => record['command'] === 'sleep 30' && record['signal'] === 'SIGTERM'));
    assert('the queued command was recorded at send time, exactly as sent',
      shellRecords.some((record) => record['command'] === 'echo QUEUED_AFTER' && record['exitCode'] === 0));
    assert('no ! command was recorded as a prompt', !lines.some((record) => record['type'] === 'userInput'));
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The prompt queue's user-visible state machine (SER-027), free — no model call:
 * a `!` command is the busy state, exactly as `bang` uses it. Entries queued
 * while it runs are listed and counted; `Up` from the first row takes the whole
 * queue back into the editor ahead of typed text without touching recall or
 * cursor movement; Ctrl+C returns the queue unsent instead of draining it; the
 * `/clear` family refuses to queue with the draft retained; and none of it ever
 * becomes a `userInput` record, because nothing was ever sent.
 */
async function queueTakeback(): Promise<void> {
  header('TUI — the prompt queue: listing, take-back, cancel return, refusal');

  const dir = '/tmp/darwin-queue-tui';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await rm(HOME_CONFIG, { force: true });

  const tui = startTui({ cwd: dir, cols: 100, rows: 30 });

  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    // --- Take-back: entries land one per line, ahead of typed text. ---
    const beforeBusy = tui.mark();
    tui.submit('!sleep 8');
    await tui.waitFor('running ! command…', { timeoutMs: 30_000, from: beforeBusy, settleMs: 200 });

    const beforeAlpha = tui.mark();
    tui.submit('alpha entry');
    await tui.waitFor('queued · alpha entry', { timeoutMs: 30_000, from: beforeAlpha, settleMs: 200 });
    const beforeBeta = tui.mark();
    tui.submit('beta entry');
    await tui.waitFor('queued · beta entry', { timeoutMs: 30_000, from: beforeBeta, settleMs: 200 });
    assert('both entries are listed, oldest first',
      tui.frame.indexOf('queued · alpha entry') < tui.frame.indexOf('queued · beta entry'));
    assert('the busy hint counts two queued', tui.frame.includes('· 2 queued'));

    const beforeTyped = tui.mark();
    tui.send('gamma typed');
    await tui.waitFor('you> gamma typed', { timeoutMs: 30_000, from: beforeTyped, settleMs: 200 });

    // Up from the first (only) visual row of the typed draft: the queue comes
    // back ahead of the typed text, and the listing empties.
    const beforeTakeback = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('you> alpha entry', { timeoutMs: 30_000, from: beforeTakeback, settleMs: 300 });
    const frame = tui.frame;
    assert('take-back puts the queue ahead of the typed text, one per line',
      frame.includes('you> alpha entry') &&
      frame.indexOf('alpha entry') < frame.indexOf('beta entry') &&
      frame.indexOf('beta entry') < frame.indexOf('gamma typed'));
    assert('the taken-back queue is no longer listed', !frame.includes('queued · '));
    assert('nothing was sent by the take-back', !tui.screen.slice(beforeTakeback).includes('working…'));

    // The command is still running; cancel it. The queue is already empty, so
    // nothing is "returned" and the draft must stay exactly as taken back.
    tui.send('\u0003');
    await tui.waitFor('killed by SIGTERM', { timeoutMs: 30_000, from: beforeBusy, settleMs: 300 });
    assert('cancelling with an empty queue reports no queue return',
      !tui.screen.slice(beforeTakeback).includes('returned to the editor'));
    assert('the taken-back draft survives the cancel', tui.frame.includes('you> alpha entry'));
    // Delete the three-row draft: kill each row and the newline joining it.
    tui.send('\u0015\u007f\u0015\u007f\u0015');

    // --- Cancel: a queued entry is returned unsent, never silently sent. ---
    const beforeCancelRun = tui.mark();
    tui.submit('!sleep 30');
    await tui.waitFor('running ! command…', { timeoutMs: 30_000, from: beforeCancelRun, settleMs: 200 });
    tui.submit('delta entry');
    await tui.waitFor('queued · delta entry', { timeoutMs: 30_000, from: beforeCancelRun, settleMs: 200 });
    tui.send('\u0003');
    await tui.waitFor('1 queued message returned to the editor, not sent', {
      timeoutMs: 30_000,
      from: beforeCancelRun,
      settleMs: 300,
    });
    assert('a cancel returns the queued entry to the editor and says so',
      tui.frame.includes('you> delta entry'));
    assert('the returned entry is no longer listed as queued', !tui.frame.includes('queued · delta entry'));
    assert('the cancelled busy state never sent it', !tui.screen.slice(beforeCancelRun).includes('working…'));
    tui.send('\u0015'); // clear the returned one-row draft

    // --- The /clear family refuses to queue, draft retained. ---
    const beforeRefusal = tui.mark();
    tui.submit("!sh -c 'sleep 2'");
    await tui.waitFor('running ! command…', { timeoutMs: 30_000, from: beforeRefusal, settleMs: 200 });
    tui.submit('/clear');
    await tui.waitFor('/clear does not queue — press enter again when the ! command finishes', {
      timeoutMs: 30_000,
      from: beforeRefusal,
      settleMs: 200,
    });
    assert('/clear keeps the retention shape: draft still in the editor',
      tui.frame.includes('you> /clear'));
    assert('/clear was not queued', !tui.screen.slice(beforeRefusal).includes('queued · /clear'));
    await tui.waitFor("$ sh -c 'sleep 2' (exit 0 in", { timeoutMs: 30_000, from: beforeRefusal, settleMs: 300 });
    tui.send('\u0015'); // clear the retained /clear draft

    // --- With the queue empty, Up is prompt recall again, untouched. ---
    const beforeRecall = tui.mark();
    tui.send('\u001b[A');
    await tui.waitFor('history: no earlier prompts in this project', {
      timeoutMs: 30_000,
      from: beforeRecall,
      settleMs: 300,
    });
    assert('an empty queue leaves Up to prompt recall',
      tui.frame.includes('history: no earlier prompts in this project'));

    tui.send('\u0004');
    assert('queue scenario exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);

    // Trajectory honesty: nothing above was sent, so nothing is a `userInput`
    // line — taken-back, cancel-returned and refused entries leave no record.
    const sessionsRoot = path.dirname(path.dirname(trajectoryPath(dir, 'placeholder')));
    const { readdir } = await import('node:fs/promises');
    const sessionDirs = await readdir(sessionsRoot);
    assert('the session wrote exactly one record', sessionDirs.length === 1);
    const recordFile = trajectoryPath(dir, sessionDirs[0] as string);
    const lines = (await readFile(recordFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert('no queued entry that was never sent left a userInput record',
      !lines.some((record) => record['type'] === 'userInput'));
    assert('the ! busy states themselves were recorded as shellCommand records',
      lines.filter((record) => record['type'] === 'shellCommand').length === 3);
  } finally {
    tui.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stdio MCP banner must never write outside Ink and corrupt the startup frame. */
async function mcpStderrIsolation(): Promise<void> {
  header('TUI — stdio MCP stderr is isolated from the Ink frame');

  await resetWorkDir();
  const mcpConfig = path.join(OWNED_HOME, DARWIN_DIRNAME, 'mcp.json');
  const marker = 'NOISY_MCP_STDERR_MUST_NOT_REACH_TUI';
  await writeFile(
    mcpConfig,
    `${JSON.stringify({
      mcpServers: {
        noisy: {
          command: process.execPath,
          args: [path.join(import.meta.dirname, 'fixtures', 'noisy-mcp.mjs')],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    assert('the configured MCP server connected', tui.screen.includes('1 MCP server'));
    assert('the server banner never reached the terminal', !tui.screen.includes(marker));

    tui.submit('/exit');
    assert('TUI exits cleanly with the stdio server connected',
      (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
    await rm(mcpConfig, { force: true });
  }
}

/**
 * `/mcp`, end to end and free: one healthy stdio server (an in-repo fixture, no
 * network) and one whose command cannot exist, plus a root `.mcp.json` that the
 * project `.darwin/mcp.json` makes inert. The report must name all of it — the
 * broken server as failed rather than silently absent — without a model call,
 * and asking must not change any connection state (the healthy server still
 * answers in the second report).
 */
async function mcpReport(): Promise<void> {
  header('TUI — /mcp names every configured server and its state');

  await resetWorkDir();
  const projectDarwinDir = path.join(WORK_DIR, DARWIN_DIRNAME);
  await mkdir(projectDarwinDir, { recursive: true });
  await writeFile(
    path.join(projectDarwinDir, 'mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        calc: {
          command: process.execPath,
          args: [path.join(import.meta.dirname, 'fixtures', 'tools-mcp.mjs')],
        },
        broken: { command: 'this-command-does-not-exist-anywhere', args: [] },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  // Present but inert: the preferred file above takes precedence, and the report
  // has to say so instead of leaving two files both claiming to be in effect.
  await writeFile(
    path.join(WORK_DIR, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { ghost: { command: 'true', args: [] } } }, null, 2)}\n`,
    'utf8',
  );

  const tui = startTui({ cwd: WORK_DIR });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000 });

    const beforeArgument = tui.mark();
    tui.submit('/mcp extra');
    await tui.waitFor('/mcp takes no arguments', { timeoutMs: 30_000, from: beforeArgument, settleMs: 400 });
    assert('/mcp degrades an unknown argument to a usage notice without starting a turn',
      !tui.screen.slice(beforeArgument).includes('working…'));

    const beforeReport = tui.mark();
    tui.submit('/mcp');
    await tui.waitFor('mcp servers (2)', { timeoutMs: 30_000, from: beforeReport, settleMs: 400 });
    const reportText = tui.screen.slice(beforeReport);
    assert('/mcp answers without a model call', !reportText.includes('working…'));
    assert('the healthy server is connected with its tool count', reportText.includes('connected · 3 tools:'));
    assert('the healthy server lists agent-facing tool names', reportText.includes('calc_alpha'));
    assert('the failed server is stated as failed, not omitted',
      reportText.includes('broken') && reportText.includes('failed — could not connect'));
    assert('the config file in effect is named', reportText.includes(path.join(DARWIN_DIRNAME, 'mcp.json')));
    assert('the ignored root .mcp.json is stated as inert', reportText.includes('ignored:'));

    // Asking again must read the same states: the report connects nothing and
    // retries nothing, so the answer is stable.
    const beforeSecond = tui.mark();
    tui.submit('/mcp');
    await tui.waitFor('mcp servers (2)', { timeoutMs: 30_000, from: beforeSecond, settleMs: 400 });
    const second = tui.screen.slice(beforeSecond);
    assert('a second /mcp reports the same states — reading did not mutate',
      second.includes('connected · 3 tools:') && second.includes('failed — could not connect'));

    // /status (SER-026) consolidates the same projection: the failed server is
    // stated as failed there too — never omitted — and asking must be exactly as
    // read-only as /mcp itself.
    const beforeStatus = tui.mark();
    tui.submit('/status');
    await tui.waitFor('status — this session', { timeoutMs: 30_000, from: beforeStatus, settleMs: 400 });
    const statusReport = tui.screen.slice(beforeStatus);
    assert('/status answers without a model call', !statusReport.includes('working…'));
    assert('/status counts both configured servers', statusReport.includes('2 servers — '));
    assert('/status states the connected server with its tool count', statusReport.includes('calc connected (3 tools)'));
    assert('/status states the failed server as failed, like /mcp', statusReport.includes('broken failed — could not connect'));

    tui.submit('/exit');
    assert('TUI exits cleanly with the report shown', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
    await rm(path.join(WORK_DIR, '.mcp.json'), { force: true });
    await rm(projectDarwinDir, { recursive: true, force: true });
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
  compacting: compactingInputOwnership,
  cursor: cursorEditing,
  completion: slashCompletion,
  pathCompletion,
  recall: promptRecall,
  recallEmpty: promptRecallWithoutRecord,
  resume: resumedHumanContext,
  bang: bangShellCommand,
  queue: queueTakeback,
  clear: clearSession,
  mcpStderr: mcpStderrIsolation,
  mcp: mcpReport,
  toolDetails: toolDetailsToggle,
  agents: agentDispatches,
  agentsMd: agentsMdHeader,
  usage: usageReport,
  tasks: taskMonitoring,
  effort: effortCommand,
  model: modelCommand,
  mode: modeCommand,
  plan: planHeader,
  longAnswer,
  tallDraft,
  tallDraftStreaming,
  drainPrompt,
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
