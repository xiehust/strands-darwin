/**
 * SER-082 — credential-shaped environment variables are withheld from model-spawned
 * shells.
 *
 * Free suite: no model call, no network. Three layers, each proved against a control
 * that shows the value *is* set in this process:
 *
 * 1. The pure decision (`scrubShellEnv`): one fixed case-insensitive name pattern
 *    (`KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL`), the always-survive names, the
 *    `passthrough` grammar (exact names or one trailing `*`, case-sensitive), sorted
 *    withheld names and never a value, plus the config-facing entry validator.
 * 2. The seams: a real `createForegroundBashTool(root, scrubbedEnv)` shell — through
 *    the pinned patch's `CreateBashOptions.env` — prints `[]` for
 *    `echo "[$ANTHROPIC_API_KEY]"` while a plain `spawnSync` control and a tool built
 *    without the option both print the value (absence is byte-identical to before);
 *    the replacement shell after `restart` is scrubbed too; the background `start`
 *    path (`createBackgroundBashTool(..., { env })`) shows the same scrub against the
 *    same controls.
 * 3. A real `SubagentTool` child handed the runtime's wrapped bash runs the same probe
 *    and reports `[]`: children share the builder, so they inherit the scrub.
 *
 * Also pinned: the startup-notice sentence (`formatShellEnvNotice`) and the headless
 * text-mode line (`formatHeadlessShellEnv`) name variables, never values, and stay
 * absent when nothing was withheld.
 *
 * SER-110: git's paired env-config protocol survives whole — `GIT_CONFIG_KEY_<n>`
 * (canonical decimal index only) is always kept, while `FOO_KEY`/`GIT_TOKEN` stay
 * withheld; a real foreground shell built from an explicit fixture env
 * (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat` plus an
 * unrelated `*_KEY`) runs `git config --get core.pager` → `cat`, exit 0, against a
 * `spawnSync` control of the pre-fix map (no KEY) that git refuses with exit 128.
 *
 * SER-094 rides on the same seams: `withDarwinMarker` adds `DARWIN=1` to a copy of any
 * map unless the name is already set, and never appears in the withheld/passthrough
 * projections; a real offline `AgentRuntime` (lazy model, private HOME) proves the
 * registered `bash` tool prints `1` in the persistent foreground shell and in a
 * background `start` job, and that darwin's own exported `DARWIN` reaches the shell
 * byte-identical. The `!`, hook and stdio MCP seams are pinned in their own suites
 * (`verify-shell-command`, `verify-lifecycle-hooks`, `verify-tool-hooks`,
 * `verify-codex-hooks`, `verify-mcp-config`).
 *
 * SER-111: the same offline `AgentRuntime` seam proves a credential-shaped variable
 * in darwin's environment reaches the system prompt's `<working-context>` as one
 * `- shell environment:` line built from `RuntimeInfo.shellEnv.withheld` (the name,
 * never the value), and that a `/clear` successor carries it too.
 *
 * Run: pnpm tsx spike/verify-shell-env.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Agent, Model, TextBlock, type BaseModelConfig, type InvokableTool, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import type { BashOutput } from '@strands-agents/sdk/vended-tools/bash';

import { PermissionGate, allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { formatShellEnvContextLine } from '../src/agent/working-context.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { formatHeadlessShellEnv } from '../src/headless.js';
import {
  BackgroundBashManager,
  createBackgroundBashTool,
  createForegroundBashTool,
  type BackgroundStartResult,
  type BackgroundWaitResult,
} from '../src/tools/background-bash.js';
import {
  ALWAYS_SURVIVE_NAMES,
  ALWAYS_SURVIVE_PATTERNS,
  CREDENTIAL_NAME_PATTERN,
  DARWIN_MARKER_NAME,
  DARWIN_MARKER_VALUE,
  MAX_NOTICE_NAMES,
  formatShellEnvNotice,
  passthroughEntryProblem,
  scrubShellEnv,
  withDarwinMarker,
} from '../src/tools/shell-env.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// The runtime seam below writes session state under `~/.darwin`; own a private HOME
// so a standalone run never touches the real one (`pnpm test` does the same).
ownPrivateHome('shell-env');

const SECRET_VALUE = 'sk-test-secret-value-9f2c';
const PROBE = 'echo "[$ANTHROPIC_API_KEY]"';
const MARKER_PROBE = 'echo "[$DARWIN]"';

/** Emits one bash tool call, then answers with the tool result as text. */
class BashProbeModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.shell-env', contextWindowLimit: 200_000 };
  constructor(private readonly input: Record<string, unknown> = { mode: 'execute', command: PROBE }) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const result = messages.flatMap((message) => message.content).find((block) => block.type === 'toolResultBlock');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (result === undefined) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'probe-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.input) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: JSON.stringify(result) } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function fakeConfig() {
  return {
    provider: 'bedrock',
    model: 'fake.shell-env-child',
    region: 'us-west-2',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8, contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    modelChoices: [],
  } as const;
}

