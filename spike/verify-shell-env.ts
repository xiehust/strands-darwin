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
 * Run: pnpm tsx spike/verify-shell-env.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Agent, Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import type { BashOutput } from '@strands-agents/sdk/vended-tools/bash';

import { PermissionGate } from '../src/agent/permission.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { formatHeadlessShellEnv } from '../src/headless.js';
import {
  BackgroundBashManager,
  createBackgroundBashTool,
  createForegroundBashTool,
  type BackgroundStartResult,
} from '../src/tools/background-bash.js';
import {
  ALWAYS_SURVIVE_NAMES,
  CREDENTIAL_NAME_PATTERN,
  MAX_NOTICE_NAMES,
  formatShellEnvNotice,
  passthroughEntryProblem,
  scrubShellEnv,
} from '../src/tools/shell-env.js';
import { assert, header, report } from './shared.js';

const SECRET_VALUE = 'sk-test-secret-value-9f2c';
const PROBE = 'echo "[$ANTHROPIC_API_KEY]"';

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
    const environ = await scrubbedTool.invoke({ mode: 'execute', command: 'tr "\\0" "\\n" < /proc/self/environ | grep -c ANTHROPIC_API_KEY || true' }, scrubbedContext) as BashOutput;
    assert('/proc/self/environ of the shell\u2019s children has no such name either', environ.output.trim() === '0');

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
        definitions: [{ name: 'general', description: 'shell env child', systemPrompt: 'Run the probe.', tools: ['bash'], file: undefined }],
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

async function main(): Promise<void> {
  pureContracts();
  noticeContracts();
  await seamContracts();
  report();
}

await main();
