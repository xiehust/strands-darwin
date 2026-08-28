/** Offline acceptance for portable Codex-shaped `.agents/hooks.json`. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { loadProjectPolicy } from '../src/config.js';
import { CodexHookRunner, injectCodexContext } from '../src/hooks/codex-hook-runner.js';
import {
  CODEX_CONTEXT_MAX_BYTES,
  CODEX_HOOK_EVENTS,
  decodeCodexHooks,
  matchesCodexHook,
  type CodexHooksConfig,
} from '../src/hooks/codex-hooks.js';
import { HookProcessManager } from '../src/hooks/hook-process.js';
import { isSensitiveDarwinPath, userAgentsDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('codex-hooks');
const ROOT = path.join(os.tmpdir(), 'darwin-codex-hooks-test');
const CONFIG = {
  provider: 'bedrock' as const,
  model: 'fake.codex-hooks',
  region: 'us-east-1',
  maxTokens: 100,
  permissionMode: 'yolo' as const,
  promptCache: false,
  thinkingEffort: 'low' as const,
  summaryRatio: 0.8,
  contextWarnRatio: 0.8,
  contextOffload: true,
  preserveRecentMessages: 4,
  modelChoices: [],
};

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

function encoded(events: Record<string, unknown>, source = '/tmp/hooks.json'): CodexHooksConfig {
  return decodeCodexHooks({ description: 'portable', hooks: events }, source);
}

async function decoderAndDiscovery(): Promise<void> {
  header('codex hooks — strict decoder, regex and portable discovery');
  const all = Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, [{
    matcher: event === 'UserPromptSubmit' ? undefined : '',
    hooks: [{ type: 'command', command: 'true', timeout: event === 'SessionEnd' ? 3 : 5 }],
  }]]));
  const decoded = encoded(all);
  assert('all eleven documented events decode', CODEX_HOOK_EVENTS.every((event) => decoded[event]?.length === 1));
  const regex = encoded({ PreToolUse: [{ matcher: '^(?:Bash|Edit)$', hooks: [{ type: 'command', command: 'true' }] }] });
  const group = regex.PreToolUse![0]!;
  assert('Codex matchers are regular expressions', matchesCodexHook(group, ['Bash']) && !matchesCodexHook(group, ['bash']));
  for (const matcher of [undefined, '', '*']) {
    const matchAll = encoded({ Stop: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'true' }] }] });
    assert(`matcher ${String(matcher)} is match-all`, matchesCodexHook(matchAll.Stop![0]!, ['anything']));
  }
  assert('huge additionalContextLimit clamps without numeric overflow', encoded({ SessionStart: [{ hooks: [{ type: 'command', command: 'true', additionalContextLimit: Number.MAX_SAFE_INTEGER }] }] }).SessionStart![0]!.hooks[0]!.additionalContextBytes === CODEX_CONTEXT_MAX_BYTES);

  const rejects = (value: unknown, fragment: string): boolean => {
    try { decodeCodexHooks(value, '/portable/hooks.json'); return false; }
    catch (error) { return error instanceof Error && error.message.includes(fragment); }
  };
  assert('invalid regex is source/field specific', rejects({ hooks: { PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'true' }] }] } }, '.matcher'));
  assert('unsupported handlers are rejected', rejects({ hooks: { Stop: [{ hooks: [{ type: 'mcp_tool' }] }] } }, '.type'));
  assert('async handlers are rejected', rejects({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true', async: true }] }] } }, '.async'));
  assert('SessionEnd timeout is capped at three seconds', rejects({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'true', timeout: 4 }] }] } }, 'at most 3'));
  assert('additionalContextLimit zero remains globally bounded', encoded({ SessionStart: [{ hooks: [{ type: 'command', command: 'true', additionalContextLimit: 0 }] }] }).SessionStart![0]!.hooks[0]!.additionalContextBytes === CODEX_CONTEXT_MAX_BYTES);

  await rm(ROOT, { recursive: true, force: true });
  await write(path.join(ROOT, '.agents', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  await write(path.join(ROOT, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'false' }] }] } }));
  await write(path.join(userAgentsDir(), 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  const policy = await loadProjectPolicy(ROOT);
  assert('global then project portable sources load once', policy.hookSources.filter((file) => file.endsWith(`${path.sep}.agents${path.sep}hooks.json`)).length === 2);
  assert('.codex/hooks.json is never discovered', !policy.hookSources.some((file) => file.includes(`${path.sep}.codex${path.sep}`)));
  assert('portable files are sensitive executable policy', isSensitiveDarwinPath(ROOT, path.join(ROOT, '.agents', 'hooks.json')) && isSensitiveDarwinPath(ROOT, path.join(userAgentsDir(), 'hooks.json')));
}

async function runnerContract(): Promise<void> {
  header('codex hooks — payloads, context, block, rewrite and observers');
  const log = path.join(ROOT, 'runner.jsonl');
  const script = (body: string) => `node -e ${JSON.stringify(body)}`;
  const hooks = encoded({
    SessionStart: [{ matcher: '^startup$', hooks: [{ type: 'command', command: script("let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').appendFileSync(process.argv[1],s);console.log('session context')})") + ` ${JSON.stringify(log)}` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: script("let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify(p.prompt==='blocked'?{decision:'block',reason:'local refusal'}:{hookSpecificOutput:{additionalContext:'prompt context'}}))})") }] }],
    PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: script("console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',updatedInput:{mode:'execute',command:'echo rewritten'}}}))") }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: script("console.log(JSON.stringify({decision:'block',reason:'ignored'}))") }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: 'true' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'true' }] }],
    PostCompact: [{ hooks: [{ type: 'command', command: script("console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'post compact'}}))") }] }],
    SubagentStart: [{ matcher: '^trellis-implement$', hooks: [{ type: 'command', command: script("console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'child context'},continue:false}))") }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: 'true' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'true', timeout: 1 }] }],
  });
  const problems: string[] = [];
  const runner = new CodexHookRunner({ projectRoot: ROOT, hooks, sessionId: 'session-hook', config: CONFIG, permissionMode: () => 'default', problem: (problem) => problems.push(problem) });
  await runner.sessionStart('startup');
  const prompt = await runner.userPromptSubmit('literal prompt');
  assert('session and prompt context combine in order', prompt.context === 'session context\n\nprompt context');
  assert('context injection changes only model-facing text', injectCodexContext('expanded', prompt.context).endsWith('\n\nexpanded'));
  const blocked = await runner.userPromptSubmit('blocked');
  assert('UserPromptSubmit block is a bounded local refusal', !blocked.allowed && blocked.reason === 'local refusal');
  const rewritten = await runner.preToolUse({ toolName: 'bash', toolUseId: 'u1', toolInput: { value: 'raw' } });
  assert('Bash alias matches while payload remains actual Darwin name', rewritten.allowed && JSON.stringify(rewritten.input) === '{"mode":"execute","command":"echo rewritten"}');
  const autoAllow = new CodexHookRunner({
    projectRoot: ROOT,
    hooks: encoded({ PreToolUse: [{ hooks: [{ type: 'command', command: script("console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow'}}))") }] }] }),
    sessionId: 'session-hook',
    config: CONFIG,
    permissionMode: () => 'default',
  });
  const autoAllowResult = await autoAllow.preToolUse({ toolName: 'bash', toolUseId: 'u-auto', toolInput: { mode: 'execute', command: 'true' } });
  assert('PreToolUse allow without a rewrite cannot become a permission bypass', !autoAllowResult.allowed && autoAllowResult.reason?.includes('cannot auto-approve') === true);
  await autoAllow.close();
  await runner.postToolUse({ toolName: 'bash', toolUseId: 'u1', toolInput: rewritten.input, toolResponse: { status: 'success' } });
  assert('unsupported Post control is reported without replacing the result', problems.some((problem) => problem.includes('unsupported PostToolUse result control')));
  const child = await runner.subagentStart({ id: 'child-1', name: 'trellis-implement' });
  assert('targeted SubagentStart context is returned', child === 'child context');
  assert('unrelated SubagentStart matcher does not run', await runner.subagentStart({ id: 'child-2', name: 'general' }) === undefined);
  await runner.postCompact('manual');
  const staged = await runner.userPromptSubmit('after compact');
  assert('PostCompact context is staged for the next parent invocation', staged.context?.startsWith('post compact') === true);
  runner.permissionRequest({ source: 'parent', toolName: 'bash', toolInput: { command: 'true' } });
  runner.stop('success');
  await runner.sessionEnd();
  await runner.sessionEnd();
  await runner.close();
  const payload = JSON.parse((await readFile(log, 'utf8')).trim()) as Record<string, unknown>;
  assert('common payload fields are truthful and unavailable ids are omitted', payload['session_id'] === 'session-hook' && payload['cwd'] === ROOT && payload['model'] === CONFIG.model && payload['hook_event_name'] === 'SessionStart' && payload['turn_id'] === undefined && payload['transcript_path'] === undefined);
}

class CaptureModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: CONFIG.model, contextWindowLimit: 200_000 };
  calls: Message[][] = [];
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls.push(messages);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function realRuntimeProof(): Promise<void> {
  header('codex hooks — real runtime parent injection and local block');
  const project = path.join(ROOT, 'runtime');
  await rm(project, { recursive: true, force: true });
  const script = path.join(project, 'prompt-hook.cjs');
  await write(script, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify(p.prompt==='block me'?{decision:'block',reason:'blocked offline'}:{hookSpecificOutput:{additionalContext:'runtime injected once'}}))});\n");
  await write(path.join(project, '.agents', 'hooks.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: `node ${JSON.stringify(script)}`, timeout: 5 }],
      }],
    },
  }));
  const model = new CaptureModel();
  setRuntimeModelFactoryForTest(async () => model);
  const runtime = await AgentRuntime.create({ projectRoot: project, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  try {
    for await (const _event of runtime.send('expanded prompt', 'literal prompt')) { /* consume */ }
    const sent = model.calls[0]!.at(-1)!.content.find((block) => block.type === 'textBlock')?.text ?? '';
    assert('real parent invocation receives exactly one portable context block', sent.split('runtime injected once').length === 2 && sent.endsWith('expanded prompt'));
    let blocked = '';
    try { for await (const _event of runtime.send('block me', 'block me')) { /* consume */ } }
    catch (error) { blocked = error instanceof Error ? error.message : String(error); }
    assert('blocked prompt starts no provider call', blocked === 'blocked offline' && model.calls.length === 1);
  } finally {
    await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

async function processCleanup(): Promise<void> {
  header('codex hooks — timeout and cancellation reap process groups');
  const manager = new HookProcessManager(ROOT);
  const pidFile = path.join(ROOT, 'hook-pid');
  const run = manager.run(`trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`, undefined, { event: 'test' }, 30_000);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { if ((await readFile(pidFile, 'utf8')).trim() !== '') break; } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  manager.cancel();
  const result = await run;
  await manager.close();
  let exists = true;
  try { process.kill(pid, 0); } catch { exists = false; }
  assert('cancelled process is reported and its descendant is reaped', result.cancelled && !exists);
}

try {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await decoderAndDiscovery();
  await runnerContract();
  await realRuntimeProof();
  await processCleanup();
} finally {
  setRuntimeModelFactoryForTest(undefined);
  await rm(ROOT, { recursive: true, force: true });
  await rm(HOME, { recursive: true, force: true });
}
report();