function pureContracts(): void {
  header('scrubShellEnv — one fixed name pattern, always-survive names, passthrough grammar');

  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: 'v1',
    AWS_SECRET_ACCESS_KEY: 'v2',
    NPM_TOKEN: 'v3',
    DB_PASSWORD: 'v4',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
    my_api_key: 'v6',
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy:3128',
    DATABASE_URL: 'postgres://u:p@h/db',
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'v7',
    STRIPE: 'v8',
    stripe_key: 'v9',
    UNSET: undefined,
  };

  const plain = scrubShellEnv(env, []);
  const withheld = ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_TOKEN', 'STRIPE_SECRET_KEY', 'my_api_key', 'stripe_key'];
  assert('every credential-shaped name is withheld, case-insensitively (my_api_key, stripe_key included)',
    withheld.every((name) => !(name in plain.env)));
  assert('PATH, HOME, LANG, LC_ALL, HTTPS_PROXY, DATABASE_URL, NODE_ENV are kept',
    ['PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'DATABASE_URL', 'NODE_ENV', 'STRIPE'].every((name) => plain.env[name] === env[name]));
  assert('undefined values are dropped as before', !('UNSET' in plain.env));
  assert('withheld names are reported sorted', JSON.stringify(plain.withheld) === JSON.stringify([...withheld].sort()));
  assert('the sorted order is deterministic byte order (uppercase before lowercase)',
    plain.withheld[0] === 'ANTHROPIC_API_KEY' && plain.withheld[plain.withheld.length - 1] === 'stripe_key');
  const values = Object.values(env).filter((value): value is string => value !== undefined);
  assert('no value ever appears in withheld', plain.withheld.every((entry) => !values.includes(entry)));
  assert('the result is a fresh map — the input is not mutated', env.ANTHROPIC_API_KEY === 'v1' && Object.keys(env).length === 17);
  assert('same input, same output (pure)', JSON.stringify(scrubShellEnv(env, [])) === JSON.stringify(plain));

  const restored = scrubShellEnv(env, ['NPM_TOKEN', 'STRIPE_*']);
  assert('an exact passthrough name restores that variable', restored.env['NPM_TOKEN'] === 'v3' && !restored.withheld.includes('NPM_TOKEN'));
  assert('a PREFIX_* passthrough restores STRIPE_SECRET_KEY', restored.env['STRIPE_SECRET_KEY'] === 'v7');
  assert('the prefix does not restore lowercase stripe_key (case-sensitive)', !('stripe_key' in restored.env) && restored.withheld.includes('stripe_key'));
  assert('"STRIPE" alone was never withheld and the prefix entry is not an exact match for it', restored.env['STRIPE'] === 'v8');
  assert('an exact "STRIPE" passthrough would not restore STRIPE_SECRET_KEY',
    !('STRIPE_SECRET_KEY' in scrubShellEnv(env, ['STRIPE']).env));
  assert('other credential-shaped names stay withheld under a passthrough',
    ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'my_api_key'].every((name) => restored.withheld.includes(name)));
  assert('a passthrough never adds a variable that was not in the input', !('STRIPE_MISSING' in scrubShellEnv({ A: '1' }, ['STRIPE_*']).env));

  // Always-survive is enforced, not merely observed: none of the fixed names matches
  // the pattern today, and a prefix-protected name that does match still survives.
  assert('no always-survive name matches the credential pattern (the guarantee is currently vacuous)',
    ALWAYS_SURVIVE_NAMES.every((name) => !CREDENTIAL_NAME_PATTERN.test(name)));
  const lc = scrubShellEnv({ LC_SECRET_KEY: 'x', SECRET_LC: 'y' }, []);
  assert('an LC_* name survives even when it matches the pattern', lc.env['LC_SECRET_KEY'] === 'x' && !lc.withheld.includes('LC_SECRET_KEY'));
  assert('…while the same words outside the protected prefix are withheld', lc.withheld.includes('SECRET_LC'));
  const proxies = scrubShellEnv({ http_proxy: 'a', no_proxy: 'b', HTTP_PROXY: 'c', NO_PROXY: 'd' }, []);
  assert('proxy names in both cases pass through', Object.keys(proxies.env).length === 4 && proxies.withheld.length === 0);
  assert('an empty environment yields an empty map and nothing withheld',
    JSON.stringify(scrubShellEnv({}, ['X_*'])) === JSON.stringify({ env: {}, withheld: [] }));

  // SER-110: git's paired env-config protocol survives whole. The KEY names carry
  // config *names*; COUNT and the VALUE names never matched the pattern.
  const gitEnv: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: '13',
    GIT_CONFIG_KEY_0: 'credential.interactive',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_12: 'credential.guiPrompt',
    GIT_CONFIG_VALUE_12: 'false',
    GIT_CONFIG_KEY_01: 'a',
    GIT_CONFIG_KEY_: 'b',
    GIT_CONFIG_KEY_TOKEN: 'c',
    git_config_key_0: 'd',
    FOO_KEY: 'e',
    GIT_TOKEN: 'f',
    GIT_ASKPASS_TOKEN: 'g',
  };
  const git = scrubShellEnv(gitEnv, []);
  assert('GIT_CONFIG_KEY_0 and GIT_CONFIG_KEY_12 always survive with their values',
    git.env['GIT_CONFIG_KEY_0'] === 'credential.interactive' && git.env['GIT_CONFIG_KEY_12'] === 'credential.guiPrompt');
  assert('GIT_CONFIG_COUNT and the paired VALUE names pass as before',
    git.env['GIT_CONFIG_COUNT'] === '13' && git.env['GIT_CONFIG_VALUE_0'] === 'false' && git.env['GIT_CONFIG_VALUE_12'] === 'false');
  assert('FOO_KEY, GIT_TOKEN and GIT_ASKPASS_TOKEN are still withheld',
    ['FOO_KEY', 'GIT_TOKEN', 'GIT_ASKPASS_TOKEN'].every((name) => git.withheld.includes(name) && !(name in git.env)));
  assert('only the canonical decimal index git reads survives (01, empty, TOKEN suffix, lowercase stay withheld)',
    ['GIT_CONFIG_KEY_01', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_KEY_TOKEN', 'git_config_key_0'].every((name) => git.withheld.includes(name)));
  assert('withheld stays sorted and names no surviving git KEY',
    JSON.stringify(git.withheld) === JSON.stringify([...git.withheld].sort()) &&
      !git.withheld.includes('GIT_CONFIG_KEY_0') && !git.withheld.includes('GIT_CONFIG_KEY_12'));
  const cleanGit = scrubShellEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'x', GIT_CONFIG_KEY_1: 'b', GIT_CONFIG_VALUE_1: 'y' }, []);
  assert('the Orca-shaped environment withholds nothing, so the notice adds no line',
    cleanGit.withheld.length === 0 && formatShellEnvNotice(cleanGit.withheld) === undefined);
  assert('a KEY without GIT_CONFIG_COUNT survives too (the rule is per-name, never conditional)',
    scrubShellEnv({ GIT_CONFIG_KEY_0: 'a' }, []).env['GIT_CONFIG_KEY_0'] === 'a');
  assert('no always-survive pattern matches a plain always-survive name or DARWIN (patterns are additive)',
    ALWAYS_SURVIVE_PATTERNS.every((pattern) => !pattern.test('PATH') && !pattern.test(DARWIN_MARKER_NAME)));

  header('passthroughEntryProblem — the config grammar is the scrub module\u2019s own');
  assert('an exact name is valid', passthroughEntryProblem('NPM_TOKEN') === undefined);
  assert('one trailing * is valid', passthroughEntryProblem('STRIPE_*') === undefined);
  assert('a * anywhere but the end is refused', passthroughEntryProblem('A_*_B') !== undefined);
  assert('two stars are refused', passthroughEntryProblem('A**') !== undefined);
  assert('a bare * is refused', passthroughEntryProblem('*') !== undefined);
  assert('an empty entry is refused', passthroughEntryProblem('') !== undefined);
  assert('whitespace is refused', passthroughEntryProblem('A B') !== undefined);
}

