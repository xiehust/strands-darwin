/**
 * Permission approval modes: static risk rules and per-mode gate behavior.
 *
 * No model calls: the classifier is stubbed, so this covers the decision table
 * (default / auto / yolo), the whitelist rules, and every classifier failure
 * path — which must all land on "ask", never on silent approval.
 *
 * Run: pnpm tsx spike/verify-permission-modes.ts
 */
import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import {
  PermissionGate,
  assessRisk,
  classify,
  type AssessedPermissionRequest,
  type PermissionGateOptions,
  type SafetyClassifier,
} from '../src/agent/permission.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-permission-modes';

function riskOf(toolName: string, input: unknown): { risk: string; riskReason: string } {
  return assessRisk(classify(toolName, input), ROOT);
}

function staticRules(): void {
  header('static risk rules — bash');

  const safeBash = [
    'git status',
    'git log --oneline -5',
    'ls -la src',
    'cat package.json | grep name',
    'rg PermissionGate src && echo found',
  ];
  for (const command of safeBash) {
    assert(`safe: ${command}`, riskOf('bash', { command }).risk === 'safe');
  }

  const dangerousBash = [
    ['git push origin main', 'non-read-only git'],
    ['ls && rm -rf /tmp/x', 'chained write'],
    ['echo hi > file', 'redirection'],
    ['cat $(find . -name secret)', 'substitution'],
    ['ls `whoami`', 'backticks'],
    ['pnpm typecheck', 'not allowlisted'],
    ['', 'empty command'],
  ] as const;
  for (const [command, why] of dangerousBash) {
    assert(`dangerous (${why}): ${command || '(empty)'}`, riskOf('bash', { command }).risk === 'dangerous');
  }

  assert('bash restart is safe (read kind)', riskOf('bash', { mode: 'restart' }).risk === 'safe');

  header('static risk rules — fileEditor');

  const edit = (path: string) => riskOf('fileEditor', { command: 'str_replace', path, old_str: 'a', new_str: 'b' });

  assert('in-project write is safe', edit(`${ROOT}/src/index.ts`).risk === 'safe');
  assert('relative in-project write is safe', edit('src/index.ts').risk === 'safe');
  assert('view is safe anywhere', riskOf('fileEditor', { command: 'view', path: '/etc/passwd' }).risk === 'safe');
  assert('write outside project is dangerous', edit('/etc/passwd').risk === 'dangerous');
  assert('.. escape is dangerous', edit(`${ROOT}/../other/file`).risk === 'dangerous');
  assert('.git internals are dangerous', edit(`${ROOT}/.git/config`).risk === 'dangerous');
  assert('.env is dangerous', edit(`${ROOT}/.env`).risk === 'dangerous');
  assert('.env.local is dangerous', edit(`${ROOT}/.env.local`).risk === 'dangerous');
  assert('.darwin/config.json is dangerous', edit(`${ROOT}/.darwin/config.json`).risk === 'dangerous');

  header('static risk rules — other tools');

  assert('load_skill is safe', riskOf('load_skill', { name: 'x' }).risk === 'safe');
  assert(
    'unknown / MCP tools are dangerous',
    riskOf('mcp__server__do_thing', { arg: 1 }).risk === 'dangerous',
  );
}

/** Minimal stand-in for the SDK event; the gate only reads `toolUse`. */
function fakeEvent(name: string, input: unknown): BeforeToolCallEvent {
  return { toolUse: { name, input } } as unknown as BeforeToolCallEvent;
}

interface GateRun {
  action: { type: string; reason?: string };
  asked: AssessedPermissionRequest[];
}

async function runGate(
  options: Partial<PermissionGateOptions> & { mode: PermissionGateOptions['mode'] },
  toolName: string,
  input: unknown,
  answer = true,
): Promise<GateRun> {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return answer;
    },
    ...options,
  });
  const action = (await gate.beforeToolCall(fakeEvent(toolName, input))) as GateRun['action'];
  return { action, asked };
}

const DANGEROUS_BASH = { command: 'rm -rf /tmp/x' };
const SAFE_BASH = { command: 'git status' };

async function gateModes(): Promise<void> {
  header('gate — default mode');

  let run = await runGate({ mode: 'default' }, 'bash', SAFE_BASH);
  assert('safe call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, true);
  assert('dangerous call asks, approval proceeds', run.action.type === 'proceed' && run.asked.length === 1);

  run = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, false);
  assert('dangerous call asks, refusal denies', run.action.type === 'deny' && run.asked.length === 1);
  assert(
    'the prompt carried the risk reason',
    run.asked[0] !== undefined && run.asked[0].riskReason.length > 0,
  );

  header('gate — yolo mode');

  run = await runGate({ mode: 'yolo' }, 'bash', DANGEROUS_BASH);
  assert('dangerous call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'yolo' }, 'mcp__anything__at_all', {});
  assert('unknown tool proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  header('gate — auto mode');

  const saysSafe: SafetyClassifier = async () => ({ safe: true, reason: 'harmless temp cleanup' });
  const saysUnsafe: SafetyClassifier = async () => ({ safe: false, reason: 'destructive delete' });
  const throws: SafetyClassifier = async () => {
    throw new Error('service down');
  };
  const hangs: SafetyClassifier = () => new Promise(() => undefined);

  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', SAFE_BASH);
  assert('statically safe call skips the classifier and proceeds', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', DANGEROUS_BASH);
  assert('classifier-safe verdict proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'auto', classifier: saysUnsafe }, 'bash', DANGEROUS_BASH, true);
  assert('classifier-unsafe verdict escalates to the user', run.asked.length === 1 && run.action.type === 'proceed');
  assert(
    'escalation shows the classifier reason as a detail block',
    run.asked[0]?.details.some((d) => d.label === 'Classifier' && d.value.includes('destructive')) === true,
  );

  run = await runGate({ mode: 'auto', classifier: throws }, 'bash', DANGEROUS_BASH, false);
  assert('classifier throw falls back to asking (fail-closed)', run.asked.length === 1 && run.action.type === 'deny');

  run = await runGate({ mode: 'auto', classifier: hangs, classifierTimeoutMs: 25 }, 'bash', DANGEROUS_BASH, false);
  assert('classifier hang times out and falls back to asking', run.asked.length === 1 && run.action.type === 'deny');

  run = await runGate({ mode: 'auto' }, 'bash', DANGEROUS_BASH, false);
  assert('auto without a classifier still asks', run.asked.length === 1 && run.action.type === 'deny');
}

async function main(): Promise<void> {
  staticRules();
  await gateModes();
  report();
}

await main();
