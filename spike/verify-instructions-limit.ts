/** Configurable instructions cap: real files/config/runtime/import, no provider or network. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MAX_INSTRUCTIONS_BYTES, loadProjectInstructions, resolveInstructionsByteLimit } from '../src/agent/instructions.js';
import { ConfigError, configPath, loadConfig, withModelChoice } from '../src/config.js';
import { parseInitCommand } from '../src/commands/init-command.js';
import { formatInstructionsLoadedRow } from '../src/tui/instructions-format.js';
import { runDoctorCommand } from '../src/cli-doctor.js';
import { scanClaudeImport, applyClaudeImport, formatImportPlan } from '../src/import-claude.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { CaptureModel } from './offline-model.js';
import { ownPrivateHome } from './shared.js';

const home = ownPrivateHome('instructions-limit');
const root = path.join(home, 'project');
await mkdir(root);
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
const file = configPath();
const configure = (value: Record<string, unknown>) => writeFile(file, JSON.stringify(value));

assert.equal(DEFAULT_MAX_INSTRUCTIONS_BYTES, 65536);
assert.equal((await loadConfig(root)).maxInstructionsBytes, 65536, 'missing file uses 64 KiB');
await configure({});
assert.equal((await loadConfig(root)).maxInstructionsBytes, 65536, 'omitted key uses 64 KiB');
for (const value of [1, 1024, 32768, 131072, Number.MAX_SAFE_INTEGER]) {
  await configure({ maxInstructionsBytes: value });
  assert.equal((await loadConfig(root)).maxInstructionsBytes, value);
}
for (const value of [0, -1, 1.5, null, false, '65536', [], {}, 1e100]) {
  await configure({ maxInstructionsBytes: value });
  await assert.rejects(loadConfig(root), (error: unknown) => error instanceof ConfigError && error.message.includes('maxInstructionsBytes'));
  assert.throws(() => resolveInstructionsByteLimit(value));
}
for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => resolveInstructionsByteLimit(value));
const models = [
  { name: 'one', provider: 'bedrock', model: 'fake.one', enable: true },
  { name: 'two', provider: 'bedrock', model: 'fake.two', enable: false },
];
await configure({ models, maxInstructionsBytes: 131072 });
const array = await loadConfig(root);
assert.equal(withModelChoice(array, array.modelChoices[1]!).maxInstructionsBytes, 131072, 'session limit survives model switch');
await configure({ models: [{ ...models[0], maxInstructionsBytes: 1024 }] });
await assert.rejects(loadConfig(root), ConfigError, 'per-model setting rejected');

const body = '# Rules\n' + `${'x'.repeat(63)}\n`.repeat(1152) + 'TAIL_VISIBLE\n';
for (const filename of ['AGENTS.md', 'CLAUDE.md'] as const) {
  const dir = path.join(root, filename);
  await mkdir(dir);
  await writeFile(path.join(dir, filename), body);
  const normal = (await loadProjectInstructions(dir)).instructions!;
  assert.equal(normal.maxBytes, 65536);
  assert.equal(normal.truncated, true);
  assert(!normal.fragment.includes('TAIL_VISIBLE'));
  const larger = (await loadProjectInstructions(dir, 131072)).instructions!;
  assert.equal(larger.truncated, false);
  assert(larger.fragment.includes('TAIL_VISIBLE'));
  const smaller = (await loadProjectInstructions(dir, 1024)).instructions!;
  assert.equal(smaller.maxBytes, 1024);
  assert.match(smaller.fragment, /1 KiB \(1024 bytes\)/);
  assert.match(formatInstructionsLoadedRow(smaller), /truncated to 1 KiB/);
  await writeFile(path.join(dir, filename), 'x'.repeat(1024));
  assert.equal((await loadProjectInstructions(dir, 1024)).instructions?.truncated, false, 'exact byte boundary');
  await writeFile(path.join(dir, filename), '好'.repeat(1024));
  assert(!(await loadProjectInstructions(dir, 1024)).instructions?.fragment.includes('�'), 'UTF-8 boundary remains valid');
}
for (const loaded of [undefined, { filename: 'AGENTS.md' as const, bytes: 2000, truncated: true }]) {
  const prompt = parseInitCommand('/init', { loaded, problemFile: undefined, maxInstructionsBytes: 1024 })!.message;
  assert.match(prompt, /1 KiB \(1024 bytes\)/);
  assert(!prompt.includes('64 KiB'));
}
// Free the two fixture directories so the runtime project can own a regular AGENTS.md.
await rm(path.join(root, 'AGENTS.md'), { recursive: true });
await rm(path.join(root, 'CLAUDE.md'), { recursive: true });

await writeFile(path.join(root, 'AGENTS.md'), body);
await configure({ model: 'fake.instructions', maxInstructionsBytes: 1024, memory: false, promptCache: false });
let doctorText = '';
assert.equal(await runDoctorCommand({ projectRoot: root, out: text => { doctorText += text; }, err: () => {} }), 1);
assert.match(doctorText, /cap 1,024/);
assert.match(doctorText, /AGENTS.md is over the cap/);
const model = new CaptureModel();
setRuntimeModelFactoryForTest(async () => model);
let runtime: AgentRuntime | undefined;
try {
  runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' },
    permissionBridge: allowAllBridge });
  assert.equal(runtime.info.projectInstructions?.maxBytes, 1024);
  assert.match((await runtime.expandSlashCommand('/init'))!.message, /1 KiB \(1024 bytes\)/);
  for await (const _event of runtime.send('probe')) void _event;
  const prompt = JSON.stringify(model.calls[0]?.systemPrompt);
  assert(prompt.includes('1024 bytes') && !prompt.includes('TAIL_VISIBLE'), 'actual SDK request uses configured cap');
  const savedSession = runtime.info.sessionId;
  runtime = await runtime.startNewSession();
  assert.equal(runtime.info.projectInstructions?.maxBytes, 1024, 'clear successor retains limit');
  await runtime.shutdown();
  await configure({ model: 'fake.instructions', maxInstructionsBytes: 131072, memory: false, promptCache: false });
  runtime = await AgentRuntime.create({ projectRoot: root,
    session: { kind: 'id', sessionId: savedSession }, permissionBridge: allowAllBridge });
  for await (const _event of runtime.send('resume probe')) void _event;
  assert(!JSON.stringify(model.calls.at(-1)?.systemPrompt).includes('TAIL_VISIBLE'), 'resume keeps saved prompt rather than rewriting history');
  runtime = await runtime.startNewSession();
  assert.equal(runtime.info.projectInstructions?.maxBytes, 131072);
  for await (const _event of runtime.send('fresh probe')) void _event;
  assert(JSON.stringify(model.calls.at(-1)?.systemPrompt).includes('TAIL_VISIBLE'), 'new session uses larger configured limit');
} finally {
  await runtime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}
await configure({ maxInstructionsBytes: 131072 });
doctorText = '';
assert.equal(await runDoctorCommand({ projectRoot: root, out: text => { doctorText += text; }, err: () => {} }), 0);
assert.match(doctorText, /cap 131,072/);
assert(!doctorText.includes('over the cap'));
await configure({ maxInstructionsBytes: 0 });
doctorText = '';
assert.equal(await runDoctorCommand({ projectRoot: root, out: text => { doctorText += text; }, err: () => {} }), 1);
assert.match(doctorText, /not inspected \(configuration invalid/);

const imported = path.join(home, 'imported');
await mkdir(imported);
await writeFile(path.join(imported, 'CLAUDE.md'), body);
await configure({ maxInstructionsBytes: 65536 });
let plan = scanClaudeImport(imported);
assert.match(formatImportPlan(plan), /65536-byte instruction cap/);
assert.equal(plan.writes.length, 0);
await configure({ maxInstructionsBytes: 131072, provider: 'invalid-but-not-loaded' });
plan = scanClaudeImport(imported);
assert.equal(plan.writes.length, 1);
await configure({ maxInstructionsBytes: 1024 });
assert.equal(applyClaudeImport(plan).failed, true, 'config change after scan refuses apply');
await configure({ maxInstructionsBytes: 131072 });
plan = scanClaudeImport(imported);
assert.equal(applyClaudeImport(plan).failed, false);
const saved = await readFile(path.join(imported, 'AGENTS.md'));
assert(saved.includes('TAIL_VISIBLE'));
assert.equal((await loadProjectInstructions(imported, (await loadConfig(imported)).maxInstructionsBytes)).instructions?.truncated, false);
const unchanged = await readFile(file);
scanClaudeImport(imported);
assert.deepEqual(await readFile(file), unchanged, 'import never rewrites config');
for (const invalid of ['not json', JSON.stringify({ maxInstructionsBytes: 0 }), 'null']) {
  await writeFile(file, invalid);
  const refused = scanClaudeImport(imported);
  assert.match(formatImportPlan(refused), /invalid config.json or maxInstructionsBytes/);
  assert.equal(refused.writes.length, 0);
  assert.deepEqual(await readFile(path.join(imported, 'AGENTS.md')), saved);
}

console.log('PASS configurable instruction limits: defaults, validation, scopes, runtime, doctor and offline import');