function noticeContracts(): void {
  header('formatShellEnvNotice / formatHeadlessShellEnv — names, never values, absent when clean');
  assert('nothing withheld adds no line', formatShellEnvNotice([]) === undefined);
  assert('one name uses the singular',
    formatShellEnvNotice(['DB_PASSWORD']) === '1 credential-shaped variable withheld from model shells (DB_PASSWORD)');
  const many = ['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY', 'E_KEY'];
  const notice = formatShellEnvNotice(many) ?? '';
  assert('more than MAX_NOTICE_NAMES names are bounded with an ellipsis',
    notice === `5 credential-shaped variables withheld from model shells (${many.slice(0, MAX_NOTICE_NAMES).join(', ')}, …)`);
  assert('exactly MAX_NOTICE_NAMES names carry no ellipsis', !(formatShellEnvNotice(many.slice(0, MAX_NOTICE_NAMES)) ?? '').includes('…'));

  assert('a runtime double without info.shellEnv stays quiet', formatHeadlessShellEnv({ info: { sessionId: 's' } }) === undefined);
  assert('a runtime without info stays quiet', formatHeadlessShellEnv({}) === undefined);
  assert('nothing withheld stays quiet', formatHeadlessShellEnv({ info: { shellEnv: { withheld: [], passthrough: [] } } }) === undefined);
  assert('withheld names become one `shell-env:` line',
    formatHeadlessShellEnv({ info: { shellEnv: { withheld: ['NPM_TOKEN'], passthrough: [] } } }) ===
      'shell-env: 1 credential-shaped variable withheld from model shells (NPM_TOKEN)');
}

