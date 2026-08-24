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
const LOG = path.join(ROOT, 'events.jsonl');

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
  const append = `node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>require("fs").appendFileSync(${JSON.stringify(LOG)},s))'`;
  assert('absent lifecycle config constructs no runner input', lifecycleHooksFromConfig(undefined) === undefined);
  assert('tool-only config constructs no lifecycle runner input', lifecycleHooksFromConfig({
    PreToolUse: [group('*', append)],
  }) === undefined);

  const runner = new LifecycleHookRunner(ROOT, {
    TurnComplete: [group('interactive', append, append), group('headless', append)],
    PermissionRequest: [group('reader#*', append), group('parent', append)],
  });
  const started = Date.now();
  runner.publish({ event: 'TurnComplete', outcome: 'success', source: 'interactive' });
  assert('publication does not await command completion', Date.now() - started < 100);
  runner.publish({ event: 'PermissionRequest', source: 'reader#dispatch-1' });
  assert('all launched observers receive their payload', await waitFor(async () => {
    try { return (await readFile(LOG, 'utf8')).trim().split('\n').length === 3; } catch { return false; }
  }));
  await runner.close();
  const events = (await readFile(LOG, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert('each matching command receives exactly one object', events.length === 3);
  assert('turn payload is closed and structured', events.slice(0, 2).every((event) =>
    JSON.stringify(event) === '{"event":"TurnComplete","outcome":"success","source":"interactive"}'));
  assert('permission payload contains only its bounded source label',
    JSON.stringify(events[2]) === '{"event":"PermissionRequest","source":"reader#dispatch-1"}');
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
  const queue = new PermissionQueue((source) => observed.push(source));
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
  queue.setObserver((source) => observed.push(source));
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
