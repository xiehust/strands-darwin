/**
 * Unit checks for the base system prompt: the built-in default, the two override
 * mechanisms and their precedence, and how a broken override degrades.
 *
 * No model calls — this is file reading, validation and string assembly. That the
 * base prompt actually steers the model is covered by the live scenarios in
 * spike/verify-step-1-2.ts and spike/acceptance-e2e.ts.
 *
 * Run: pnpm tsx spike/verify-system-prompt.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { composeSystemPrompt, loadProjectInstructions, AGENTS_FILENAME, CLAUDE_FILENAME } from '../src/agent/instructions.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  HEADLESS_AUTONOMY_SECTION,
  SYSTEM_PROMPT_FILENAME,
  loadSystemPrompt,
} from '../src/agent/system-prompt.js';
import { ConfigError, configPath, loadConfig } from '../src/config.js';
import { darwinDir } from '../src/paths.js';
import { BackgroundBashManager, createBackgroundBashTool } from '../src/tools/background-bash.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-system-prompt';

// The `systemPrompt` cases write the global config through configPath().
const OWNED_HOME = ownPrivateHome('system-prompt');

/** The bash tool exactly as the runtime registers it; only its spec is read here. */
function bashToolSpec(): { description: string; inputSchema?: unknown } {
  return createBackgroundBashTool(new BackgroundBashManager(ROOT, 'system-prompt-spec')).toolSpec;
}

function bashToolDescription(): string {
  return bashToolSpec().description;
}

function bashModeDescription(): string {
  const schema = bashToolSpec().inputSchema as { properties?: { mode?: { description?: string } } } | undefined;
  return schema?.properties?.mode?.description ?? '';
}

/** A fresh project directory with a `.darwin/` in place, like a real run has. */
async function project(): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(darwinDir(dir), { recursive: true });
  return dir;
}

/** Writes `.darwin/system-prompt.md`, the convention override file. */
async function writeOverride(projectRoot: string, contents: string): Promise<string> {
  const file = path.join(darwinDir(projectRoot), SYSTEM_PROMPT_FILENAME);
  await writeFile(file, contents, 'utf8');
  return file;
}