function markerContracts(): void {
  header('withDarwinMarker — DARWIN=1 added once, a preset DARWIN wins, nothing else touched (SER-094)');
  assert('the marker name and value are the documented ones', DARWIN_MARKER_NAME === 'DARWIN' && DARWIN_MARKER_VALUE === '1');
  const input: NodeJS.ProcessEnv = { PATH: '/usr/bin', NODE_ENV: 'test', UNSET: undefined };
  const before = JSON.stringify(input);
  const marked = withDarwinMarker(input);
  assert('DARWIN=1 is added when absent', marked['DARWIN'] === '1');
  assert('every other defined byte is identical and undefined values are dropped as spawn drops them',
    JSON.stringify({ ...marked, DARWIN: undefined }) === JSON.stringify({ PATH: '/usr/bin', NODE_ENV: 'test' }) && !('UNSET' in marked));
  assert('exactly one name is added', Object.keys(marked).length === 3);
  assert('the input is never mutated', JSON.stringify(input) === before && !('DARWIN' in input));
  const preset = withDarwinMarker({ DARWIN: 'custom', PATH: '/usr/bin' });
  assert('a preset DARWIN survives byte-identical (the marker never overrides)',
    JSON.stringify(preset) === JSON.stringify({ DARWIN: 'custom', PATH: '/usr/bin' }));
  assert('an empty preset value is still "set" and survives', withDarwinMarker({ DARWIN: '' })['DARWIN'] === '');
  assert('pure: same input, same output', JSON.stringify(withDarwinMarker(input)) === JSON.stringify(marked));

  // The marker is neither credential-shaped nor an always-survive name, so the scrub,
  // the notice and the `/status` row (a projection of `withheld`/`passthrough`) never
  // mention it — in either direction of composition.
  assert('DARWIN is not credential-shaped', !CREDENTIAL_NAME_PATTERN.test(DARWIN_MARKER_NAME));
  assert('DARWIN is not an always-survive name', !ALWAYS_SURVIVE_NAMES.includes(DARWIN_MARKER_NAME));
  const scrubbedMarked = scrubShellEnv(withDarwinMarker({ NPM_TOKEN: 'x', A: 'b' }), []);
  assert('scrubbing a marked map keeps the marker and never lists it as withheld',
    scrubbedMarked.env['DARWIN'] === '1' && !scrubbedMarked.withheld.includes('DARWIN') && scrubbedMarked.withheld.join() === 'NPM_TOKEN');
  assert('the startup notice never names the marker', !(formatShellEnvNotice(scrubbedMarked.withheld) ?? '').includes('DARWIN'));
  assert('marking a scrubbed map (the runtime order) adds only the marker',
    JSON.stringify(withDarwinMarker(scrubShellEnv({ NPM_TOKEN: 'x', A: 'b' }, []).env)) === JSON.stringify({ A: 'b', DARWIN: '1' }));
}

