/**
 * SER-079 — permission decision audit at the gate: `PermissionGateOptions.onDecision`
 * publishes one frozen decision per settled `beforeToolCall` outcome.
 *
 * Free suite: no model call and no network. It proves, below the recorder, that
 * every one of the ten outcome names is produced by a real gate path (never by a
 * fixture composing the object), that `promptedUser` is true only when the bridge
 * ran, that the published object carries no input and cannot be mutated, that a
 * call denied in the hook wrapper's pre-hook guards yields exactly one record and
 * that the wrapper's ordinary path yields exactly one too, that a mode change that
 * withdraws a prompt is not an outcome (one record, after the re-decision), that a
 * throwing observer changes neither the action nor the wording the model reads,
 * that a child sharing the gate is recorded with its dispatch label, and that the
 * pure `denyRuleGuard`/`planGuard` entry points publish nothing.
 *
 * Run: pnpm tsx spike/verify-permission-audit.ts
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import {
  PermissionGate,
  type ApprovalMode,
  type AssessedPermissionRequest,
  type PermissionDecision,
  type PermissionDecisionRecord,
  type PermissionGateOptions,
  type PermissionOutcome,
} from '../src/agent/permission.js';
import { ToolHookGate } from '../src/hooks/tool-hooks.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('permission-audit');

const ROOT = '/tmp/darwin-permission-audit';
const FORCE_PUSH = 'bash:git push --force*';
const CHILD_AGENT_ID = 'child-agent-1';
const SCOPED_CHILD_AGENT_ID = 'child-agent-2';

type Action = Awaited<ReturnType<PermissionGate['beforeToolCall']>>;

let callCounter = 0;

/** Minimal stand-in for the SDK event, as in `verify-deny-rules.ts`; a fresh id per call. */
function fakeEvent(name: string, input: unknown, agentId = 'darwin'): BeforeToolCallEvent {
  callCounter += 1;
  return {
    toolUse: { name, input, toolUseId: `audit-call-${callCounter}` },
    agent: { id: agentId, cancelSignal: new AbortController().signal },
  } as unknown as BeforeToolCallEvent;
}

interface Fixture {
  gate: PermissionGate;
  asked: AssessedPermissionRequest[];
  published: PermissionDecisionRecord[];
}

function makeGate(
  options: Partial<PermissionGateOptions> & { mode?: ApprovalMode } = {},
  answer: (request: AssessedPermissionRequest, gate: () => PermissionGate) => PermissionDecision = () => ({ allowed: true }),
): Fixture {
  const asked: AssessedPermissionRequest[] = [];
  const published: PermissionDecisionRecord[] = [];
  // eslint-disable-next-line prefer-const
  let gate: PermissionGate;
  gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return answer(request, () => gate);
    },
    dispatchSource: (agentId) => {
      if (agentId === CHILD_AGENT_ID) return { dispatchId: 'd1', agentName: 'explorer', label: 'explorer#d1' };
      if (agentId === SCOPED_CHILD_AGENT_ID) {
        return { dispatchId: 'n1', agentName: 'general', label: 'general#n1', writeScopes: ['src/tui'] };
      }
      return undefined;
    },
    onDecision: (decision) => published.push(decision),
    ...options,
  });
  return { gate, asked, published };
}

const EXPECTED_KEYS = ['kind', 'mode', 'outcome', 'promptedUser', 'risk', 'source', 'toolName', 'toolUseId'];

function keysOf(decision: PermissionDecisionRecord): string {
  return Object.keys(decision).filter((key) => key !== 'rule').sort().join(',');
}

