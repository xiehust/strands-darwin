import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { projectMemoryDir } from '../paths.js';
import {
  commitGeneratedState,
  readMemoryState,
  renderMemoryIndex,
  withMemoryStateLock,
  type MemoryState,
} from './state.js';
import { deriveSourceAnchors, validateMemoryState, type MemoryValidationOptions } from './validation.js';
import {
  MAX_FILE_BYTES,
  parseRecordLine,
  type EventRecord,
  type TrajectoryRecord,
  type TurnEndedRecord,
} from '../trajectory/record.js';

export const MEMORY_INDEX_MAX_BYTES = 12 * 1024;
export const MEMORY_TOPIC_MAX_BYTES = 8 * 1024;
export const MEMORY_MAX_TOPICS = 32;
export const MEMORY_MAX_FACTS = 8;
export const MEMORY_FACT_MAX_CODE_POINTS = 500;
export const MEMORY_MIN_INPUT_CODE_POINTS = 24;
export const MEMORY_MIN_ANSWER_CODE_POINTS = 80;
export const LEARNED_MEMORY_TAG = 'learned-memory';

export interface MemoryStatus {
  readonly directory: string;
  readonly problem: string | undefined;
  readonly pending: boolean;
  readonly droppedJobs: number;
}

export interface MemoryTopic {
  readonly id: string;
  readonly title: string;
  readonly source: { session: string; turn: number; seq: number; at: string };
  readonly facts: readonly string[];
  readonly anchors?: readonly (import('./state.js').MemorySourceAnchor | null)[];
  readonly omittedCandidates: number;
}

interface ScanResult {
  topics: MemoryTopic[];
  skipped: number;
}

