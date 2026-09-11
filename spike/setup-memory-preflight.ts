/** Setup preflight evidence, not a wizard: real readers/SDK HTTP, scripted delivery only. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { type AgentCoreConfig, scopeFor } from '../src/agentcore/config.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { runDoctorCommand } from '../src/cli-doctor.js';
import { configFilePath, loadConfig } from '../src/config.js';
import { sessionPaths } from '../src/agent/session.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { CaptureModel } from './offline-model.js';

async function snapshot(directory: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('fixture-')) continue; // Synthetic server logs are not product writes.
    const file = path.join(directory, entry.name);
    const meta = await stat(file);
    result[file] = entry.isDirectory() ? { directory: true, mode: meta.mode } : { bytes: (await readFile(file)).toString('base64'), mode: meta.mode, mtime: meta.mtimeMs };
    if (entry.isDirectory()) Object.assign(result, await snapshot(file));
  }
  return result;
}

export async function verifySetupPreflight({ home, root, repo, baseConfig, config, instructions }: {
  home: string; root: string; repo: string; baseConfig: object; config: AgentCoreConfig; instructions: string;
}): Promise<void> {
  const savedEnv = { ...process.env };
  // No inherited profile, role, endpoint, credential or region can escape these fixtures.
  for (const key of Object.keys(process.env)) if (key.startsWith('AWS_') || key === 'DARWIN_TEST_AGENTCORE_PORT') delete process.env[key];
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDSYNTHETIC', AWS_SECRET_ACCESS_KEY: 'synthetic-not-a-secret', AWS_REGION: 'us-west-2', AWS_EC2_METADATA_DISABLED: 'true', DARWIN_MODEL_PRICES_FETCH: 'off' });
  const server = spawn(process.execPath, [path.join(repo, 'spike/agentcore-http-fixture.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const kill = () => { server.kill('SIGTERM'); };
  process.on('exit', kill);
  const file = configFilePath();
  const original = await readFile(file);
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
      server.once('error', reject);
    });
    process.env['DARWIN_TEST_AGENTCORE_PORT'] = String(port);
    setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port) }));
    const control = (value: object) => writeFile(path.join(home, 'fixture-control.json'), JSON.stringify(value));
    const calls = async (): Promise<{ operation: string; input: any; headers: Record<string, string> }[]> => {
      try { return (await readFile(path.join(home, 'fixture-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', path.join(repo, 'spike/agentcore-sdk-fixture.ts'), path.join(repo, 'src/cli.ts'), ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    const doctor = async () => {
      let text = '';
      const code = await runDoctorCommand({ projectRoot: root, out: value => { text += value; }, err: value => { text += value; } });
      return { code, text };
    };
    const configure = (memory: unknown) => writeFile(file, JSON.stringify({ ...baseConfig, agentCoreMemory: memory }), { mode: 0o600 });
    await control({ records: [] });
    // Real filesystem/loader semantics: only ENOENT or omitted/false memory is absent/disabled.
    await rm(file);
    let before = await snapshot(home);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal((await loadConfig(root)).agentCoreMemory, undefined);
    assert.equal((await doctor()).code, 0);
    assert.deepEqual(await snapshot(home), before, 'missing-file diagnostics create nothing');
    for (const value of [undefined, false]) {
      await configure(value);
      before = await snapshot(home);
      assert.equal((await loadConfig(root)).agentCoreMemory, undefined);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).agentCoreMemory, value, 'omitted and intentional false remain distinguishable');
      const status = cli('cloud-memory', 'status');
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /disabled/);
      assert.equal((await doctor()).code, 0);
      assert.deepEqual(await snapshot(home), before);
    }
    for (const invalid of ['{', JSON.stringify({ ...baseConfig, agentCoreMemory: { ...config, actorId: '../invalid' } })]) {
      await writeFile(file, invalid);
      before = await snapshot(home);
      await assert.rejects(loadConfig(root), /not valid JSON|invalid configuration/);
      const report = await doctor();
      assert.equal(report.code, 1);
      assert.match(report.text, /! config:/);
      const status = cli('cloud-memory', 'status');
      assert.equal(status.status, 1);
      assert(!status.stdout.includes('disabled'), 'malformed is not absent');
      assert.deepEqual(await snapshot(home), before);
    }
    // EISDIR is a portable unreadable-config fixture (chmod 000 would pass as root).
    await rm(file); await mkdir(file);
    before = await snapshot(home);
    await assert.rejects(loadConfig(root), /Could not read/);
    assert.equal((await doctor()).code, 1);
    assert.equal(cli('cloud-memory', 'status').status, 1);
    assert.deepEqual(await snapshot(home), before);
    await rm(file, { recursive: true });
    assert.equal((await calls()).length, 0, 'doctor/local status never reach SDK HTTP');
    const saved = { ...config, region: 'us-east-1', preferences: false, upload: 'off' as const, projectId: 'shared-checkouts', cliPath: '/not-installed/legacy-aws', timeoutMs: 1000 };
    await configure(saved);
    before = await snapshot(home);
    assert.deepEqual((await loadConfig(root)).agentCoreMemory, saved);
    const offline = cli('doctor');
    assert.equal(offline.status, 0, offline.stderr);
    const status = cli('cloud-memory', 'status');
    assert.equal(status.status, 0, status.stderr);
    for (const term of [saved.region, saved.actorId, saved.projectId, 'upload off']) assert(status.stdout.includes(term));
    assert.equal((await calls()).length, 0, 'doctor zero and status success are not cloud health');
    assert(!status.stdout.includes(saved.cliPath));
    const empty = cli('cloud-memory', 'preferences');
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout).records, []);
    assert.match(empty.stderr, /deprecated and ignored/);
    assert.deepEqual(await snapshot(home), before, 'healthy reads leave all config/cloud/project bytes and modes intact');

    const record = { memoryRecordId: 'record-' + 'a'.repeat(40), memoryStrategyId: saved.preferenceStrategyId, namespaces: [scopeFor(saved, root).preferences], createdAt: '2026-01-01T00:00:00Z', content: { text: JSON.stringify({ context: 'Communication across projects', preference: 'synthetic private preference', categories: ['communication'] }) } };
    await control({ records: [record] });
    const memory = new CloudMemory(saved, root, 'check-only');
    try {
      const result = await memory.commandResult('preferences');
      assert(result.ok);
      const safeSummary = { ok: result.ok, count: JSON.parse(result.text).records.length };
      assert.deepEqual(safeSummary, { ok: true, count: 1 });
      assert(!JSON.stringify(safeSummary).includes('synthetic private preference'));
      assert.equal(await memory.context(), '', 'check-only preferences false never applies records');
    } finally { await memory.close(); }
    assert.deepEqual(await snapshot(home), before, 'read-only preferences write no adoption proofs');

    for (const [mode, expected] of [['denied', /HTTP 403/], ['hang', /timed out/], ['invalid-json', /failed/]] as const) {
      await control({ mode });
      const failed = cli('cloud-memory', 'preferences');
      assert.equal(failed.status, 1, `${mode}: must fail, not empty success`);
      assert.match(failed.stdout, expected);
      assert(!failed.stdout.includes('secret denial') && !failed.stdout.includes('disabled'));
    }
    await control({ records: [{ ...record, namespaces: ['/users/wrong-scope/'] }] });
    const wrongScope = cli('cloud-memory', 'preferences');
    assert.equal(wrongScope.status, 1);
    assert.match(wrongScope.stdout, /scope|namespace/i);
    await control({ records: [] });
    delete process.env['AWS_ACCESS_KEY_ID']; delete process.env['AWS_SECRET_ACCESS_KEY'];
    const countBeforeCredentials = (await calls()).length;
    const noCredentials = cli('cloud-memory', 'preferences');
    assert.equal(noCredentials.status, 1);
    assert.match(noCredentials.stdout, /SDK request failed|timed out/);
    assert.equal((await calls()).length, countBeforeCredentials, 'no credentials never issue an unsigned request');
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDSYNTHETIC', AWS_SECRET_ACCESS_KEY: 'synthetic-not-a-secret' });
    assert.deepEqual(await snapshot(home), before, 'failures never repair/reset config or create cloud state');

    // Unrelated diagnostics do not invalidate the memory loader or imply a missing resource.
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { missing: { command: 'setup-fixture-nonexistent-command' } } }));
    const warning = await doctor();
    assert.equal(warning.code, 1);
    assert.match(warning.text, /not found on PATH/);
    assert(!warning.text.includes('! config:'));
    assert.deepEqual((await loadConfig(root)).agentCoreMemory, saved);
    assert.equal(cli('cloud-memory', 'preferences').status, 0);
    await rm(path.join(root, '.mcp.json'));
    const requests = await calls();
    assert(requests.length >= 7);
    for (const request of requests) {
      assert.equal(request.operation, 'retrieve-memory-records', 'only readonly retrieval, never STS/control plane/write/delete');
      assert.equal(request.input.memoryId, saved.memoryId);
      assert.equal(request.input.namespacePath, scopeFor(saved, root).preferences);
      assert.equal(request.input.searchCriteria.memoryStrategyId, saved.preferenceStrategyId);
      assert.equal(request.input.searchCriteria.topK, 5);
      assert.equal(request.input.maxResults, 5);
      assert.equal(request.input.nextToken, undefined);
      assert(request.headers.authorization?.includes(`/${saved.region}/bedrock-agentcore/`));
    }
    // Fixed replies select already-exercised scenarios, not a production classifier or proof
    // that arbitrary models obey the guide. Both drivers must deliver the same full policy.
    const healthyReply = `AgentCore Memory 已配置且基本检查通过，无需重复设置。Region ${saved.region}; actor ${saved.actorId}; upload off. Local and bounded read-only checks passed (0 records). No config/resource edits or restart needed. Extraction/write not tested.`;
    const scenarios = [
      { label: 'healthy', memory: saved, reply: healthyReply, question: false },
      { label: 'missing', memory: undefined, reply: 'Setup pending: memory config is absent. What username / actorId should I use? Confirm proposed defaults before changes.', question: true },
      { label: 'failed', memory: saved, reply: 'Existing memory failed the basic read (HTTP 403), not absent. Saved actor and resource retained. May I investigate read permission for this resource? No changes made; repair pending.', question: true },
    ];
    const sessions = sessionPaths(root).stateDir;
    const outsideSessions = (files: Record<string, unknown>) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== sessions && !name.startsWith(sessions + path.sep) && !sessions.startsWith(name + path.sep)));
    for (const scenario of scenarios) {
      await configure(scenario.memory);
      const beforeTurn = outsideSessions(await snapshot(home));
      const beforeReads = (await calls()).length;
      const model = new CaptureModel(scenario.reply);
      setRuntimeModelFactoryForTest(async () => model);
      const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: false }) });
      try {
        assert.equal(await runHeadlessTurn(runtime, '/setup-agentcore-memory', () => {}), scenario.reply);
        const structured = await runStructuredHeadlessTurn(runtime, '/setup-agentcore-memory', new StructuredHeadlessWriter('json', () => {}), () => 'unexpected tool');
        assert.equal(structured.reply, scenario.reply);
        assert.equal(/[?？]/.test(structured.reply), scenario.question, `${scenario.label}: questions only when needed`);
        assert.equal(model.calls.length, 2);
        for (const call of model.calls) {
          const text = call.messages.at(-1)?.content.map(block => block.type === 'textBlock' ? block.text : '').join('') ?? '';
          assert(text.includes(instructions), `${scenario.label}: complete preflight and setup policy delivered`);
        }
        if (scenario.label === 'healthy') assert(!/what username|confirm.*defaults/i.test(structured.reply));
      } finally { await runtime.shutdown(); setRuntimeModelFactoryForTest(undefined); }
      assert.equal((await calls()).length, beforeReads, 'scripted turn/expansion does not manufacture live-read evidence');
      assert.deepEqual(outsideSessions(await snapshot(home)), beforeTurn, 'scripted turns write only ordinary session/trajectory state');
    }
  } finally {
    setMemoryTransportOptionsForTest(undefined);
    setRuntimeModelFactoryForTest(undefined);
    await writeFile(file, original, { mode: 0o600 });
    server.kill('SIGTERM');
    await new Promise<void>(resolve => server.once('close', () => resolve()));
    process.off('exit', kill);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
  console.log('setup preflight: real local/SDK loopback cases and scripted branch delivery passed (no AWS)');
}
