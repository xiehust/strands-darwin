/**
 * Focused, network-free contracts for the pinned SDK fileEditor view behavior.
 *
 * These checks drive the exported tool through its provider-facing schema and
 * stream() path against real files. They intentionally do not duplicate the
 * vended implementation in Darwin source.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';

import { assert, header, report } from './shared.js';

interface FileEditorResult {
  status: 'success' | 'error';
  text: string;
}

class NoCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = {
    modelId: 'offline.file-editor-verification',
    contextWindowLimit: 10_000,
  };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new Error('The fileEditor verification must not call a model');
  }
}

function expectedView(filePath: string, lines: readonly string[], start = 1): string {
  const numbered = lines.map((line, index) => `${String(start + index).padStart(6)}  ${line}`);
  return `Here's the result of running \`cat -n\` on ${filePath}:\n${numbered.join('\n')}\n`;
}

async function runView(
  agent: Agent,
  filePath: string,
  viewRange?: readonly [number, number],
): Promise<FileEditorResult> {
  const input = {
    command: 'view',
    path: filePath,
    ...(viewRange === undefined ? {} : { view_range: viewRange }),
  };
  const stream = fileEditor.stream({
    toolUse: { name: fileEditor.name, toolUseId: 'file-editor-verification', input },
    agent,
    invocationState: {},
    interrupt: () => {
      throw new Error('fileEditor view unexpectedly interrupted');
    },
  } as never);
  let item = await stream.next();
  while (!item.done) item = await stream.next();
  const result = item.value.toJSON() as {
    toolResult: { status: 'success' | 'error'; content: Array<{ text?: string }> };
  };
  return {
    status: result.toolResult.status,
    text: result.toolResult.content.map((content) => content.text ?? '').join(''),
  };
}

function assertError(label: string, result: FileEditorResult, fragment: string): void {
  assert(`${label} is an explicit tool error`, result.status === 'error');
  assert(`${label} explains the invalid input`, result.text.includes(fragment));
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-file-editor-'));
const agent = new Agent({ model: new NoCallModel(), tools: [fileEditor], printer: false });

try {
  await agent.initialize();

  header('fileEditor — provider schema remains compatible');

  const schema = fileEditor.toolSpec.inputSchema as {
    properties?: Record<string, { type?: string; prefixItems?: Array<{ type?: string }> }>;
    required?: string[];
  };
  assert('the runtime-facing tool keeps the fileEditor name', fileEditor.name === 'fileEditor');
  assert('the provider schema still requires command and path',
    JSON.stringify(schema.required) === JSON.stringify(['command', 'path']));
  assert('view_range remains a two-number tuple at the provider boundary',
    schema.properties?.['view_range']?.type === 'array'
      && schema.properties['view_range'].prefixItems?.length === 2
      && schema.properties['view_range'].prefixItems?.every((item) => item.type === 'number') === true);
  assert('write-command fields remain present in the same provider schema',
    ['file_text', 'old_str', 'new_str', 'insert_line'].every((name) => schema.properties?.[name] !== undefined));

  header('fileEditor — oversized positive view end clamps to EOF');

  const sourceLines = Array.from({ length: 41 }, (_, index) => `source-line-${String(index + 1).padStart(2, '0')}`);
  const source = sourceLines.join('\n');
  const sourcePath = path.join(root, 'forty-one-lines.txt');
  await writeFile(sourcePath, source);
  const beforeBytes = await readFile(sourcePath);
  const beforeStat = await stat(sourcePath, { bigint: true });
  let writes = 0;
  const sandbox = agent.sandbox;
  const originalWriteFile = sandbox.writeFile.bind(sandbox);
  sandbox.writeFile = async (...args: Parameters<typeof sandbox.writeFile>) => {
    writes += 1;
    return originalWriteFile(...args);
  };

  const oversized = await runView(agent, sourcePath, [1, 100]);
  const sentinel = await runView(agent, sourcePath, [1, -1]);
  const afterBytes = await readFile(sourcePath);
  const afterStat = await stat(sourcePath, { bigint: true });
  const exactWholeFile = expectedView(sourcePath, sourceLines);
  assert('an oversized positive end succeeds', oversized.status === 'success');
  assert('the successful output is exactly the existing whole-file format', oversized.text === exactWholeFile);
  assert('oversized positive end is byte-compatible with the EOF sentinel', oversized.text === sentinel.text);
  const outputLines = oversized.text.split('\n').slice(1, -1);
  assert('the output contains exactly 41 numbered content rows', outputLines.length === 41);
  assert('each source line appears exactly once and in order',
    outputLines.every((line, index) => line === `${String(index + 1).padStart(6)}  ${sourceLines[index]}`));
  assert('view never calls the sandbox write primitive', writes === 0);
  assert('view leaves file bytes unchanged', Buffer.compare(beforeBytes, afterBytes) === 0);
  assert('view leaves write metadata unchanged',
    beforeStat.mtimeNs === afterStat.mtimeNs && beforeStat.ctimeNs === afterStat.ctimeNs);

  header('fileEditor — sentinel and in-range views remain byte-compatible');

  const inRange = await runView(agent, sourcePath, [7, 12]);
  const fromSeven = await runView(agent, sourcePath, [7, -1]);
  assert('an in-range positive range keeps its exact output',
    inRange.status === 'success' && inRange.text === expectedView(sourcePath, sourceLines.slice(6, 12), 7));
  assert('the -1 sentinel keeps its exact output',
    fromSeven.status === 'success' && fromSeven.text === expectedView(sourcePath, sourceLines.slice(6), 7));

  header('fileEditor — invalid bounds stay explicit');

  assertError('a start beyond EOF', await runView(agent, sourcePath, [42, 100]), 'first element `42`');
  assertError('a zero start', await runView(agent, sourcePath, [0, 4]), 'first element `0`');
  assertError('a negative start', await runView(agent, sourcePath, [-1, 4]), 'first element `-1`');
  assertError('start after end', await runView(agent, sourcePath, [9, 8]), 'larger or equal than its first `9`');
  assertError('a zero end', await runView(agent, sourcePath, [1, 0]), 'larger or equal than its first `1`');
  assertError('a negative non-sentinel end', await runView(agent, sourcePath, [1, -2]), 'larger or equal than its first `1`');

  header('fileEditor — unrelated view behavior is unchanged');

  const emptyPath = path.join(root, 'empty.txt');
  await writeFile(emptyPath, '');
  const emptyWhole = await runView(agent, emptyPath);
  assert('an empty file keeps its existing one-blank-row projection',
    emptyWhole.status === 'success' && emptyWhole.text === expectedView(emptyPath, ['']));
  assertError('an oversized range on an empty file', await runView(agent, emptyPath, [1, 100]), 'second element `100`');

  const directoryPath = path.join(root, 'directory');
  await mkdir(directoryPath);
  await writeFile(path.join(directoryPath, 'visible.txt'), 'visible');
  const directory = await runView(agent, directoryPath);
  assert('directory listing behavior is unchanged',
    directory.status === 'success'
      && directory.text === `Here's the files and directories up to 2 levels deep in ${directoryPath}, excluding hidden items:\nvisible.txt\n`);
  assertError('a range on a directory', await runView(agent, directoryPath, [1, 100]), 'not allowed');
  assertError('a missing path', await runView(agent, path.join(root, 'missing.txt'), [1, 100]), 'does not exist');

  const binaryPath = path.join(root, 'invalid-utf8.bin');
  await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0x00]));
  const binary = await runView(agent, binaryPath);
  assert('invalid UTF-8 keeps the sandbox decoder and existing output path',
    binary.status === 'success' && binary.text === expectedView(binaryPath, ['��\u0000']));

  const largePath = path.join(root, 'too-large.txt');
  await writeFile(largePath, 'x'.repeat(1_048_577));
  assertError('the existing size bound', await runView(agent, largePath, [1, 2_000_000]), 'exceeds maximum allowed size');
} finally {
  await rm(root, { recursive: true, force: true });
}

report();
