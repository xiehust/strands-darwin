/**
 * Presentation contracts for subagent dispatch state: the `/agents` report, the
 * completion notice, the live delegation row, and the dispatch id every one of
 * them keys on. Pure — no agents, no models, no processes.
 */
import {
  SubagentDispatchRegistry,
  shortDispatchId,
  type SubagentDispatchStatus,
} from '../src/agents/dispatch-registry.js';
import {
  dispatchElapsedMs,
  formatDispatchCompletion,
  formatDispatchesReport,
  subagentCallSummary,
} from '../src/tui/subagent-format.js';
import { assert, header, report } from './shared.js';

function dispatched(overrides: Partial<SubagentDispatchStatus> = {}): SubagentDispatchStatus {
  return {
    dispatchId: 'a1b2c3d4',
    agentName: 'explorer',
    task: 'find every call site of classify',
    state: 'running',
    startedAt: '2026-08-15T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function dispatchIds(): void {
  header('subagent format — dispatch ids');

  assert('a provider tool-use id loses its uninformative prefix', shortDispatchId('tooluse_AbCd1234efgh') === 'AbCd1234');
  assert('the same id always shortens the same way', shortDispatchId('tooluse_AbCd1234efgh') === shortDispatchId('tooluse_AbCd1234efgh'));
  assert('separators are dropped, not counted', shortDispatchId('tool_use-ab-cd-ef-gh-ij') === 'abcdefgh');
  assert('a short id survives intact', shortDispatchId('sub-1') === 'sub1');

  const generated = shortDispatchId(undefined);
  assert('a missing tool-use id gets an id of its own', /^[0-9a-f]{8}$/.test(generated));
  assert('generated ids are not a shared placeholder', generated !== shortDispatchId(undefined));
  assert('a prefix-only id also falls back', /^[0-9a-f]{8}$/.test(shortDispatchId('tooluse_')));
}

function elapsed(): void {
  header('subagent format — elapsed time endpoints');

  const running = dispatched();
  const now = Date.parse('2026-08-15T10:00:12.000Z');
  assert('a running dispatch measures up to now', dispatchElapsedMs(running, now) === 12_000);

  const finished = dispatched({ state: 'succeeded', finishedAt: '2026-08-15T10:00:04.000Z' });
  assert('a finished dispatch measures to its finish', dispatchElapsedMs(finished, now) === 4_000);
  assert('a malformed timestamp reads as zero, not NaN', dispatchElapsedMs(dispatched({ startedAt: 'nope' }), now) === 0);
  assert('clock skew cannot go negative', dispatchElapsedMs(running, Date.parse('2026-08-15T09:59:00.000Z')) === 0);
}

function reportRows(): void {
  header('subagent format — /agents report');

  assert(
    'the empty report names dispatches, not the agent catalogue',
    formatDispatchesReport([]) === 'subagent dispatches — none in this run',
  );

  const now = Date.parse('2026-08-15T10:00:12.000Z');
  const rendered = formatDispatchesReport(
    [
      dispatched(),
      dispatched({
        dispatchId: '0f9e8d7c',
        agentName: 'general',
        task: 'summarize   the\npermission gate',
        state: 'succeeded',
        finishedAt: '2026-08-15T10:00:04.000Z',
      }),
    ],
    now,
  );
  const lines = rendered.split('\n');
  console.log(rendered.split('\n').map((line) => `  ${JSON.stringify(line)}`).join('\n'));

  assert('the heading counts this run', lines[0] === 'subagent dispatches — this run (2)');
  assert('start order is preserved', lines[1]?.includes('explorer#a1b2c3d4') === true);
  assert('a row carries agent, dispatch, state and elapsed', /explorer#a1b2c3d4\s+running\s+12s\s+find every call site/.test(lines[1] ?? ''));
  assert('a finished row uses its own finish time', /general#0f9e8d7c\s+succeeded\s+4s/.test(lines[2] ?? ''));
  assert('multiline and repeated whitespace collapse to one line', lines[2]?.includes('summarize the permission gate') === true);
  assert('every dispatch is exactly one row', lines.length === 3);

  const long = formatDispatchesReport([dispatched({ task: 'x'.repeat(400) })], now);
  assert('a long task is bounded', long.length < 200);
  assert('a bounded task says it was cut', long.includes('…'));

  // Truncation by code points, not UTF-16 units: half a surrogate pair renders as
  // a replacement character and makes the report look corrupted.
  const emoji = formatDispatchesReport([dispatched({ task: `${'🙂'.repeat(60)}` })], now);
  assert('truncation keeps whole code points', !emoji.includes('\uFFFD'));
}

function completionNotice(): void {
  header('subagent format — completion notice');

  const succeeded = formatDispatchCompletion(
    dispatched({ state: 'succeeded', finishedAt: '2026-08-15T10:00:07.000Z' }),
  );
  console.log(`  ${succeeded}`);
  assert('the notice names the dispatch and its state', succeeded.startsWith('subagent explorer#a1b2c3d4 succeeded in 7s — '));
  assert('the notice carries the task', succeeded.endsWith('find every call site of classify'));

  const cancelled = formatDispatchCompletion(
    dispatched({ state: 'cancelled', finishedAt: '2026-08-15T10:00:01.000Z' }),
  );
  assert('cancellation is reported as itself, not as failure', cancelled.includes('cancelled in 1s'));

  const failed = formatDispatchCompletion(
    dispatched({ state: 'failed', finishedAt: '2026-08-15T10:00:02.000Z', task: 'y'.repeat(400) }),
  );
  assert('a failed dispatch is still bounded', failed.length < 200 && failed.includes('failed in 2s'));
}

function liveRow(): void {
  header('subagent format — live delegation row');

  assert('a non-delegation tool is left alone', subagentCallSummary('bash', { command: 'ls' }, 'tooluse_1') === undefined);

  const explicit = subagentCallSummary('subagent', { task: 'read the gate', agent: 'explorer' }, 'tooluse_AbCd1234efgh');
  console.log(`  ${explicit}`);
  assert('the row names agent, dispatch and task', explicit === 'subagent explorer#AbCd1234: read the gate');
  assert(
    'the row id is the id the registry records',
    explicit?.includes(shortDispatchId('tooluse_AbCd1234efgh')) === true,
  );

  const implicit = subagentCallSummary('subagent', { task: 'look around' }, 'tooluse_AbCd1234efgh');
  assert('an omitted agent reads as the default one', implicit === 'subagent general#AbCd1234: look around');
  assert(
    'a blank agent name also falls back',
    subagentCallSummary('subagent', { task: 't', agent: '  ' }, 'tooluse_zzzzzzzzz') === 'subagent general#zzzzzzzz: t',
  );

  const longTask = subagentCallSummary('subagent', { task: 'z'.repeat(400) }, 'tooluse_AbCd1234efgh');
  assert('a long task cannot stretch the row', (longTask?.length ?? 0) < 120 && longTask?.includes('…') === true);

  assert(
    'a malformed input still produces a row',
    subagentCallSummary('subagent', 'not an object', 'tooluse_AbCd1234efgh') === 'subagent general#AbCd1234',
  );
  assert(
    'a missing task produces a row without a colon',
    subagentCallSummary('subagent', { agent: 'explorer' }, 'tooluse_AbCd1234efgh') === 'subagent explorer#AbCd1234',
  );
}

function registryProjection(): void {
  header('subagent format — registry rows render as produced');

  const registry = new SubagentDispatchRegistry();
  const first = registry.begin({ agentName: 'explorer', task: 'first task', toolUseId: 'tooluse_AbCd1234efgh' });
  registry.begin({ agentName: 'general', task: 'second task' });
  first.finish('succeeded');

  const rendered = formatDispatchesReport(registry.list());
  console.log(rendered.split('\n').map((line) => `  ${line}`).join('\n'));
  assert('both dispatches appear', rendered.includes('explorer#AbCd1234') && rendered.includes('general#'));
  assert('a finished dispatch keeps its row', rendered.includes('succeeded'));
  assert('a still-running dispatch is labelled running', rendered.includes('running'));
  assert('the report shows the recorded dispatch id', rendered.includes(first.dispatchId));

  // Definition names may be up to 64 characters. One bound, applied wherever the
  // identity is rendered, so a long name cannot stretch a row or a prompt line.
  const longName = 'a'.repeat(64);
  const longRegistry = new SubagentDispatchRegistry();
  const handle = longRegistry.begin({ agentName: longName, task: 'bounded name', toolUseId: 'tooluse_abcdefgh' });
  const source = (() => {
    // The label the gate would carry needs the child agent id bound first.
    handle.attachAgent('darwin-subagent-long-1');
    return longRegistry.sourceFor('darwin-subagent-long-1');
  })();
  const longRow = formatDispatchesReport(longRegistry.list()).split('\n')[1] ?? '';
  console.log(`  ${longRow.trim()}`);
  assert('a long agent name is bounded in the report', !longRow.includes(longName) && longRow.includes('…#abcdefgh'));
  assert('the prompt label is bounded the same way', source?.label === longRow.trim().split(' ')[0]);
  assert(
    'the completion notice uses the same bounded identity',
    formatDispatchCompletion({ ...longRegistry.list()[0] as SubagentDispatchStatus, state: 'succeeded', finishedAt: new Date().toISOString() })
      .includes('…#abcdefgh'),
  );
}

dispatchIds();
elapsed();
reportRows();
completionNotice();
liveRow();
registryProjection();
report();
