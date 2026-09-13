/** SER-087 offline contract checks.
 * R1 grammar + literal focus; R2 prompt requirements; R3 purity/reservation/help;
 * R4 real SDK runtime/text/json/stream-json + literal trajectory; R5 gate authority.
 * TUI queue/image and dev-repl paths are in verify-review-drivers.ts.
 * No external model/transport; all project/config/session files live in private HOME.
 * Run: pnpm tsx spike/verify-review-command.ts
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription, loadCustomCommands } from '../src/commands/custom-commands.js';
import { parseReviewCommand, REVIEW_COMMAND_NAME } from '../src/commands/review-command.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { computeCompletions } from '../src/tui/prompt-completion.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('review-command');
const root = path.join(home, 'project');
const commandDir = path.join(root, '.darwin/commands');
const skillDir = path.join(root, '.darwin/skills/review');
const focus = `路径/文件.ts  "two words"\n$ARGUMENTS $1 $& $$ $\` $' @file \\tail $(touch ${root}/executed) !\`touch ${root}/executed\``;
const base = parseReviewCommand('/review')!.message;
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
function parsing(): void {
  header('review R1–R3 — grammar, prompt contract and pure discovery');
  for (const input of ['', 'review', 'please /review this', '/reviews', '/review-other', '/review/foo', '//review', '/unknown']) {
    assert(`exact name rejects ${JSON.stringify(input)}`, parseReviewCommand(input) === null);
  }
  for (const input of ['/review', '/REVIEW', ' \t/ReViEw \r\n ']) {
    assert('bare and whitespace-only invocations are the same valid prompt', parseReviewCommand(input)?.message === base);
  }
  for (const separator of [' ', '\t', '\n', '\r\n', '\u2003']) {
    assert('focus is trimmed only at its edges and never interpolated',
      parseReviewCommand(` \t/ReViEw${separator}${focus}\n `)?.message === `${base}\n\nFocus: ${focus}`);
  }
  assert('bare invocation adds no empty focus marker', !base.includes('Focus:'));
  for (const clause of [
    'repository instructions', 'staged and unstaged changes', 'relevant untracked files', 'surrounding code',
    'actionable bugs in priority order', 'file/line evidence', 'explanation of the impact',
    'test gaps separately from bug findings', 'Avoid speculative or style-only findings',
    'no actionable bugs, say so explicitly', 'what you could not inspect or verify', 'tests not run',
    'Do not edit files or make commits unless separately requested',
    'not an enforced read-only mode', 'existing permission gate remains authoritative',
  ]) assert(`fixed prompt includes ${clause}`, base.includes(clause));
  assert('no prompt-directed automatic delegation', !/subagent|workflow/.test(base));
  assert('review has the canonical name and a one-line description', REVIEW_COMMAND_NAME === 'review' &&
    BUILTIN_COMMAND_NAMES.includes(REVIEW_COMMAND_NAME) && !!builtinCommandDescription('review') &&
    !builtinCommandDescription('review')!.includes('\n'));
  const candidates = computeCompletions('/', [...BUILTIN_COMMAND_NAMES]);
  assert('every built-in fits the completion offering', candidates.length <= MAX_COMPLETIONS &&
    BUILTIN_COMMAND_NAMES.every(name => candidates.includes(name)));
  assert('help exposes every built-in and description', BUILTIN_COMMAND_NAMES.every(name =>
    formatHelpReport().includes(`/${name} — ${builtinCommandDescription(name)}`)));
}
async function fixture(): Promise<string> {
  await mkdir(commandDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(commandDir, 'ReViEw.md'), 'CUSTOM SHADOW');
  await writeFile(path.join(commandDir, 'audit.md'), 'Custom $ARGUMENTS');
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: collision fixture\n---\nSKILL SHADOW');
  const commands = await loadCustomCommands(root, ['review']);
  assert('case-insensitive review command is refused with normal built-in diagnostic',
    !commands.commands.some(command => command.name.toLowerCase() === 'review') &&
    commands.problems.some(problem => problem.reason.includes('built-in command /review')));
  assert('unreserved custom commands still load', commands.commands.some(command => command.name === 'audit'));
  const source = await readFile(new URL('../src/commands/review-command.ts', import.meta.url), 'utf8');
  assert('pure command module has no imports or I/O/execution APIs',
    !/\bimport\b|\brequire\s*\(|\b(?:readFile|writeFile|exec|spawn|fetch|eval|Function)\s*\(/.test(source));
  const config = JSON.stringify({ provider: 'bedrock', model: 'fake.offline-capture', region: 'us-west-2',
    promptCache: false, memory: false, contextOffload: false, trajectory: true });
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), config);
  return config;
}
async function runtimeExpansion(config: string): Promise<void> {
  header('review R4 — actual runtime and headless SDK requests');
  const model = new CaptureModel();
  setRuntimeModelFactoryForTest(async () => model);
  let runtime: AgentRuntime | undefined;
  let trajectory: string | undefined;
  let permissionCalls = 0;
  const literals: string[] = [];
  try {
    runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' },
      permissionModeOverride: 'default', permissionBridge: async () => { permissionCalls++; return { allowed: false }; } });
    assert('same-name skill remains discoverable by the existing skill loader', runtime.info.skillNames.includes('review'));
    // Removing the source makes accidental skill activation fail, not silently pass.
    await rm(skillDir, { recursive: true });
    const expanded = await runtime.expandSlashCommand(`/REVIEW ${focus}`);
    assert('runtime built-in wins over the colliding skill without activation',
      expanded?.kind === 'review' && expanded.message === `${base}\n\nFocus: ${focus}`);
    assert('expansion alone calls no model or permission and creates no dispatch', model.calls.length === 0 &&
      permissionCalls === 0 && runtime.listSubagentDispatches().length === 0);
    assert('expansion keeps the active permission mode', runtime.permissionMode === 'default');
    trajectory = runtime.info.trajectoryFile;
    assert('expansion alone records no user input', !trajectory || !existsSync(trajectory) ||
      !(await readFile(trajectory, 'utf8')).includes('"type":"userInput"'));
    const cases = [
      { input: '/review', expected: base },
      { input: ` \t/ReViEw \t${focus}\r\n `, expected: `${base}\n\nFocus: ${focus}` },
      { input: '/review \t\n', expected: base },
      { input: '/reviews unchanged', expected: '/reviews unchanged' },
      { input: '/audit target', expected: 'Custom target' },
    ];
    let toolsCalled = 0;
    for (const driver of ['direct', 'text', 'json', 'stream-json'] as const) {
      for (const test of cases) {
        const before = model.calls.length;
        if (driver === 'direct') {
          const expansion = await runtime.expandSlashCommand(test.input);
          for await (const event of runtime.send(expansion?.message ?? test.input, test.input)) {
            if (event.type === 'beforeToolCallEvent') toolsCalled++;
          }
        } else if (driver === 'text') {
          assert('text driver completes', await runHeadlessTurn(runtime, test.input, () => {}) === 'ok');
        } else {
          const result = await runStructuredHeadlessTurn(runtime, test.input,
            new StructuredHeadlessWriter(driver, () => {}), () => 'unexpected tool');
          assert(`${driver} driver completes`, result.reply === 'ok');
        }
        literals.push(test.input);
        const call = model.calls.at(-1)!;
        const message = call.messages.at(-1)!;
        assert(`${driver} sends exactly one ordinary user request`, model.calls.length === before + 1 && message.role === 'user');
        assert(`${driver} sends exact expansion bytes`, message.content.length === 1 &&
          message.content[0]?.type === 'textBlock' && message.content[0].text === test.expected);
        assert('no new review tool/executor and unchanged tool catalogue', !call.tools.includes('review') &&
          JSON.stringify(call.tools) === JSON.stringify(model.calls[0]!.tools));
        assert('ordinary request retains system instructions/context', JSON.stringify(call.systemPrompt).includes('working-context'));
      }
    }
    assert('ordinary review turns request no automatic tools', toolsCalled === 0);
    assert('no mode switch, delegation, permission call or interpolation sentinel', runtime.permissionMode === 'default' &&
      runtime.listSubagentDispatches().length === 0 && permissionCalls === 0 && !existsSync(path.join(root, 'executed')));
    assert('private config is byte-identical', await readFile(configPath(), 'utf8') === config);
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
  check(trajectory);
  const records = (await readFile(trajectory, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  check.deepEqual(records.filter(record => record.type === 'userInput').map(record => record.text), literals);
  assert('all drivers record only literal slash input once per turn', !records.some(record => record.type === 'beforeToolCallEvent'));
}
class WriteRequestModel extends CaptureModel {
  private first = true;
  constructor(private readonly target: string) { super(); }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!this.first) { yield* super.stream(messages, options); return; }
    this.first = false;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: 'review-write' } };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({
      command: 'create', path: this.target, file_text: 'fixture write',
    }) } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}

async function gateAuthority(): Promise<void> {
  header('review R5 — existing gate, not an enforced read-only mode');
  for (const [mode, allowed] of [['default', false], ['default', true], ['plan', true]] as const) {
    // Outside the project is dangerous; ordinary in-project edits are statically
    // safe in default mode. This path still belongs to this suite's private HOME.
    const target = path.join(home, `${mode}-${allowed}`);
    const model = new WriteRequestModel(target);
    let prompts = 0;
    setRuntimeModelFactoryForTest(async () => model);
    const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' },
      permissionModeOverride: mode, permissionBridge: async () => { prompts++; return { allowed }; } });
    try {
      await runHeadlessTurn(runtime, '/review', () => {});
      assert('review leaves selected mode unchanged', runtime.permissionMode === mode);
      assert('ordinary gate decides whether to prompt', prompts === (mode === 'default' ? 1 : 0));
      assert('only the fixture-authorized write executes', existsSync(target) === (mode === 'default' && allowed));
    } finally { await runtime.shutdown(); setRuntimeModelFactoryForTest(undefined); }
  }
}
parsing();
const config = await fixture();
await runtimeExpansion(config);
await gateAuthority();
report();