async function everyOutcome(): Promise<void> {
  header('permission audit — every outcome name comes from a real gate path');

  const seen = new Map<PermissionOutcome, PermissionDecisionRecord>();
  const record = (fixture: Fixture, expected: PermissionOutcome, action: Action, want: 'proceed' | 'deny'): void => {
    const [decision, ...extra] = fixture.published;
    assert(`${expected}: the action is ${want}`, action.type === want);
    assert(`${expected}: exactly one decision was published`, decision !== undefined && extra.length === 0);
    assert(`${expected}: the outcome is named`, decision?.outcome === expected);
    if (decision !== undefined) seen.set(expected, decision);
  };

  // write-scope-denied: a scoped workflow node writing outside its scope, in yolo.
  {
    const f = makeGate({ mode: 'yolo' });
    const action = await f.gate.beforeToolCall(
      fakeEvent('fileEditor', { command: 'create', path: 'src/agent/rogue.ts', file_text: 'x' }, SCOPED_CHILD_AGENT_ID),
    );
    record(f, 'write-scope-denied', action, 'deny');
    assert('write-scope-denied: source is the node label, kind write, nobody prompted',
      f.published[0]?.source === 'general#n1' && f.published[0].kind === 'write' && f.published[0].promptedUser === false);
  }

  // deny-rule: the rule is named, in yolo too.
  {
    const f = makeGate({ mode: 'yolo', denyRules: [FORCE_PUSH] });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'git push --force' }));
    record(f, 'deny-rule', action, 'deny');
    assert('deny-rule: the matched rule rides on the decision and the mode reads yolo',
      f.published[0]?.rule === FORCE_PUSH && f.published[0].mode === 'yolo');
  }

  // plan-denied.
  {
    const f = makeGate({ mode: 'plan' });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'rm -rf build' }));
    record(f, 'plan-denied', action, 'deny');
    assert('plan-denied: kind execute, risk dangerous, mode plan, no rule',
      f.published[0]?.kind === 'execute' && f.published[0].risk === 'dangerous' && f.published[0].mode === 'plan'
      && !('rule' in f.published[0]));
  }

  // yolo.
  {
    const f = makeGate({ mode: 'yolo' });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'rm -rf build' }));
    record(f, 'yolo', action, 'proceed');
    assert('yolo: nobody was asked and promptedUser is false', f.asked.length === 0 && f.published[0]?.promptedUser === false);
  }

  // safe.
  {
    const f = makeGate();
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'ls -la' }));
    record(f, 'safe', action, 'proceed');
    assert('safe: risk reads safe, nobody was asked', f.published[0]?.risk === 'safe' && f.asked.length === 0);
  }

  // allow-rule.
  {
    const f = makeGate({ allowRules: ['bash:pnpm test *'] });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm test --filter x' }));
    record(f, 'allow-rule', action, 'proceed');
    assert('allow-rule: the matched rule rides on the decision, nobody was asked',
      f.published[0]?.rule === 'bash:pnpm test *' && f.asked.length === 0);
  }

  // classifier.
  {
    const f = makeGate({ mode: 'auto', classifier: async () => ({ safe: true, reason: 'harmless' }) });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    record(f, 'classifier', action, 'proceed');
    assert('classifier: nobody was asked, promptedUser false, mode auto',
      f.asked.length === 0 && f.published[0]?.promptedUser === false && f.published[0].mode === 'auto');
  }

  // user-approved, with a rule granted at the prompt.
  {
    const f = makeGate({}, () => ({ allowed: true, rule: 'bash:pnpm typecheck' }));
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    record(f, 'user-approved', action, 'proceed');
    assert('user-approved: promptedUser true, the granted rule rides on the decision',
      f.asked.length === 1 && f.published[0]?.promptedUser === true && f.published[0].rule === 'bash:pnpm typecheck');
    assert('user-approved: the granted rule is live afterwards', f.gate.allowRules.includes('bash:pnpm typecheck'));
  }

  // user-approved without a rule: no `rule` key at all.
  {
    const f = makeGate({}, () => ({ allowed: true }));
    await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    assert('user-approved without a rule has no rule key', f.published.length === 1 && !('rule' in f.published[0]!));
  }

  // user-denied.
  {
    const f = makeGate({}, () => ({ allowed: false }));
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    record(f, 'user-denied', action, 'deny');
    assert('user-denied: promptedUser true, no rule', f.published[0]?.promptedUser === true && !('rule' in f.published[0]));
  }

  // restart-limit-denied: every prompt flips the mode, so each pass is withdrawn
  // until the bounded loop denies. `auto` without a classifier asks too.
  {
    const f = makeGate({}, (_request, gate) => {
      gate().setMode(gate().mode === 'default' ? 'auto' : 'default');
      return { allowed: true };
    });
    const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    record(f, 'restart-limit-denied', action, 'deny');
    assert('restart-limit-denied: the bridge ran sixteen times and promptedUser is true',
      f.asked.length === 16 && f.published[0]?.promptedUser === true);
    assert('restart-limit-denied: the withdrawn passes published nothing — one record after the limit',
      f.published.length === 1);
  }

  const ALL: PermissionOutcome[] = [
    'write-scope-denied', 'deny-rule', 'plan-denied', 'yolo', 'safe', 'allow-rule', 'classifier',
    'user-approved', 'user-denied', 'restart-limit-denied',
  ];
  assert('all ten outcome names were produced by a real gate path', ALL.every((name) => seen.has(name)));
  assert('promptedUser is true exactly for the three outcomes the bridge settled or exhausted',
    ALL.every((name) => seen.get(name)?.promptedUser === ['user-approved', 'user-denied', 'restart-limit-denied'].includes(name)));
  assert('every published object has exactly the audit keys (plus rule when one applies)',
    [...seen.values()].every((decision) => keysOf(decision) === EXPECTED_KEYS.join(',')));
  assert('no published object carries input, arguments, command, path or file text',
    [...seen.values()].every((decision) => {
      const text = JSON.stringify(decision);
      return !('input' in decision) && !('arguments' in decision) && !('command' in decision) && !('path' in decision)
        && !text.includes('rm -rf') && !text.includes('rogue.ts') && !text.includes('file_text');
    }));
  assert('every published object is frozen', [...seen.values()].every((decision) => Object.isFrozen(decision)));
  assert('every published object carries the call\u2019s toolUseId and tool name',
    [...seen.values()].every((decision) => /^audit-call-\d+$/.test(decision.toolUseId) && decision.toolName.length > 0));
}

