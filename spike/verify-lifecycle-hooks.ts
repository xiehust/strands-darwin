/** Fast offline verification for bounded observation-only lifecycle hooks. */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  LifecycleHookRunner,
  LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES,
  lifecycleHooksFromConfig,
  serializeLifecycleHookEvent,
} from '../src/hooks/lifecycle-hooks.js';
import { NEVER_WITHDRAWN, PARENT_PERMISSION_SOURCE, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { PermissionQueue } from '../src/tui/permission-queue.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-lifecycle-hooks-test';

function command(value: string) {
  return { type: 'command', command: value } as const;
}

function group(matcher: string, ...commands: string[]) {
  return { matcher, hooks: commands.map(command) } as const;
}

function request(
  label: string,
  withdrawn: AbortSignal = NEVER_WITHDRAWN,
  promptIdentity?: object,
): AssessedPermissionRequest {
  return {
    toolName: 'bash', kind: 'execute', summary: 'bash: true', details: [], input: {},
    risk: 'dangerous', riskReason: 'test', source: label === 'parent'
      ? PARENT_PERMISSION_SOURCE
      : { kind: 'child', label, dispatchId: 'dispatch-1', agentName: 'reader' },
    ...(promptIdentity === undefined ? {} : { promptIdentity }),
    suggestions: [], withdrawn,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  header('lifecycle hooks — bounded JSON, order, match and non-blocking publication');
  const turnOneLog = path.join(ROOT, 'turn-one.jsonl');
  const turnTwoLog = path.join(ROOT, 'turn-two.jsonl');
  const permissionLog = path.join(ROOT, 'permission.jsonl');
  const unmatchedTurnLog = path.join(ROOT, 'unmatched-turn.jsonl');
  const unmatchedPermissionLog = path.join(ROOT, 'unmatched-permission.jsonl');
  const capture = (target: string, delaySeconds = 0): string =>
    `sleep ${delaySeconds}; node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>require("fs").appendFileSync(${JSON.stringify(target)},s))'`;
  assert('absent lifecycle config constructs no runner input', lifecycleHooksFromConfig(undefined) === undefined);
  assert('tool-only config constructs no lifecycle runner input', lifecycleHooksFromConfig({
    PreToolUse: [group('*', capture(path.join(ROOT, 'absent.json')))],
  }) === undefined);

  const runner = new LifecycleHookRunner(ROOT, {
    TurnComplete: [
      group('interactive', capture(turnOneLog, 0.25), capture(turnTwoLog)),
      group('headless', capture(unmatchedTurnLog)),
    ],
    PermissionRequest: [
      group('reader#*', capture(permissionLog)),
      group('parent', capture(unmatchedPermissionLog)),
    ],
  });
  const started = Date.now();
  runner.publish({ event: 'TurnComplete', outcome: 'success', source: 'interactive' });
  assert('publication does not await command completion', Date.now() - started < 100);
  runner.publish({ event: 'PermissionRequest', source: 'reader#dispatch-1' });
  assert('all launched observers receive their payload', await waitFor(async () =>
    Promise.all([turnOneLog, turnTwoLog, permissionLog].map(async (target) =>
      readFile(target, 'utf8').then(() => true, () => false))).then((found) => found.every(Boolean))));
  await runner.close();
  const payloads = await Promise.all([turnOneLog, turnTwoLog, permissionLog].map((target) => readFile(target, 'utf8')));
  assert('each matching command receives exactly one object', payloads.every((payload) =>
    payload.endsWith('\n') && payload.trim().split('\n').length === 1));
  assert('unmatched commands are not launched', await Promise.all([unmatchedTurnLog, unmatchedPermissionLog]
    .map((target) => readFile(target, 'utf8').then(() => false, () => true))).then((missing) => missing.every(Boolean)));
  assert('turn payload is closed and structured', payloads.slice(0, 2).every((payload) =>
    payload === '{"event":"TurnComplete","outcome":"success","source":"interactive"}\n'));
  assert('permission payload contains only its bounded source label',
    payloads[2] === '{"event":"PermissionRequest","source":"reader#dispatch-1"}\n');
  assert('one serialized object is bounded and newline terminated',
    Buffer.byteLength(serializeLifecycleHookEvent({ event: 'TurnComplete', outcome: 'failure', source: 'headless' })!, 'utf8') <= LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES);
  assert('an over-cap source is dropped instead of making invalid JSON',
    serializeLifecycleHookEvent({ event: 'PermissionRequest', source: 'x'.repeat(LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES) }) === undefined);

  header('lifecycle hooks — failures/output are isolated and command trees are reaped');
  const pidFile = path.join(ROOT, 'pid');
  const noisy = new LifecycleHookRunner(ROOT, {
    TurnComplete: [group('*', 'printf terminal-leak; printf model-leak >&2; exit 9')],
  });
  noisy.publish({ event: 'TurnComplete', outcome: 'failure', source: 'headless' });
  await noisy.close();
  assert('nonzero commands cannot fail close()', true);

  const reaper = new LifecycleHookRunner(ROOT, {
    TurnComplete: [group('*', `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`)],
  });
  reaper.publish({ event: 'TurnComplete', outcome: 'cancelled', source: 'interactive' });
  assert('a long-running descendant starts', await waitFor(async () => {
    try { return (await readFile(pidFile, 'utf8')).trim() !== ''; } catch { return false; }
  }));
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  reaper.cancel();
  await reaper.close();
  assert('TERM→KILL cleanup reaps a command descendant', !processExists(pid));

  header('permission queue — visible prompt observation is exactly once');
  const observed: string[] = [];
  const queue = new PermissionQueue((request) => observed.push(request.source.label));
  const first = queue.bridge(request('parent'));
  const withdrawn = new AbortController();
  const second = queue.bridge(request('reader#dispatch-1', withdrawn.signal));
  assert('only the visible current prompt publishes', observed.join(',') === 'parent');
  withdrawn.abort();
  assert('a queued prompt withdrawn before visibility never publishes', observed.join(',') === 'parent');
  queue.answer({ allowed: false });
  await Promise.all([first, second]);
  const third = queue.bridge(request('reader#dispatch-1'));
  assert('a later logical prompt with the same source publishes once', observed.join(',') === 'parent,reader#dispatch-1');
  queue.setObserver((request) => observed.push(request.source.label));
  assert('observer replacement does not republish the current prompt', observed.length === 2);
  queue.answer({ allowed: false });
  await third;
  const logical = {};
  const retryWithdrawal = new AbortController();
  const retry = queue.bridge(request('parent', retryWithdrawal.signal, logical));
  assert('a first visible attempt publishes', observed.at(-1) === 'parent');
  retryWithdrawal.abort();
  await retry;
  const redecided = queue.bridge(request('parent', NEVER_WITHDRAWN, logical));
  assert('a withdrawn gate re-decision does not republish the logical prompt', observed.length === 3);
  queue.answer({ allowed: false });
  await redecided;

  queue.close();
  await queue.bridge(request('parent'));
  assert('closed queues publish nothing', observed.length === 3);

  report();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

await main();
