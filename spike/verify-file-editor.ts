/**
 * Focused, network-free contracts for pinned SDK fileEditor recovery behavior.
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

async function runFileEditor(agent: Agent, input: Record<string, unknown>): Promise<FileEditorResult> {
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

async function runView(
  agent: Agent,
  filePath: string,
  viewRange?: readonly [number, number],
): Promise<FileEditorResult> {
  return runFileEditor(agent, {
    command: 'view',
    path: filePath,
    ...(viewRange === undefined ? {} : { view_range: viewRange }),
  });
}

async function runReplace(
  agent: Agent,
  filePath: string,
  oldStr?: string,
  newStr?: string,
): Promise<FileEditorResult> {
  return runFileEditor(agent, {
    command: 'str_replace',
    path: filePath,
    ...(oldStr === undefined ? {} : { old_str: oldStr }),
    ...(newStr === undefined ? {} : { new_str: newStr }),
  });
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

  header('fileEditor — exact str_replace misses return bounded recovery context');

  const staleLines = [
    'export function before(): void {}',
    'const unchanged = "stable";',
    'export function target(): void {',
    '  const currentValue = "fresh";',
    '  console.log(currentValue);',
    '}',
    'export function after(): void {}',
  ];
  const stalePath = path.join(root, 'stale.ts');
  await writeFile(stalePath, staleLines.join('\n'));
  const staleOld = [
    'export function target(): void {',
    '  const currentValue = "stale";',
    '  console.log(currentValue);',
    '}',
  ].join('\n');
  const staleBeforeBytes = await readFile(stalePath);
  const staleBeforeStat = await stat(stalePath, { bigint: true });
  const writesBeforeMiss = writes;
  const staleMiss = await runReplace(agent, stalePath, staleOld, 'replacement');
  const staleAfterBytes = await readFile(stalePath);
  const staleAfterStat = await stat(stalePath, { bigint: true });
  assert('a stale near-match remains an explicit error', staleMiss.status === 'error');
  assert('the exact miss error remains first and separate from advisory context',
    staleMiss.text.startsWith(`Error: No replacement was performed, old_str \`${staleOld}\` did not appear verbatim in ${stalePath}.\n\n`));
  assert('the advisory says that it did not perform a fuzzy mutation',
    staleMiss.text.includes('Advisory context only; no fuzzy replacement was attempted.'));
  assert('the advisory includes line-numbered current correction text',
    staleMiss.text.includes('     4    const currentValue = "fresh";'));
  assert('the advisory is bounded to at most five numbered rows',
    (staleMiss.text.match(/^\s*\d+  /gm) ?? []).length <= 5 && staleMiss.text.length < 2_000);
  assert('the advisory reports omitted current lines honestly', staleMiss.text.includes('[Excerpt truncated:'));
  assert('a miss never calls the sandbox write primitive', writes === writesBeforeMiss);
  assert('a miss leaves bytes unchanged', Buffer.compare(staleBeforeBytes, staleAfterBytes) === 0);
  assert('a miss leaves write metadata unchanged',
    staleBeforeStat.mtimeNs === staleAfterStat.mtimeNs && staleBeforeStat.ctimeNs === staleAfterStat.ctimeNs);

  header('fileEditor — miss recovery refuses weak matches and resolves ambiguity deterministically');

  const noMatch = await runReplace(agent, stalePath, 'completely unrelated expected text', 'replacement');
  assert('no useful match is explicit instead of dumping arbitrary content',
    noMatch.status === 'error'
      && noMatch.text.includes('No safe useful close textual match was found in the current file.')
      && !/^\s*\d+  /m.test(noMatch.text));

  const ambiguousPath = path.join(root, 'ambiguous.txt');
  const ambiguousLines = [
    'first section',
    'alpha beta gamma current-one delta epsilon zeta',
    'middle section',
    'alpha beta gamma current-two delta epsilon zeta',
    'last section',
  ];
  await writeFile(ambiguousPath, ambiguousLines.join('\n'));
  const ambiguousOld = 'alpha beta gamma stale-value delta epsilon zeta';
  const ambiguousFirst = await runReplace(agent, ambiguousPath, ambiguousOld, 'replacement');
  const ambiguousSecond = await runReplace(agent, ambiguousPath, ambiguousOld, 'replacement');
  assert('equally supported candidates produce identical advisory output', ambiguousFirst.text === ambiguousSecond.text);
  assert('ambiguity selects the earliest current textual location',
    ambiguousFirst.text.includes('current-one') && ambiguousFirst.text.includes('Closest current context (lines 1-4)'));

  header('fileEditor — recovery caps adversarial work and preserves Unicode boundaries');

  const unicodePath = path.join(root, 'unicode.txt');
  const longUnicodeLine = `${'🦕'.repeat(250)}CURRENTTAIL`;
  const unicodeLines = [
    '前置 context',
    'const message = "当前值🙂";',
    longUnicodeLine,
    '后置 context',
  ];
  await writeFile(unicodePath, unicodeLines.join('\n'));
  const unicodeMiss = await runReplace(
    agent,
    unicodePath,
    '前置 context\nconst message = "当前值🙃";',
    'replacement',
  );
  assert('Unicode near-match context remains intact',
    unicodeMiss.text.includes('const message = "当前值🙂";') && !unicodeMiss.text.includes('\ufffd'));
  const advisoryMarker = 'Advisory context only;';
  const markerIndex = unicodeMiss.text.lastIndexOf(advisoryMarker);
  const unicodeAdvisory = markerIndex === -1 ? '' : unicodeMiss.text.slice(markerIndex);
  const truncatedUnicodeRow = unicodeAdvisory.split('\n').filter((line) => line.includes('[line truncated]')).at(-1) ?? '';
  const truncatedUnicodeContent = truncatedUnicodeRow.slice(8).replace('… [line truncated]', '');
  const unicodeCapOk = Array.from(truncatedUnicodeContent).length === 240
    && truncatedUnicodeRow.includes('… [line truncated]')
    && !unicodeAdvisory.includes('CURRENTTAIL');
  assert('long Unicode lines are capped only at code-point boundaries and state truncation', unicodeCapOk);
  assert('the recovery result stays bounded', unicodeMiss.text.length < 3_000);

  const hugeOld = 'q'.repeat(200_000);
  const hugeStarted = performance.now();
  const hugeMiss = await runReplace(agent, stalePath, hugeOld, 'replacement');
  const hugeElapsed = performance.now() - hugeStarted;
  assert('oversized old_str is refused before advisory matching',
    hugeMiss.text.includes('old_str exceeds the advisory search cap of 8192 Unicode code points.'));
  assert('oversized old_str is truncated in the error projection',
    hugeMiss.text.includes('… [old_str truncated]') && hugeMiss.text.length < 1_000);
  assert('oversized old_str recovery is fast', hugeElapsed < 1_000);

  header('fileEditor — exact replacement and unrelated errors remain unchanged');

  const exactPath = path.join(root, 'exact.txt');
  await writeFile(exactPath, 'before\nexact old text\nafter');
  const writesBeforeExact = writes;
  const exactReplace = await runReplace(agent, exactPath, 'exact old text', 'exact new text');
  assert('an exact unique match still succeeds', exactReplace.status === 'success');
  assert('an exact unique match performs exactly one sandbox write', writes === writesBeforeExact + 1);
  assert('an exact unique match writes exactly the requested content',
    await readFile(exactPath, 'utf8') === 'before\nexact new text\nafter');
  const missingOld = await runReplace(agent, exactPath);
  assert('missing old_str keeps its existing validation error without advisory context',
    missingOld.status === 'error'
      && missingOld.text.includes('Parameter `old_str` is required')
      && !missingOld.text.includes('Advisory context'));
  const multiple = await runReplace(agent, exactPath, 'e', 'x');
  assert('multiple occurrences keep their existing error without advisory context',
    multiple.status === 'error'
      && multiple.text.includes('Multiple occurrences of old_str')
      && !multiple.text.includes('Advisory context'));


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
  const directoryReplace = await runReplace(agent, directoryPath, 'visible', 'changed');
  assert('str_replace directory errors stay unrelated to miss recovery',
    directoryReplace.status === 'error'
      && directoryReplace.text.includes('is a directory')
      && !directoryReplace.text.includes('Advisory context'));
  const missingReplace = await runReplace(agent, path.join(root, 'missing-replace.txt'), 'old', 'new');
  assert('str_replace missing-path errors stay unrelated to miss recovery',
    missingReplace.status === 'error'
      && missingReplace.text.includes('does not exist')
      && !missingReplace.text.includes('Advisory context'));
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
  const writesBeforeLargeReplace = writes;
  const largeReplace = await runReplace(agent, largePath, 'x', 'y');
  assert('str_replace size errors stay unrelated to miss recovery and perform no write',
    largeReplace.status === 'error'
      && largeReplace.text.includes('exceeds maximum allowed size')
      && !largeReplace.text.includes('Advisory context')
      && writes === writesBeforeLargeReplace);
} finally {
  await rm(root, { recursive: true, force: true });
}

report();