/** Same private-field reach the `/clear` and `/model` suites use: the Agent is not public API. */
function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

/** The runtime's registered `bash` tool, invokable with the wrapped tool's input shape. */
function registeredBash(agent: Agent): InvokableTool<Record<string, unknown>, unknown> {
  const bash = agent.toolRegistry.get('bash');
  if (bash === undefined) throw new Error('the runtime registered no bash tool');
  return bash as unknown as InvokableTool<Record<string, unknown>, unknown>;
}

/**
 * The runtime seam, offline: `AgentRuntime.create()` builds its model lazily, so the
 * real `bash` tool it registers can run `echo "[$DARWIN]"` through the persistent
 * foreground shell and a background `start` job without a provider call. Under the
 * suite's private HOME, so no login profile can set `DARWIN` on its own.
 */
async function runtimeMarkerContracts(): Promise<void> {
  header('the runtime seam — the registered bash tool prints 1 in foreground and in a start job');
  const previousMarker = process.env['DARWIN'];
  delete process.env['DARWIN'];
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-marker-'));
  setRuntimeModelFactoryForTest(async () => new BashProbeModel());
  const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  try {
    const agent = runtimeAgent(runtime);
    const bash = registeredBash(agent);
    const context = { agent } as never;
    assert('control: this process carries no DARWIN', spawnSync('bash', ['-c', MARKER_PROBE], { encoding: 'utf8' }).stdout.trim() === '[]');
    const foreground = await bash.invoke({ mode: 'execute', command: MARKER_PROBE }, context) as BashOutput;
    assert('the runtime\u2019s persistent foreground shell prints [1]', foreground.output.trim() === '[1]' && foreground.exitCode === 0);
    const job = await bash.invoke({ mode: 'start', command: MARKER_PROBE }, context) as BackgroundStartResult;
    const done = await bash.invoke({ mode: 'wait', taskId: job.taskId, waitMs: 5_000, wakeOnOutput: false }, context) as BackgroundWaitResult;
    assert('a background start job through the same runtime prints [1]',
      done.status.state === 'succeeded' && done.output.output.trim() === '[1]');
    assert('the runtime reports the marker as neither withheld nor passthrough',
      !runtime.info.shellEnv.withheld.includes('DARWIN') && !runtime.info.shellEnv.passthrough.includes('DARWIN'));
  } finally {
    await runtime.shutdown();
  }

  // A user's own exported DARWIN reaches the model shell byte-identical.
  process.env['DARWIN'] = 'custom-user-value';
  const presetRoot = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-marker-preset-'));
  const presetRuntime = await AgentRuntime.create({ projectRoot: presetRoot, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  try {
    const agent = runtimeAgent(presetRuntime);
    const bash = registeredBash(agent);
    const preset = await bash.invoke({ mode: 'execute', command: MARKER_PROBE }, { agent } as never) as BashOutput;
    assert('a preset DARWIN in darwin\u2019s own environment reaches the shell unchanged', preset.output.trim() === '[custom-user-value]');
  } finally {
    await presetRuntime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    if (previousMarker === undefined) delete process.env['DARWIN'];
    else process.env['DARWIN'] = previousMarker;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(presetRoot, { recursive: true, force: true })]);
  }
}