async function withdrawnPromptIsNotAnOutcome(): Promise<void> {
  header('permission audit — a withdrawn prompt is not an outcome; the re-decision is');

  const f = makeGate({}, (_request, gate) => {
    // The user answers the prompt by switching to yolo: the prompt is withdrawn and
    // the call is re-decided from the top under yolo.
    if (gate().mode === 'default') gate().setMode('yolo');
    return { allowed: false };
  });
  const action = await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
  assert('the re-decision under yolo proceeds', action.type === 'proceed');
  assert('one record, named yolo, with promptedUser true because a prompt was shown and withdrawn',
    f.published.length === 1 && f.published[0]?.outcome === 'yolo' && f.published[0].promptedUser === true
    && f.published[0].mode === 'yolo');
  assert('the bridge ran exactly once', f.asked.length === 1);
}

async function hookWrapperOneRecord(): Promise<void> {
  header('permission audit — the hook wrapper yields exactly one record per call');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const log = path.join(ROOT, 'pre-log');
  const wrap = (fixture: Fixture): ToolHookGate =>
    new ToolHookGate(ROOT, {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `printf pre >> ${log}` }] }],
    }, fixture.gate);

  // Denied by the pre-hook deny-rule guard: published from `guardBeforeHooks`, the
  // gate's `beforeToolCall` never sees the call.
  {
    const f = makeGate({ denyRules: [FORCE_PUSH] });
    const action = await wrap(f).beforeToolCall(fakeEvent('bash', { command: 'git status && git push --force' }));
    assert('deny-rule through the wrapper: denied, no Pre shell ran, nobody asked',
      action.type === 'deny' && (await readFile(log, 'utf8').catch(() => '')) === '' && f.asked.length === 0);
    assert('deny-rule through the wrapper: exactly one record, outcome deny-rule, rule named',
      f.published.length === 1 && f.published[0]?.outcome === 'deny-rule' && f.published[0].rule === FORCE_PUSH);
  }

  // Denied by the pre-hook plan guard.
  {
    const f = makeGate({ mode: 'plan' });
    const action = await wrap(f).beforeToolCall(fakeEvent('bash', { command: 'rm -rf build' }));
    assert('plan through the wrapper: denied before any Pre shell',
      action.type === 'deny' && (await readFile(log, 'utf8').catch(() => '')) === '');
    assert('plan through the wrapper: exactly one record, outcome plan-denied',
      f.published.length === 1 && f.published[0]?.outcome === 'plan-denied');
  }

  // Passes the pre-hook guards, runs Pre, then the gate prompts: one record.
  {
    const f = makeGate({ denyRules: [FORCE_PUSH] });
    const action = await wrap(f).beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
    assert('ordinary call through the wrapper: Pre ran, the user was asked, the call proceeds',
      action.type === 'proceed' && (await readFile(log, 'utf8')) === 'pre' && f.asked.length === 1);
    assert('ordinary call through the wrapper: exactly one record, user-approved',
      f.published.length === 1 && f.published[0]?.outcome === 'user-approved' && f.published[0].promptedUser === true);
  }

  // A plan-mode read passes both guards and settles as `safe` — still one record.
  {
    const f = makeGate({ mode: 'plan' });
    const action = await wrap(f).beforeToolCall(fakeEvent('fileEditor', { command: 'view', path: 'src/x.ts' }));
    assert('a plan-mode read through the wrapper proceeds with one record named safe',
      action.type === 'proceed' && f.published.length === 1 && f.published[0]?.outcome === 'safe'
      && f.published[0].kind === 'read');
  }

  // The pure guards publish nothing.
  {
    const f = makeGate({ mode: 'plan', denyRules: [FORCE_PUSH] });
    f.gate.denyRuleGuard('bash', { command: 'git push --force' });
    f.gate.planGuard('bash', { command: 'rm -rf build' });
    assert('denyRuleGuard and planGuard called directly publish nothing', f.published.length === 0);
    assert('denyRuleGuard still denies with the rule named',
      f.gate.denyRuleGuard('bash', { command: 'git push --force' })?.type === 'deny');
  }
}