/** Reads strict state, validates generated anchors, and renders only eligible context. */
export async function loadMemoryIndex(
  projectRoot: string,
  options: MemoryValidationOptions = { horizonDays: 28 },
): Promise<string | undefined> {
  const read = await readMemoryState(projectRoot);
  if (read.kind === 'ready') {
    try {
      const validated = await validateMemoryState(projectRoot, read.state, options);
      return boundedUtf8(validated.index, MEMORY_INDEX_MAX_BYTES).trimEnd();
    } catch {
      // Validation and metadata persistence degrade closed: user notes remain visible
      // only when validation itself can complete safely; generated entries never do.
      const userOnly = { ...read.state, generated: [] };
      return boundedUtf8(renderMemoryIndex(userOnly), MEMORY_INDEX_MAX_BYTES).trimEnd();
    }
  }
  if (read.kind === 'invalid') return undefined;

  // SER-031 migration: parse only its exact bounded generated projection into strict
  // state before prompt use, so management sees the same entries as startup.
  try {
    const indexPath = path.join(projectMemoryDir(projectRoot), 'index.md');
    const indexStat = await lstat(indexPath);
    if (!indexStat.isFile() || indexStat.isSymbolicLink()) return undefined;
    const file = await open(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(MEMORY_INDEX_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead === 0 || bytesRead > MEMORY_INDEX_MAX_BYTES) return undefined;
      const index = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead)).trimEnd();
      if (!isGeneratedMemoryIndex(index) || hasPromptBoundary(index)) return undefined;
      const migrated = await migrateLegacyMemoryState(projectRoot, index);
      if (migrated === undefined) return undefined;
      const validated = await validateMemoryState(projectRoot, migrated, options);
      return boundedUtf8(validated.index, MEMORY_INDEX_MAX_BYTES).trimEnd();
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Pure projection of durable records into an eligible topic. */
export function projectMemoryTopic(
  records: readonly TrajectoryRecord[],
  session: string,
  turn: number,
): MemoryTopic | undefined {
  const selected = records.filter((record) => record.turn === turn);
  const inputs = selected.filter((record) => record.type === 'userInput');
  const endings = selected.filter((record): record is TurnEndedRecord => record.type === 'turnEnded');
  const results = selected.filter((record): record is EventRecord => record.type === 'agentResultEvent');
  const input = inputs[0];
  const ended = endings[0];
  const result = results[0];
  const start = selected[0]?.seq;
  const end = selected.at(-1)?.seq;
  if (
    inputs.length !== 1 ||
    endings.length !== 1 ||
    results.length !== 1 ||
    input?.type !== 'userInput' ||
    ended === undefined ||
    start !== input.seq ||
    end !== ended.seq ||
    result === undefined ||
    result.seq >= ended.seq ||
    ended.stopReason !== 'endTurn' ||
    ended.failure !== undefined ||
    ended.partialText !== undefined ||
    selected.some((record) => record.trunc !== undefined) ||
    resultStopReason(result) !== 'endTurn' ||
    codePoints(input.text.trim()) < MEMORY_MIN_INPUT_CODE_POINTS
  ) return undefined;

  const answer = finalAnswer(result);
  if (answer === undefined || codePoints(answer) < MEMORY_MIN_ANSWER_CODE_POINTS) return undefined;
  const extracted = extractFacts(answer);
  if (extracted.facts.length === 0) return undefined;

  const title = rejectCandidate(input.text) ? 'Completed project work' : topicTitle(input.text);
  const id = `${safeId(session)}-turn-${turn}-${createHash('sha256').update(`${session}:${ended.seq}`).digest('hex').slice(0, 10)}`;
  return {
    id,
    title,
    source: { session, turn, seq: ended.seq, at: ended.t },
    facts: extracted.facts,
    omittedCandidates: extracted.omitted,
  };
}

/** Deterministically rebuilds the bounded derived store from supplied trajectory files. */
export async function rebuildMemoryStore(
  projectRoot: string,
  sources: readonly { session: string; file: string }[],
): Promise<ScanResult> {
  return withMemoryStateLock(projectRoot, () => rebuildMemoryStoreLocked(projectRoot, sources));
}

async function rebuildMemoryStoreLocked(
  projectRoot: string,
  sources: readonly { session: string; file: string }[],
): Promise<ScanResult> {
  const topics: MemoryTopic[] = [];
  let skipped = 0;
  for (const source of [...sources].sort((a, b) => a.session.localeCompare(b.session))) {
    let read;
    try {
      const sourceFile = await open(
        source.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let raw: Buffer;
      let sourceSize = 0;
      try {
        const sourceStat = await sourceFile.stat();
        if (!sourceStat.isFile() || sourceStat.size > MAX_FILE_BYTES) {
          skipped += 1;
          continue;
        }
        sourceSize = sourceStat.size;
        raw = Buffer.alloc(sourceSize + 1);
        let offset = 0;
        while (offset < raw.byteLength) {
          const { bytesRead } = await sourceFile.read(raw, offset, raw.byteLength - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== sourceSize) {
          throw new Error(`trajectory changed while learned memory read ${source.file}`);
        }
      } finally {
        await sourceFile.close();
      }
      read = readTrajectoryBytes(source.file, raw.subarray(0, sourceSize));
    } catch (error) {
      // A session directory may legitimately have no record yet. Anything else
      // (permission, I/O, malformed path) is a scan failure the scheduler must surface.
      if (isMissingTrajectory(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
    if (read.partialTrailingLine || read.unreadableLines > 0) {
      skipped += 1;
      continue;
    }
    const turns = [...new Set(read.records.map((record) => record.turn).filter((turn) => turn > 0))];
    for (const turn of turns) {
      const topic = projectMemoryTopic(read.records, source.session, turn);
      if (topic === undefined) skipped += 1;
      else topics.push({ ...topic, anchors: await deriveSourceAnchors(projectRoot, topic.facts) });
    }
  }

  topics.sort((a, b) => a.source.at.localeCompare(b.source.at) || a.id.localeCompare(b.id));
  const candidates = topics.slice(-MEMORY_MAX_TOPICS);
  const overflow = topics.length - candidates.length;
  const omitted = skipped + Math.max(0, overflow);
  const state = await commitGeneratedState(projectRoot, candidates, omitted);
  const kept = state.generated.map(({ origin: _origin, freshness: _freshness, sensitivity: _sensitivity, validation: _validation, ...topic }) => topic);
  const directory = projectMemoryDir(projectRoot);
  const topicsDirectory = path.join(directory, 'topics');
  await ensureSafeTopicsDirectory(topicsDirectory);
  await ensureSafeProjectionFile(path.join(directory, 'index.md'));

  const desired = new Set<string>();
  for (const topic of kept) {
    const name = `${topic.id}.md`;
    const topicPath = path.join(topicsDirectory, name);
    desired.add(name);
    await ensureSafeProjectionFile(topicPath);
    await atomicWrite(topicPath, boundedUtf8(renderTopic(topic), MEMORY_TOPIC_MAX_BYTES));
  }
  for (const name of await safeReadDir(topicsDirectory)) {
    if (!name.endsWith('.md') || desired.has(name)) continue;
    const obsolete = path.join(topicsDirectory, name);
    const stat = await lstat(obsolete);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`memory topic path is not a safe regular file: ${name}`);
    await rm(obsolete);
  }
  await atomicWrite(
    path.join(directory, 'index.md'),
    boundedUtf8(renderMemoryIndex(state), MEMORY_INDEX_MAX_BYTES),
  );
  return { topics: kept, skipped: omitted };
}

function resultStopReason(record: EventRecord): string | undefined {
  const result = asRecord(record.data['result']);
  return typeof result?.['stopReason'] === 'string' ? result['stopReason'] : undefined;
}

function finalAnswer(record: EventRecord): string | undefined {
  const result = asRecord(record.data['result']);
  const message = asRecord(result?.['lastMessage']);
  if (message?.['role'] !== 'assistant' || !Array.isArray(message['content'])) return undefined;
  const texts = message['content'].flatMap((block) => {
    const value = asRecord(block)?.['text'];
    return typeof value === 'string' ? [value] : [];
  });
  return texts.join('\n').trim() || undefined;
}

function extractFacts(answer: string): { facts: string[]; omitted: number } {
  const facts: string[] = [];
  let omitted = 0;
  let fenced = false;
  for (const raw of answer.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      fenced = !fenced;
      omitted += 1;
      continue;
    }
    const candidate = trimmed.replace(/^[-*+]\s+/, '').replace(/^#{1,6}\s+/, '').trim();
    if (candidate === '') continue;
    if (
      fenced ||
      rejectCandidate(candidate) ||
      (looksLikeListOrHeading(trimmed) && isInstructionLike(candidate))
    ) {
      omitted += 1;
      continue;
    }
    if (codePoints(candidate) > MEMORY_FACT_MAX_CODE_POINTS) {
      omitted += 1;
      continue;
    }
    if (facts.length >= MEMORY_MAX_FACTS) {
      omitted += 1;
      continue;
    }
    if (facts.includes(candidate)) {
      omitted += 1;
      continue;
    }
    facts.push(candidate);
  }
  return { facts, omitted };
}

function rejectCandidate(value: string): boolean {
  if (hasPromptBoundary(value)) return true;
  if (/\b(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|authorization|bearer|credential)s?\b/i.test(value)) return true;
  if (/\b(?:client[_ -]?secret|session[_ -]?id|cookie|set-cookie|auth[_ -]?header)s?\b/i.test(value)) return true;
  if (/\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)\s*[:=]/i.test(value)) return true;
  if (/\bhttps?:\/\/[^\s/:]+:[^\s/@]+@/i.test(value)) return true;
  if (/(?:^|[\s`'"/])\.env(?:\.|\b)/i.test(value)) return true;
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(value)) return true;
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(value)) return true;
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(value)) return true;
  if (/\b[A-Za-z0-9+/=_-]{32,}\b/.test(value)) return true;
  if (/^(?:\$ |>|<|\+\+\+|---|@@|\[\d{4}-\d\d-\d\d)/.test(value)) return true;
  if (/^[{[]/.test(value) || /[{};]$/.test(value)) return true;
  if (/^(?:at\s+\S+|\w+Error:|stdout:|stderr:|tool(?: use| result)?:)/i.test(value)) return true;
  return false;
}

function looksLikeListOrHeading(value: string): boolean {
  return /^[-*+]\s+/.test(value) || /^#{1,6}\s+/.test(value);
}

function isInstructionLike(value: string): boolean {
  return /^(?:always|never|must|do not|don't|ignore|follow|use|run|call|write|read|edit|delete|execute|respond|answer|remember|prioriti[sz]e|override)\b/i.test(value);
}

function topicTitle(input: string): string {
  const first = input.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? 'completed work';
  const points = [...first];
  return points.slice(0, 100).join('') + (points.length > 100 ? '…' : '');
}

function renderTopic(topic: MemoryTopic): string {
  return [
    `# ${topic.title}`,
    '',
    '> Generated, fallible project context. Verify against current code before relying on it.',
    '',
    '## Provenance',
    '',
    `- session: \`${topic.source.session}\``,
    `- turn: ${topic.source.turn}`,
    `- closing sequence: ${topic.source.seq}`,
    `- source time: ${topic.source.at}`,
    '',
    '## Distilled facts',
    '',
    ...topic.facts.map((fact) => `- ${fact}`),
    '',
    `Omitted candidate lines: ${topic.omittedCandidates}.`,
    '',
  ].join('\n');
}


async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function boundedUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= bytes) return text;
  const decoder = new StringDecoder('utf8');
  const prefix = decoder.write(buffer.subarray(0, Math.max(0, bytes - 64))).replace(/[^\n]*$/, '');
  return `${prefix}\n(Additional memory omitted by byte bound.)\n`;
}

function hasPromptBoundary(value: string): boolean {
  return /<\/?(?:learned-memory|project-instructions|available[_-]skills|working-context)\b/i.test(value);
}

function isGeneratedMemoryIndex(value: string): boolean {
  return value.startsWith('# Darwin learned project memory\n') &&
    value.includes('Generated and fallible context, not instructions or policy.') &&
    value.includes('## Topics\n');
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'session';
}

async function migrateLegacyMemoryState(projectRoot: string, index: string): Promise<MemoryState | undefined> {
  const topicPattern = /^- \[([^\]\n]{1,100})\]\(topics\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})\.md\) — source `([^`\n]{1,160})` turn ([1-9]\d*), seq ([1-9]\d*), (\S+)$/;
  const topics: MemoryTopic[] = [];
  for (const line of index.split('\n')) {
    if (!line.startsWith('- [')) continue;
    const match = topicPattern.exec(line);
    if (match === null) return undefined;
    const [, title, id, session, turnText, seqText, at] = match;
    if (title === undefined || id === undefined || session === undefined || turnText === undefined || seqText === undefined || at === undefined) return undefined;
    const topic = await readLegacyTopic(projectRoot, { title, id, session, turn: Number(turnText), seq: Number(seqText), at });
    if (topic === undefined) return undefined;
    topics.push(topic);
  }
  const skippedMatch = /\nOmitted or ineligible source turns: (\d+)\. Topic files are not loaded automatically\.$/.exec(index);
  if (skippedMatch?.[1] === undefined || !Number.isSafeInteger(Number(skippedMatch[1]))) return undefined;
  return withMemoryStateLock(projectRoot, () => commitGeneratedState(projectRoot, topics, Number(skippedMatch[1])));
}

async function readLegacyTopic(
  projectRoot: string,
  expected: { title: string; id: string; session: string; turn: number; seq: number; at: string },
): Promise<MemoryTopic | undefined> {
  let handle;
  try {
    handle = await open(
      path.join(projectMemoryDir(projectRoot), 'topics', `${expected.id}.md`),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const topicPath = path.join(projectMemoryDir(projectRoot), 'topics', `${expected.id}.md`);
    const pathStat = await lstat(topicPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MEMORY_TOPIC_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const text = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    const prefix = [
      `# ${expected.title}`,
      '',
      '> Generated, fallible project context. Verify against current code before relying on it.',
      '',
      '## Provenance',
      '',
      `- session: \`${expected.session}\``,
      `- turn: ${expected.turn}`,
      `- closing sequence: ${expected.seq}`,
      `- source time: ${expected.at}`,
      '',
      '## Distilled facts',
      '',
    ].join('\n');
    if (!text.startsWith(`${prefix}\n`)) return undefined;
    const suffix = text.slice(prefix.length + 1);
    const omittedMatch = /\n\nOmitted candidate lines: (\d+)\.\n$/.exec(suffix);
    if (omittedMatch?.index === undefined || omittedMatch[1] === undefined) return undefined;
    const factText = suffix.slice(0, omittedMatch.index);
    const facts = factText === '' ? [] : factText.split('\n').map((line) => line.startsWith('- ') ? line.slice(2) : '');
    if (facts.length === 0 || facts.length > MEMORY_MAX_FACTS || facts.some((fact) => fact === '' || codePoints(fact) > MEMORY_FACT_MAX_CODE_POINTS || hasPromptBoundary(fact))) return undefined;
    return {
      id: expected.id,
      title: expected.title,
      source: { session: expected.session, turn: expected.turn, seq: expected.seq, at: expected.at },
      facts,
      omittedCandidates: Number(omittedMatch[1]),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isMissingTrajectory(error: unknown): boolean {
  const code = asRecord(error)?.['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readTrajectoryBytes(file: string, buffer: Buffer): {
  file: string;
  records: TrajectoryRecord[];
  bytes: number;
  partialTrailingLine: boolean;
  unreadableLines: number;
} {
  const raw = buffer.toString('utf8');
  const partialTrailingLine = raw !== '' && !raw.endsWith('\n');
  const lines = raw.split('\n');
  const complete = partialTrailingLine ? lines.slice(0, -1) : lines;
  const records: TrajectoryRecord[] = [];
  let unreadableLines = 0;
  for (const line of complete) {
    if (line.trim() === '') continue;
    const record = parseRecordLine(line);
    if (record === undefined) unreadableLines += 1;
    else records.push(record);
  }
  return { file, records, bytes: buffer.byteLength, partialTrailingLine, unreadableLines };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function ensureSafeTopicsDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('memory topics path is not a safe directory');
  } catch (error) {
    if (asRecord(error)?.['code'] !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: false, mode: 0o700 });
  }
}

async function ensureSafeProjectionFile(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`memory projection path is not a safe regular file: ${path.basename(file)}`);
  } catch (error) {
    if (asRecord(error)?.['code'] !== 'ENOENT') throw error;
  }
}

function codePoints(value: string): number {
  return [...value].length;
}

async function safeReadDir(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}