/** The text of the runtime's one `<working-context>` system-prompt block. */
function workingContextText(agent: Agent): string {
  const blocks = Array.isArray(agent.systemPrompt) ? agent.systemPrompt : [];
  const texts = blocks.flatMap((block) => (block instanceof TextBlock && block.text.includes('<working-context>') ? [block.text] : []));
  return texts.length === 1 ? texts[0]! : '';
}

/**
 * SER-111, the runtime seam offline: a credential-shaped variable in darwin's own
 * environment reaches the model's system prompt as one `- shell environment:`
 * line built from `RuntimeInfo.shellEnv.withheld` — the name, never the value —
 * and a `/clear` successor (the same `create()`, as `/rewind` is) carries it too.
 */
async function runtimeContextContracts(): Promise<void> {
  header('the runtime seam — the system prompt tells the model which names were withheld (SER-111)');
  const PROBE_NAME = 'AAA_SER111_PROBE_TOKEN';
  const PROBE_VALUE = 'ser111-runtime-value-marker-51be';
  const previous = process.env[PROBE_NAME];
  process.env[PROBE_NAME] = PROBE_VALUE;
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-context-'));
  setRuntimeModelFactoryForTest(async () => new BashProbeModel());
  let live: AgentRuntime | undefined;
  let next: AgentRuntime | undefined;
  try {
    live = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge });
    const withheld = live.info.shellEnv.withheld;
    const expected = formatShellEnvContextLine(withheld);
    assert('control: the runtime withheld the probe by name', withheld.includes(PROBE_NAME) && expected !== undefined);
    const context = workingContextText(runtimeAgent(live));
    const lines = context.split('\n').filter((line) => line.startsWith('- shell environment:'));
    assert('the working context carries exactly one shell-environment line, built from RuntimeInfo.shellEnv.withheld',
      lines.length === 1 && lines[0] === expected);
    assert('it names the probe (sorted first, inside the bounded names)', lines[0]?.includes(PROBE_NAME) === true);
    assert('the probe value appears nowhere in the system prompt', !JSON.stringify(runtimeAgent(live).systemPrompt).includes(PROBE_VALUE));

    next = await live.startNewSession();
    const successor = workingContextText(runtimeAgent(next)).split('\n').filter((line) => line.startsWith('- shell environment:'));
    assert('a /clear successor (the same create()) carries the same line', successor.length === 1 && successor[0] === expected);
  } finally {
    await next?.shutdown();
    await live?.shutdown().catch(() => undefined);
    setRuntimeModelFactoryForTest(undefined);
    if (previous === undefined) delete process.env[PROBE_NAME];
    else process.env[PROBE_NAME] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function seamContracts(): Promise<void> {
  header('the seams — foreground shell, restart replacement, background start, against live controls');
  const previous = process.env['ANTHROPIC_API_KEY'];
  const previousHome = process.env['HOME'];
  process.env['ANTHROPIC_API_KEY'] = SECRET_VALUE;
  // Background jobs are login shells (`bash -lc`): a developer's own `~/.profile` may
  // re-export the very name under test (it does on at least one Host machine), which
  // is the documented caveat, not the seam. An empty HOME keeps the assertion about
  // the inherited map — `pnpm test` gives every suite a private HOME for the same reason.
  const home = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-home-'));
  process.env['HOME'] = home;
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-'));
  const manager = new BackgroundBashManager(root, 'session-shell-env');
  const scrubbed = scrubShellEnv(process.env, []);
  assert('the test process really carries ANTHROPIC_API_KEY and the scrub withholds it',
    scrubbed.withheld.includes('ANTHROPIC_API_KEY') && !('ANTHROPIC_API_KEY' in scrubbed.env));

  const control = spawnSync('bash', ['-c', PROBE], { encoding: 'utf8' });
  assert('control: a plain spawn inheriting process.env prints the value', control.stdout.trim() === `[${SECRET_VALUE}]`);

  const scrubbedTool = createBackgroundBashTool(manager, createForegroundBashTool(root, scrubbed.env), { env: scrubbed.env });
  const plainTool = createBackgroundBashTool(manager, createForegroundBashTool(root));
  const scrubbedAgent = new Agent({ model: new BashProbeModel(), tools: [scrubbedTool], printer: false });
  const plainAgent = new Agent({ model: new BashProbeModel(), tools: [plainTool], printer: false });
  await Promise.all([scrubbedAgent.initialize(), plainAgent.initialize()]);
  const scrubbedContext = { agent: scrubbedAgent } as never;
  const plainContext = { agent: plainAgent } as never;

  try {
    const foreground = await scrubbedTool.invoke({ mode: 'execute', command: PROBE }, scrubbedContext) as BashOutput;
    assert('the real persistent shell built with the scrubbed env prints [] for the probe',
      foreground.output.trim() === '[]' && foreground.exitCode === 0);
    const kept = await scrubbedTool.invoke({ mode: 'execute', command: 'printf "%s|%s" "$HOME" "${PATH:+set}"' }, scrubbedContext) as BashOutput;
    assert('…while HOME and PATH reach the same shell', kept.output === `${process.env['HOME']}|set`);
    const child = await scrubbedTool.invoke({ mode: 'execute', command: 'bash -c \'test -z "${ANTHROPIC_API_KEY+x}" && printf absent\'' }, scrubbedContext) as BashOutput;
    assert('the shell\u2019s child inherits no synthetic probe name either', child.exitCode === 0 && child.output === 'absent');

    const unscrubbed = await plainTool.invoke({ mode: 'execute', command: PROBE }, plainContext) as BashOutput;
    assert('control: a tool built without the env option still inherits process.env (byte-identical to before)',
      unscrubbed.output.trim() === `[${SECRET_VALUE}]`);

    await scrubbedTool.invoke({ mode: 'restart' }, scrubbedContext);
    const replacement = await scrubbedTool.invoke({ mode: 'execute', command: PROBE }, scrubbedContext) as BashOutput;
    assert('the replacement shell after restart is scrubbed too', replacement.output.trim() === '[]');
    await scrubbedTool.invoke({ mode: 'execute', command: 'exit 0' }, scrubbedContext);
    const afterExit = await scrubbedTool.invoke({ mode: 'execute', command: PROBE }, scrubbedContext) as BashOutput;
    assert('the replacement shell after an exit-0 is scrubbed too', afterExit.output.trim() === '[]');

    const restored = scrubShellEnv(process.env, ['ANTHROPIC_API_KEY']);
    const restoredTool = createBackgroundBashTool(manager, createForegroundBashTool(root, restored.env), { env: restored.env });
    const restoredAgent = new Agent({ model: new BashProbeModel(), tools: [restoredTool], printer: false });
    await restoredAgent.initialize();
    const restoredContext = { agent: restoredAgent } as never;
    const passthrough = await restoredTool.invoke({ mode: 'execute', command: PROBE }, restoredContext) as BashOutput;
    assert('a passthrough entry restores the variable in the real shell', passthrough.output.trim() === `[${SECRET_VALUE}]`);
    await restoredTool.invoke({ mode: 'restart' }, restoredContext);

    // Background jobs: the same map through the tool option, against the same controls.
    const job = await scrubbedTool.invoke({ mode: 'start', command: PROBE }, scrubbedContext) as BackgroundStartResult;
    const jobDone = await manager.wait(job.taskId, 5_000, undefined, false);
    assert('a `start` job through the scrubbed tool prints []',
      jobDone.status.state === 'succeeded' && jobDone.output.output.trim() === '[]');
    const jobControl = await plainTool.invoke({ mode: 'start', command: PROBE }, plainContext) as BackgroundStartResult;
    const jobControlDone = await manager.wait(jobControl.taskId, 5_000, undefined, false);
    assert('control: a `start` job through a tool without the env option prints the value',
      jobControlDone.output.output.trim() === `[${SECRET_VALUE}]`);
    const direct = await manager.start(PROBE, restored.env);
    const directDone = await manager.wait(direct.taskId, 5_000, undefined, false);
    assert('manager.start with a passthrough-restored map prints the value', directDone.output.output.trim() === `[${SECRET_VALUE}]`);

    // A real SubagentTool child handed the runtime's wrapped bash: same builder, same scrub.
    const subagents = new SubagentTool({
      registry: {
        definitions: [{ name: 'general', description: 'shell env child', systemPrompt: 'Run the probe.', tools: ['bash'], projectInstructions: true, file: undefined }],
        problems: [],
      },
      tools: [scrubbedTool],
      intervention: new PermissionGate({ mode: 'yolo', projectRoot: root, ask: async () => ({ allowed: true }) }),
      projectInstructions: undefined,
      config: fakeConfig(),
      createModel: async () => new BashProbeModel(),
    });
    try {
      const parent = new Agent({ model: new BashProbeModel(), tools: [subagents.tool, scrubbedTool], printer: false });
      await parent.initialize();
      const reportText = JSON.stringify(await parent.tool.subagent?.invoke({ task: 'probe the shell environment' }));
      assert('a real SubagentTool child\u2019s bash prints [] for the probe', reportText.includes('[]'));
      assert('…and the secret value never reaches the child\u2019s report', !reportText.includes(SECRET_VALUE));
    } finally {
      await subagents.shutdown();
    }
  } finally {
    await Promise.all([
      scrubbedTool.invoke({ mode: 'restart' }, scrubbedContext),
      plainTool.invoke({ mode: 'restart' }, plainContext),
    ]);
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = previous;
  }
}

/**
 * SER-110 against a real git: a source environment carrying git's paired env-config
 * protocol (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.pager`, `GIT_CONFIG_VALUE_0=cat`)
 * plus an unrelated `*_KEY`, built explicitly — never the Host's own environment — under
 * an empty HOME with system config off, so only the fixture reaches git.
 */
async function gitConfigSeamContracts(): Promise<void> {
  header('git env-config pairs — a real foreground shell runs git with the scrubbed map (SER-110)');
  const home = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-git-home-'));
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-shell-env-git-'));
  const source: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
    UNRELATED_API_KEY: SECRET_VALUE,
  };
  const scrubbed = scrubShellEnv(source, []);
  assert('the fixture scrub keeps the git triple and withholds only the unrelated key',
    JSON.stringify(scrubbed.withheld) === JSON.stringify(['UNRELATED_API_KEY']) && scrubbed.env['GIT_CONFIG_KEY_0'] === 'core.pager');

  // Control: the map the pre-SER-110 scrub produced (COUNT + VALUE, no KEY) breaks git.
  const { GIT_CONFIG_KEY_0: _key, ...orphaned } = scrubbed.env;
  const broken = spawnSync('git', ['config', '--get', 'core.pager'], { cwd: root, env: orphaned, encoding: 'utf8' });
  assert('control: COUNT and VALUE without the KEY make git exit 128 with "unable to parse command-line config"',
    broken.status === 128 && broken.stderr.includes('unable to parse command-line config'));

  const manager = new BackgroundBashManager(root, 'session-shell-env-git');
  const gitTool = createBackgroundBashTool(manager, createForegroundBashTool(root, scrubbed.env), { env: scrubbed.env });
  const agent = new Agent({ model: new BashProbeModel(), tools: [gitTool], printer: false });
  await agent.initialize();
  const context = { agent } as never;
  try {
    const pager = await gitTool.invoke({ mode: 'execute', command: 'git config --get core.pager' }, context) as BashOutput;
    assert('in the real persistent shell `git config --get core.pager` prints cat and exits 0',
      pager.output.trim() === 'cat' && pager.exitCode === 0);
    const unrelated = await gitTool.invoke({ mode: 'execute', command: 'echo "[${UNRELATED_API_KEY-unset}]"' }, context) as BashOutput;
    assert('…while the unrelated *_KEY from the same source env is absent from that shell', unrelated.output.trim() === '[unset]');
  } finally {
    await gitTool.invoke({ mode: 'restart' }, context);
    await manager.shutdown();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
  }
}

async function main(): Promise<void> {
  pureContracts();
  noticeContracts();
  markerContracts();
  await runtimeMarkerContracts();
  await runtimeContextContracts();
  await seamContracts();
  await gitConfigSeamContracts();
  report();
}

await main();