async function throwingObserver(): Promise<void> {
  header('permission audit — a throwing observer leaves the decision unchanged');

  const denyReason = (action: Action): string => (action.type === 'deny' ? action.reason : '');
  const quiet = makeGate({ denyRules: [FORCE_PUSH] }, () => ({ allowed: false }));
  const loud = makeGate(
    { denyRules: [FORCE_PUSH], onDecision: () => { throw new Error('observer exploded'); } },
    () => ({ allowed: false }),
  );

  const cases: [string, string, unknown][] = [
    ['deny-rule', 'bash', { command: 'git push --force' }],
    ['safe', 'bash', { command: 'ls' }],
    ['user-denied', 'bash', { command: 'pnpm typecheck' }],
  ];
  for (const [label, name, input] of cases) {
    const expected = await quiet.gate.beforeToolCall(fakeEvent(name, input));
    let actual: Action | undefined;
    let threw = false;
    try {
      actual = await loud.gate.beforeToolCall(fakeEvent(name, input));
    } catch {
      threw = true;
    }
    assert(`${label}: the observer's throw never reaches the caller`, !threw);
    assert(`${label}: action type and wording are identical with a throwing observer`,
      actual !== undefined && actual.type === expected.type && denyReason(actual) === denyReason(expected));
  }
  assert('the throwing observer was really invoked (the quiet twin recorded three decisions)', quiet.published.length === 3);

  // Through the wrapper's pre-hook path as well.
  const wrapped = new ToolHookGate(ROOT, {}, loud.gate);
  const action = await wrapped.beforeToolCall(fakeEvent('bash', { command: 'git push --force' }));
  assert('the wrapper\u2019s early denial survives a throwing observer', action.type === 'deny' && denyReason(action).includes(FORCE_PUSH));

  // No observer at all is the pre-SER-079 gate.
  const bare = new PermissionGate({ mode: 'default', projectRoot: ROOT, ask: async () => ({ allowed: false }) });
  const bareAction = await bare.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
  assert('a gate without an observer decides as before', bareAction.type === 'deny' && denyReason(bareAction).includes('denied permission'));
}

async function childSource(): Promise<void> {
  header('permission audit — a child sharing the gate is recorded with its dispatch label');

  const f = makeGate({ denyRules: [FORCE_PUSH] }, () => ({ allowed: true }));
  await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }, CHILD_AGENT_ID));
  await f.gate.beforeToolCall(fakeEvent('bash', { command: 'git push --force' }, CHILD_AGENT_ID));
  await f.gate.beforeToolCall(fakeEvent('bash', { command: 'pnpm typecheck' }));
  const [approved, denied, parent] = f.published;
  assert('three decisions, one per call', f.published.length === 3);
  assert('the child\u2019s prompted approval carries source explorer#d1',
    approved?.source === 'explorer#d1' && approved.outcome === 'user-approved' && approved.promptedUser === true);
  assert('the child\u2019s deny-rule denial carries the same source and the rule',
    denied?.source === 'explorer#d1' && denied.outcome === 'deny-rule' && denied.rule === FORCE_PUSH);
  assert('the parent\u2019s call reads source parent', parent?.source === 'parent');
  assert('the bridge saw the child label on the request it was asked',
    f.asked[0]?.source.label === 'explorer#d1' && f.asked[1]?.source.kind === 'parent');
  assert('the decisions carry distinct toolUseIds', new Set(f.published.map((d) => d.toolUseId)).size === 3);
}

async function main(): Promise<void> {
  await everyOutcome();
  await withdrawnPromptIsNotAnOutcome();
  await hookWrapperOneRecord();
  await throwingObserver();
  await childSource();
  await rm(ROOT, { recursive: true, force: true });
  report();
}

await main();
