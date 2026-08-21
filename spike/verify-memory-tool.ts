/**
 * SER-031: explicit bounded project recall over existing trajectory text search.
 * No model calls and no network.
 *
 * Run: pnpm tsx spike/verify-memory-tool.ts
 */
import { createHash } from 'node:crypto';
import assertNode from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_MEMORY_QUERY_CHARS,
  MAX_MEMORY_RESULT_CHARS,
  SEARCH_MEMORY_TOOL_NAME,
  createSearchMemoryTool,
  searchMemory,
} from '../src/trajectory/memory-tool.js';
import { classify, PermissionGate } from '../src/agent/permission.js';
import { sessionPaths, snapshotPath, trajectoryPath } from '../src/agent/session.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-memory-tool';
const AGENT_ID = 'darwin';
const ACTIVE = 'session-20260821-120000';
const OLDER = 'session-20260820-120000';
const DAMAGED = 'session-20260819-120000';
const MISSING = 'session-20260818-120000';
const QUERY = 'Needle🧭';

function record(seq: number, turn: number, type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, seq, t: `2026-08-${String(10 + turn).padStart(2, '0')}T00:00:00.000Z`, turn, type, ...payload })}\n`;
}

async function seed(): Promise<string[]> {
  await rm(sessionPaths(ROOT).sessionsDir, { recursive: true, force: true });
  const files: string[] = [];
  const writeTrajectory = async (sessionId: string, contents: string): Promise<void> => {
    const file = trajectoryPath(ROOT, sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
    files.push(file);
  };

  await writeTrajectory(
    ACTIVE,
    record(0, 1, 'userInput', { text: `current ${QUERY} must never match itself` }),
  );
  const long = `${'😀'.repeat(220)} ${QUERY.toUpperCase()} historical answer ${'終'.repeat(220)}`;
  await writeTrajectory(
    OLDER,
    record(0, 2, 'userInput', { text: 'unrelated request' }) +
      record(1, 2, 'contentBlockEvent', { data: { text: long } }) +
      Array.from({ length: 14 }, (_, index) =>
        record(index + 2, 3 + index, 'afterToolCallEvent', { data: { result: `limitmarker hit-${index}` } }),
      ).join(''),
  );
  await writeTrajectory(
    DAMAGED,
    record(0, 4, 'userInput', { text: `damaged session ${QUERY}` }) +
      '{not-json}\n' +
      '{"v":1,"seq":2,"turn":4,"type":"userInput","text":"partial',
  );
  await mkdir(path.dirname(snapshotPath(ROOT, MISSING, AGENT_ID)), { recursive: true });
  await writeFile(snapshotPath(ROOT, MISSING, AGENT_ID), '{}', 'utf8');
  files.push(snapshotPath(ROOT, MISSING, AGENT_ID));

  for (let index = 0; index < 22; index += 1) {
    await writeTrajectory(
      `session-20260817-${String(120000 - index).padStart(6, '0')}`,
      record(0, 1, 'userInput', { text: `old session ${index}` }),
    );
  }

  const pointer = sessionPaths(ROOT).pointerFile;
  await mkdir(path.dirname(pointer), { recursive: true });
  await writeFile(pointer, '{"sessionId":"unchanged"}\n', 'utf8');
  files.push(pointer);
  return files;
}

async function hashes(files: readonly string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(files.map(async (file) => [
    file,
    createHash('sha256').update(await readFile(file)).digest('hex'),
  ] as const)));
}

async function retrievalContracts(): Promise<void> {
  header('search_memory — bounded explicit textual retrieval');
  const files = await seed();
  const before = await hashes(files);
  const memory = createSearchMemoryTool(ROOT, ACTIVE, AGENT_ID);
  assert('the real SDK tool has the requested name', memory.name === SEARCH_MEMORY_TOOL_NAME);

  const result = String(await memory.invoke({ query: QUERY.toLowerCase() }));
  const stream = memory.stream({
    toolUse: { name: memory.name, toolUseId: 'memory-1', input: { query: QUERY } },
  } as never);
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  assert('ordinary SDK tool lifecycle returns a successful textual result',
    step.value.status === 'success' && JSON.stringify(step.value.content).includes('source: session='));
  await assertNode.rejects(
    memory.invoke({ query: '🧭'.repeat(MAX_MEMORY_QUERY_CHARS + 1) }),
    /Unicode code points/,
  );
  assert('the real SDK schema rejects an oversized Unicode query', true);
  assert('matching is case-insensitive and labels source provenance',
    result.includes(`source: session=${OLDER} turn=2 type=contentBlockEvent`));
  assert('the active session is excluded and cannot match itself',
    result.includes(`active session excluded: ${ACTIVE}`) && !result.includes(`source: session=${ACTIVE}`));
  assert('damage is explicit', result.includes(`damage: session=${DAMAGED}`) && result.includes('partial trailing line'));
  assert('snapshot-only sessions are explicit', result.includes(`missing record: session=${MISSING}`));
  assert('session scan limits state omitted sessions explicitly', result.includes('session limit:'));
  const limited = await searchMemory(ROOT, ACTIVE, AGENT_ID, 'limitmarker');
  assert('hit limits are explicit', limited.includes('hit limit reached'));
  assert('result is bounded by Unicode code points', [...result].length <= MAX_MEMORY_RESULT_CHARS);
  assert('long Unicode excerpts contain no broken surrogate replacement', !result.includes('\uFFFD'));

  const miss = await searchMemory(ROOT, ACTIVE, AGENT_ID, 'absent text');
  assert('no-match state is explicit', miss.includes('no matches in the scanned prior-session records'));
  assert('empty query is refused', await rejects(() => searchMemory(ROOT, ACTIVE, AGENT_ID, '   ')));
  assert('oversized Unicode query is refused by code points',
    await rejects(() => searchMemory(ROOT, ACTIVE, AGENT_ID, '🧭'.repeat(MAX_MEMORY_QUERY_CHARS + 1))));

  const after = await hashes(files);
  assert('every trajectory, snapshot and resume pointer remains byte-identical',
    [...before].every(([file, hash]) => after.get(file) === hash));
}

async function permissionContracts(): Promise<void> {
  header('search_memory — permission classification');
  const request = classify(SEARCH_MEMORY_TOOL_NAME, { query: 'prior decision\nspoofed' });
  assert('search_memory is statically read-safe with a one-line summary',
    request.kind === 'read' && !request.summary.includes('\n'));
  const plan = new PermissionGate({ mode: 'plan', projectRoot: ROOT, ask: async () => ({ allowed: false }) });
  assert('plan mode permits search_memory reads', plan.planGuard(SEARCH_MEMORY_TOOL_NAME, { query: 'x' }) === undefined);
  assert('unknown tools remain fail-closed execute calls', classify('unknown_memory_tool', {}).kind === 'execute');
}

async function structuralContracts(): Promise<void> {
  header('search_memory — architecture remains read-only and visible');
  const memorySource = await readFile(path.resolve('src/trajectory/memory-tool.ts'), 'utf8');
  const runtimeSource = await readFile(path.resolve('src/agent/runtime.ts'), 'utf8');
  const tuiSource = await readFile(path.resolve('src/tui/App.tsx'), 'utf8');
  assert('memory adapter calls the existing trajectory search seam', memorySource.includes('searchTrajectories('));
  assert('memory adapter contains no model/network/vector/index/writer dependency',
    !/from ['"](?:openai|@aws|\.\/writer|\.\.\/agent)|fetch\(|new (?:Agent|TrajectoryRecorder)|writeFile\(|appendFile\(/.test(memorySource));
  assert('runtime assembles search_memory in the ordinary parent tool list before child snapshot',
    runtimeSource.indexOf('createSearchMemoryTool') < runtimeSource.indexOf('const childTools = agent.tools'));
  const promptAssembly = runtimeSource.slice(
    runtimeSource.indexOf('systemPrompt: composeSystemPrompt'),
    runtimeSource.indexOf('tools: [bash'),
  );
  const invocationHook = runtimeSource.slice(
    runtimeSource.indexOf('agent.addHook(BeforeInvocationEvent'),
    runtimeSource.indexOf('if (options.maxModelCalls'),
  );
  assert('runtime does not add memory to system prompt or startup hooks',
    !promptAssembly.includes('searchMemory') && !invocationHook.includes('searchMemory'));
  assert('no bespoke TUI memory surface exists', !/search_memory|SearchMemory/.test(tuiSource));
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

await retrievalContracts();
await permissionContracts();
await structuralContracts();
report();