async function defaultPrompt(): Promise<void> {
  header('system prompt — the built-in default is used when nothing overrides it');

  const loaded = await loadSystemPrompt(await project());

  assert(
    'global config fixtures resolve inside this suite\'s own HOME',
    configPath(ROOT).startsWith(`${OWNED_HOME}${path.sep}`),
  );
  assert('the default is in effect', loaded.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the source is reported as default', loaded.source === 'default');
  assert('no path is reported', loaded.path === undefined);
  assert('a missing override file is not a problem worth reporting', loaded.problem === undefined);

  // The default is coding-agent instructions, not a generic assistant preamble. It
  // names no tool: descriptions are the contract, and a catalogue here would list
  // tools that are only sometimes registered (memory, MCP) while omitting others.
  // The bash guidance it used to carry lives in the bash tool's own description.
  assert('it carries no tool catalogue', !/^- \w+:/mu.test(DEFAULT_SYSTEM_PROMPT));
  assert('it defers tool mechanics to the tool descriptions', /Each tool's description is its contract/.test(DEFAULT_SYSTEM_PROMPT));
  for (const toolName of ['imageViewer', 'load_skill', 'update_plan', 'memory_recall', 'memory_save', 'subagent', 'workflow']) {
    assert(`it does not name the ${toolName} tool`, !DEFAULT_SYSTEM_PROMPT.includes(toolName));
  }
  assert(
    'the bash mode requirement moved into the bash parameter description',
    /required on every call/.test(bashModeDescription()) && /bare \{command\}/.test(bashModeDescription()),
  );
  assert(
    'the ssh hazard moved into the bash tool description',
    /-T -o BatchMode=yes/.test(bashToolDescription()) && /waits on a tty/.test(bashToolDescription()),
  );
  assert('it tells the model to read before editing', /have not read/i.test(DEFAULT_SYSTEM_PROMPT));
  assert('it tells the model to verify its work', /verify/i.test(DEFAULT_SYSTEM_PROMPT));
  assert(
    'it tells the model not to work around a denied tool call',
    /denied/.test(DEFAULT_SYSTEM_PROMPT) && /work around/.test(DEFAULT_SYSTEM_PROMPT),
  );
  // Re-baselined for current models: lead with the outcome, readability over
  // compression, and say when user-facing text is wanted during long tool runs.
  assert('it leads with the outcome', /Lead with the outcome/.test(DEFAULT_SYSTEM_PROMPT));
  assert('it prefers readable over compressed output', /readable rather than\n\s*compressed/.test(DEFAULT_SYSTEM_PROMPT));
  assert('it tells the model tool output is not shown to the user in full', /Only you see a tool's full output/.test(DEFAULT_SYSTEM_PROMPT));
  assert('the interactive prompt still asks before guessing', /ask before implementing a guess/.test(DEFAULT_SYSTEM_PROMPT));
  assert('the interactive prompt carries no autonomy section', !DEFAULT_SYSTEM_PROMPT.includes('operating autonomously'));
  // The headless section is separate: it overrides the ask-before-guessing rule for
  // runs where no one answers, and only the headless driver appends it.
  assert('the headless section says the user is not watching', /not watching in real time/.test(HEADLESS_AUTONOMY_SECTION));
  assert('the headless section overrides asking with stated assumptions', /state the assumption you made and continue/.test(HEADLESS_AUTONOMY_SECTION));
  assert('the headless section closes the announce-then-stop gap', /check your last paragraph/.test(HEADLESS_AUTONOMY_SECTION));
  // The issue-#8 round-trip rules: every model round replays the whole conversation,
  // so independent reads share one message and known edits are not dribbled out one
  // small str_replace per round.
  assert(
    'it tells the model to batch independent reads into one message',
    /Batch independent reads/.test(DEFAULT_SYSTEM_PROMPT) &&
      /together in one assistant message/.test(DEFAULT_SYSTEM_PROMPT),
  );
  assert(
    'it tells the model to consolidate known edits instead of one per round',
    /Consolidate edits/.test(DEFAULT_SYSTEM_PROMPT) &&
      /one small str_replace per round/.test(DEFAULT_SYSTEM_PROMPT),
  );
  // SRF-032: one whole-document tool-call payload can exceed what the provider stream
  // completes, and the same payload dies the same way on the continuation (measured:
  // two processes, $5.88, zero files written), so rule 3 orders long new files as a
  // skeleton filled section by section with bounded edits. Naming str_replace/insert
  // here is consistent with rules 7/8, which already name fileEditor.
  assert(
    'it tells the model to create long new files as a skeleton filled per section (SRF-032)',
    DEFAULT_SYSTEM_PROMPT.includes('is created as a skeleton (title, headings, short placeholders) and filled section') &&
      DEFAULT_SYSTEM_PROMPT.includes('separate str_replace/insert calls, each bounded to a few thousand words') &&
      DEFAULT_SYSTEM_PROMPT.includes('whole-document tool-call payload can exceed what the provider stream completes'),
  );
}

/**
 * SRF-034: rule 4 extends verification from code changes to reported numbers. The
 * clause is pinned inside rule 4 only (SRF-035 edits beside rule 5), names no tool,
 * and the arithmetic below is the computation it asks for, run over the attribution
 * table that motivated it (trajectory turn 15 / seq 753 of session-20260924-010948157).
 * These checks prove the instruction contract, not that a model follows it.
 */
function numericReportVerification(): void {
  header('system prompt — rule 4 asks for computed, reconciled numeric reports (SRF-034)');

  const start = DEFAULT_SYSTEM_PROMPT.indexOf('\n4. Verify your work');
  const end = DEFAULT_SYSTEM_PROMPT.indexOf('\n5. After a tool fails twice');
  const rule4 = start >= 0 && end > start ? DEFAULT_SYSTEM_PROMPT.slice(start, end) : '';
  const flat = rule4.replace(/\s+/gu, ' ');
  assert('rule 4 is found, directly followed by rule 5', rule4 !== '');
  assert('it asks to compute summaries with a local tool rather than mentally',
    flat.includes('compute sums and other summaries with an available local tool rather than mentally'));
  assert('it asks to reconcile components against the authoritative total, units and time window',
    flat.includes('reconcile the components against the authoritative total, units and time window'));
  assert('it separates requested from executed and observed from estimated/counterfactual values',
    flat.includes('Keep requested apart from executed quantities') &&
      flat.includes('observed apart from estimated or counterfactual values'));
  assert('it asks to state missing evidence or a residual instead of claiming reconciliation',
    flat.includes('state missing evidence or an unexplained residual instead of claiming the figures reconcile'));
  // No tool name in the rule: the base prompt defers mechanics to tool descriptions.
  const toolNames = ['bash', 'fileEditor', 'http_request', 'web_fetch', 'imageViewer', 'load_skill', 'update_plan',
    'memory_recall', 'memory_save', 'subagent', 'workflow', 'retrieve_offloaded_content'];
  assert('the numeric clause names no tool', toolNames.every((name) => !rule4.includes(name)));
  assert('the clause carries no domain-specific wording', !/trad|order|fill|price|profit/iu.test(rule4));
  // The rules around it are untouched: rule 5's retry wording is pinned by verify-retry-guard.ts.
  assert('rule 5 still follows unchanged',
    DEFAULT_SYSTEM_PROMPT.includes('5. After a tool fails twice with the same cause, state a materially new evidence-backed hypothesis'));

  // The eight amounts the seq-753 table displayed, against its stated net increase.
  const components = [379_996, 197_950, -44_618, 234_228, 45_780, 5_000, -411, -382];
  const statedTotal = 817_643;
  const sum = components.reduce((total, amount) => total + amount, 0);
  console.log(`  components sum ${sum} vs stated ${statedTotal}: residual ${statedTotal - sum}`);
  assert('computing the displayed components exposes the 100-unit discrepancy',
    sum === 817_543 && statedTotal - sum === 100);
  // Requested (not executed) quantities from seq 751 plus the 200-unit opening gift,
  // against the balance observed at turn 13 / seq 708.
  const implied = 200 + 27_200 - 24_323;
  const observed = 5_200.39933617;
  console.log(`  implied balance ${implied} vs observed ${observed}`);
  assert('the quantity balance built from requested quantities does not reconcile',
    implied === 3_077 && Math.abs(observed - implied) > 1);
}

/**
 * SRF-035: rule 5 continues from the agent's own tool retries to code it writes to act
 * unattended. The runtime retry guard (SRF-016) counts SDK tool results only, so eleven
 * same-class rejections inside one successful background wait (session-20260924-010948157,
 * turn 2 / seq 388) were invisible to it; the prompt is the seam for generated code. The
 * clause keeps three failure kinds apart — deterministic rejection, transient limit,
 * ambiguous write — because each needs a different retry policy. Pinned inside the rule-5
 * slice only; these checks prove the instruction contract, not that a model follows it.
 */
function generatedAutomationRetry(): void {
  header('system prompt — rule 5 bounds retries in generated unattended code (SRF-035)');

  const start = DEFAULT_SYSTEM_PROMPT.indexOf('\n5. After a tool fails twice');
  const end = DEFAULT_SYSTEM_PROMPT.indexOf('\n6. ');
  const rule5 = start >= 0 && end > start ? DEFAULT_SYSTEM_PROMPT.slice(start, end) : '';
  const flat = rule5.replace(/\s+/gu, ' ');
  assert('rule 5 is found, directly followed by rule 6', rule5 !== '');
  // The tool-retry limits stay first and verbatim (verify-retry-guard.ts pins the same phrases).
  assert('the tool-retry hypothesis and three-failure limit are still rule 5',
    flat.includes('After a tool fails twice with the same cause, state a materially new evidence-backed hypothesis before retrying.') &&
      flat.includes('Three equivalent failures are the limit: stop, report the blocker and collected artifacts, and ask the user before continuing in a new turn.'));
  assert('the new clause follows the existing text, not before it',
    flat.indexOf('before continuing in a new turn.') < flat.indexOf('Code you write to run unattended'));
  assert('it scopes the clause to generated unattended code with side effects',
    flat.includes('Code you write to run unattended with side effects needs the same bounds'));
  assert('deterministic rejections are bounded, then the action pauses with a reason until inputs or state change',
    flat.includes('after a bounded number of identical deterministic rejections, pause that action with its reason stated until inputs or observed state change'));
  assert('transient limits get bounded backoff that honours a server-directed delay',
    flat.includes('retry transient limits a bounded number of times with backoff, honouring any server-directed delay'));
  assert('ambiguous write outcomes are reconciled or made idempotent before replay',
    flat.includes("when a state-changing request's outcome is ambiguous") &&
      flat.includes('reconcile the actual state or use an idempotency key before replaying it'));
  assert('it asks for offline response-sequence checks before an unattended launch, when feasible',
    flat.includes('When feasible, check such a script against representative offline response sequences before an unattended launch.'));
  const toolNames = ['bash', 'fileEditor', 'str_replace', 'http_request', 'web_fetch', 'imageViewer', 'load_skill',
    'update_plan', 'memory_recall', 'memory_save', 'subagent', 'workflow', 'retrieve_offloaded_content'];
  assert('rule 5 names no tool', toolNames.every((name) => !rule5.includes(name)));
  assert('rule 5 carries no domain-specific wording',
    !/trad|order|fill|price|profit|position|borrow|short|leverage|HTTP|\b4\d\d\b/iu.test(rule5));
  assert('the working-method list still has rule 6 after it',
    DEFAULT_SYSTEM_PROMPT.includes('\n6. Do not add dependencies, delete data, or rewrite git history unless asked.'));
}

async function fileOverride(): Promise<void> {
  header(`system prompt — ${SYSTEM_PROMPT_FILENAME} replaces the default`);

  const dir = await project();
  const file = await writeOverride(dir, 'You are a haiku-only agent.\n\n\n');
  const loaded = await loadSystemPrompt(dir);

  console.log(`  prompt: ${JSON.stringify(loaded.prompt)}`);

  assert('the file contents are the prompt', loaded.prompt === 'You are a haiku-only agent.');
  assert('the source is reported as file', loaded.source === 'file');
  assert('the path is reported so the user can see which file won', loaded.path === file);
  assert('nothing is flagged as a problem', loaded.problem === undefined);
  assert('the default is not appended to it', !loaded.prompt.includes('fileEditor'));
  assert('the default numeric-report clause does not leak into an override', !loaded.prompt.includes('material numbers'));
  assert('the default generated-automation retry clause does not leak into an override',
    !loaded.prompt.includes('run unattended') && !loaded.prompt.includes('idempotency'));
}

async function configOverride(): Promise<void> {
  header('system prompt — config.json wins over the file, and blank values are rejected');

  const dir = await project();
  await writeOverride(dir, 'FROM THE FILE');

  const inline = await loadSystemPrompt(dir, 'FROM THE CONFIG');
  assert('the inline prompt is used', inline.prompt === 'FROM THE CONFIG');
  assert('the source is reported as config', inline.source === 'config');
  assert('no path is reported for an inline prompt', inline.path === undefined);

  // Round-trip through the real loader: the field has to survive validation, or
  // the override above is reachable only from a test.
  await writeFile(
    configPath(dir),
    JSON.stringify({ systemPrompt: 'You only write TypeScript.' }),
    'utf8',
  );
  const config = await loadConfig(dir);
  assert('config loading carries systemPrompt through', config.systemPrompt === 'You only write TypeScript.');

  const viaConfig = await loadSystemPrompt(dir, config.systemPrompt);
  assert('the configured prompt reaches the agent', viaConfig.prompt === 'You only write TypeScript.');

  // A blank prompt is a mistake, not a configuration: it would leave the agent
  // with no instructions at all, which fails loudly rather than silently.
  for (const blank of ['', '   \n']) {
    await writeFile(configPath(dir), JSON.stringify({ systemPrompt: blank }), 'utf8');
    let rejected = false;
    try {
      await loadConfig(dir);
    } catch (error) {
      rejected = error instanceof ConfigError;
    }
    assert(`a blank systemPrompt (${JSON.stringify(blank)}) is a ConfigError`, rejected);
  }
}

async function brokenOverride(): Promise<void> {
  header('system prompt — a broken override falls back to the default, and says so');

  // An empty file reads as "I configured nothing", not "run with no instructions".
  const emptyDir = await project();
  await writeOverride(emptyDir, '   \n\n');
  const empty = await loadSystemPrompt(emptyDir);
  assert('an empty override falls back to the default', empty.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the fallback is reported', empty.problem !== undefined);
  console.log(`  empty file  : ${empty.problem}`);

  // A directory where the file should be: present, unreadable. Silently using the
  // default here would leave the user believing their prompt is in effect.
  const dirDir = await project();
  await mkdir(path.join(darwinDir(dirDir), SYSTEM_PROMPT_FILENAME), { recursive: true });
  const unreadable = await loadSystemPrompt(dirDir);
  assert('an unreadable override falls back to the default', unreadable.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the source is default, not file', unreadable.source === 'default');
  assert('the reason is reported', unreadable.problem !== undefined);
  console.log(`  unreadable  : ${unreadable.problem}`);
}

async function composesWithProjectInstructions(): Promise<void> {
  header('system prompt — an override still gets AGENTS.md appended after it');

  const dir = await project();
  await writeOverride(dir, 'CUSTOM BASE');
  await writeFile(path.join(dir, AGENTS_FILENAME), '# House rules\n\nPrefer small commits.\n', 'utf8');

  const base = await loadSystemPrompt(dir);
  const instructions = (await loadProjectInstructions(dir)).instructions;
  const composed = composeSystemPrompt(base.prompt, instructions);

  // Overriding replaces darwin's own instructions only. The project's rules are
  // additive by design, so they must survive a custom base prompt.
  assert('the custom base leads', composed.startsWith('CUSTOM BASE'));
  assert('project instructions follow it', composed.includes('Prefer small commits'));
  assert(
    'the instructions come after the base, not before',
    composed.indexOf('<project-instructions') > composed.indexOf('CUSTOM BASE'),
  );

  // The CLAUDE.md fallback takes the same slot: same order, its own source label.
  const fallbackDir = await project();
  await writeOverride(fallbackDir, 'CUSTOM BASE');
  await writeFile(path.join(fallbackDir, CLAUDE_FILENAME), '# Claude rules\n\nPrefer small commits.\n', 'utf8');
  const fallback = composeSystemPrompt(
    (await loadSystemPrompt(fallbackDir)).prompt,
    (await loadProjectInstructions(fallbackDir)).instructions,
  );
  assert('a CLAUDE.md fallback is appended after the override in the same slot',
    fallback.startsWith('CUSTOM BASE') && fallback.indexOf(`<project-instructions source="${CLAUDE_FILENAME}"`) > fallback.indexOf('CUSTOM BASE')
      && fallback.includes('Prefer small commits'));
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await defaultPrompt();
  numericReportVerification();
  generatedAutomationRetry();
  await fileOverride();
  await configOverride();
  await brokenOverride();
  await composesWithProjectInstructions();
  report();
}

await main();
