/**
 * Prompt recall: what the reader offers back, and which keypress is allowed to take it.
 *
 * No terminal and no model. Two halves, matching the two modules: the bounded reader
 * over real files on disk (`src/trajectory/prompt-history.ts`), and the pure walk a
 * keystroke actually runs (`src/tui/prompt-recall.ts`).
 *
 * The properties with no single assertion are defended deliberately here:
 *
 * - **Reading changes nothing.** Every seeded record is hashed before and after, the
 *   resume pointer with them, and the reader is run with the AWS environment sabotaged
 *   so nothing it does can be reaching a provider.
 * - **No record is an answer, never an error.** A project that has never run, a session
 *   whose record was never created (`trajectory: false`), a half-written last line and a
 *   corrupt interior line each produce a *reading*.
 * - **Bounds are measured, not asserted about.** The tail bound is proven by seeding a
 *   record larger than it and checking which prompts came back.
 *
 * Run: pnpm tsx spike/verify-prompt-recall.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  Agent,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import { sessionPaths, trajectoryPath } from '../src/agent/session.js';
import { recordStream } from '../src/trajectory/stream.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import {
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRY_CHARS,
  MAX_HISTORY_SESSIONS,
  MAX_HISTORY_TAIL_BYTES,
  NO_PROMPT_HISTORY,
  promptHistoryNote,
  readPromptHistory,
} from '../src/trajectory/prompt-history.js';
import { openPromptRecall, promptRecallIndicator, stepPromptRecall } from '../src/tui/prompt-recall.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Owned HOME before any path is derived: the records this suite writes live under it,
// and `trajectoryPath` resolves `~` when it is called, not when it is imported.
const OWNED_HOME = ownPrivateHome('prompt-recall');
const ROOT = path.join(OWNED_HOME, 'project');
let seq = 0;

/** One `userInput` line exactly as the recorder writes it. */
function userInput(text: string, at: string): string {
  seq += 1;
  return `${JSON.stringify({ v: 1, seq, t: at, turn: 1, type: 'userInput', text })}\n`;
}

/** A non-prompt line, so the reader has to select rather than take everything. */
function otherRecord(type: string, at: string): string {
  seq += 1;
  return `${JSON.stringify({ v: 1, seq, t: at, turn: 1, type, data: { text: 'assistant text' } })}\n`;
}

async function seed(sessionId: string, lines: string): Promise<string> {
  const file = trajectoryPath(ROOT, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines, 'utf8');
  return file;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** A local model: this suite makes no request of any kind. */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.recall', contextWindowLimit: 200_000 };

  constructor(private readonly reply: string) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reply } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function resetProject(): Promise<void> {
  await rm(sessionPaths(ROOT).sessionsDir, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
}

header('prompt history — a project that has never run');

await resetProject();
{
  const reading = await readPromptHistory(ROOT);
  assert('no sessions at all is a reading, not an error',
    reading.entries.length === 0 && reading.problem === undefined);
  assert('and it says nothing it cannot say', promptHistoryNote(reading) === undefined);
  assert('which is exactly the reading a session starts from',
    JSON.stringify(reading) === JSON.stringify(NO_PROMPT_HISTORY));
}

{
  // A session directory with a snapshot but no record: the shape of every session of a
  // run with `trajectory: false`, and of one that exited before its first turn.
  await mkdir(path.join(sessionPaths(ROOT).sessionsDir, 'session-20260101-000001'), { recursive: true });
  const reading = await readPromptHistory(ROOT);
  assert('a session with no record degrades to no history', reading.entries.length === 0);
  assert('with no problem to report, because nothing failed', reading.problem === undefined);
}

header('prompt history — newest first, across sessions, duplicates collapsed');

await resetProject();
const older = await seed(
  'session-20260101-000001',
  userInput('first prompt of the old session', '2026-01-01T00:00:01.000Z') +
    otherRecord('contentBlockEvent', '2026-01-01T00:00:02.000Z') +
    userInput('second prompt of the old session', '2026-01-01T00:00:03.000Z'),
);
const newer = await seed(
  'session-20260102-000001',
  userInput('repeated prompt', '2026-01-02T00:00:01.000Z') +
    userInput('repeated prompt', '2026-01-02T00:00:02.000Z') +
    userInput('what did I ask last', '2026-01-02T00:00:03.000Z'),
);

{
  const reading = await readPromptHistory(ROOT);
  assert('the newest prompt of the newest session comes first',
    reading.entries[0] === 'what did I ask last');
  assert('consecutive duplicates collapse to one entry',
    reading.entries[1] === 'repeated prompt' && reading.entries[2] !== 'repeated prompt');
  assert('recall reaches the prompts of an earlier session of the same project',
    reading.entries[2] === 'second prompt of the old session' &&
      reading.entries[3] === 'first prompt of the old session');
  assert('exactly the four distinct prompts came back, in one order',
    reading.entries.length === 4 && reading.available === 4);
  assert('both records were read', reading.sessionsRead === 2 && reading.sessionsSkipped === 0);
  assert('non-prompt records are not offered as prompts',
    !reading.entries.some((entry) => entry.includes('assistant text')));
}

header('prompt history — reading is read-only, and reaches no provider');

{
  const before = [await sha256(older), await sha256(newer)];
  const pointer = sessionPaths(ROOT).pointerFile;
  let pointerBefore: string | undefined;
  try {
    pointerBefore = await sha256(pointer);
  } catch {
    pointerBefore = undefined;
  }

  const saved = { ...process.env };
  process.env['AWS_REGION'] = 'xx-nowhere-1';
  process.env['AWS_ENDPOINT_URL'] = 'http://127.0.0.1:1';
  process.env['AWS_ACCESS_KEY_ID'] = 'invalid';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'invalid';
  process.env['AWS_PROFILE'] = 'does-not-exist';
  let sabotaged;
  try {
    sabotaged = await readPromptHistory(ROOT);
  } finally {
    process.env = saved;
  }

  assert('the reading is correct with no usable credentials, region or endpoint',
    sabotaged.entries[0] === 'what did I ask last' && sabotaged.entries.length === 4);
  assert('every record is byte-identical after being read',
    (await sha256(older)) === before[0] && (await sha256(newer)) === before[1]);
  let pointerAfter: string | undefined;
  try {
    pointerAfter = await sha256(pointer);
  } catch {
    pointerAfter = undefined;
  }
  assert('and the resume pointer is untouched — absent stays absent', pointerAfter === pointerBefore);
}

{
  const source = await readFile(path.join('src', 'trajectory', 'prompt-history.ts'), 'utf8');
  assert('the reader constructs no agent and no model',
    !/\bnew Agent\b|\bnew BedrockModel\b|\bnew OpenAIModel\b|\bnew AnthropicModel\b/.test(source));
  assert('and opens nothing for writing',
    !/writeFile|appendFile|createWriteStream|'a'|'w'/.test(source) && source.includes("open(file, 'r')"));
}

header('prompt history — damage is tolerated, counted, never repaired');

await resetProject();
{
  const damaged = await seed(
    'session-20260103-000001',
    userInput('prompt before the damage', '2026-01-03T00:00:01.000Z') +
      '{ this line is not json\n' +
      userInput('prompt after the damage', '2026-01-03T00:00:02.000Z') +
      '{"v":1,"seq":99,"t":"2026-01-03T00:00:03.000Z","turn":1,"type":"userInput","text":"half-writ',
  );
  const before = await sha256(damaged);
  const reading = await readPromptHistory(ROOT);
  assert('an interrupted last write costs its own line and nothing else',
    reading.entries.length === 2 && !reading.entries.includes('half-writ'));
  assert('and an unparseable interior line is skipped, not raised',
    reading.entries[0] === 'prompt after the damage' && reading.problem === undefined);
  assert('the damaged record is never repaired', (await sha256(damaged)) === before);
}

header('prompt history — what is too long is skipped, and said');

await resetProject();
{
  // The shape of an older/directly recorded skill expansion: over-bound and
  // useless in an editor even though current drivers record literal user text.
  const expansion = `# Skill instructions\n${'x'.repeat(MAX_HISTORY_ENTRY_CHARS + 1)}`;
  await seed(
    'session-20260104-000001',
    userInput('a prompt worth recalling', '2026-01-04T00:00:01.000Z') + userInput(expansion, '2026-01-04T00:00:02.000Z'),
  );
  const reading = await readPromptHistory(ROOT);
  assert('an expanded skill body is not offered back',
    reading.entries.length === 1 && reading.entries[0] === 'a prompt worth recalling');
  assert('it is counted rather than silently dropped', reading.longSkipped === 1);
  assert('and the count is stated where the user can see it',
    promptHistoryNote(reading)?.includes('1 long prompt(s) skipped') === true);
  assert('the cap stays under the record field cap, so a truncated prompt is never offered',
    MAX_HISTORY_ENTRY_CHARS < 8_000);
}

header('prompt history — bounded in entries, in sessions, and in bytes');

await resetProject();
{
  const base = Date.parse('2026-01-05T00:00:00.000Z');
  let lines = '';
  for (let index = 1; index <= MAX_HISTORY_ENTRIES + 20; index += 1) {
    lines += userInput(`prompt ${index}`, new Date(base + index * 1000).toISOString());
  }
  await seed('session-20260105-000001', lines);
  const reading = await readPromptHistory(ROOT);
  assert('no more than the entry cap is kept', reading.entries.length === MAX_HISTORY_ENTRIES);
  assert('the newest entries are the ones kept',
    reading.entries[0] === `prompt ${MAX_HISTORY_ENTRIES + 20}` &&
      reading.entries[MAX_HISTORY_ENTRIES - 1] === `prompt ${21}`);
  assert('a record with more prompts than the cap says so rather than implying it is all',
    reading.entriesBounded);
  assert('with the cut stated on the indicator row, claiming no more than the reader knows',
    promptHistoryNote(reading)?.includes(`newest ${MAX_HISTORY_ENTRIES}, older records not read`) === true);
}

{
  // The other half of the entry cap: prompts spread over two records, so the collapse
  // that decides `available` runs across files and the note counts what it dropped.
  await resetProject();
  const base = Date.parse('2026-01-07T00:00:00.000Z');
  for (const [session, offset] of [['session-20260107-000001', 0], ['session-20260107-000002', 1000]] as const) {
    let lines = '';
    for (let index = 1; index <= MAX_HISTORY_ENTRIES - 20; index += 1) {
      lines += userInput(`${session} prompt ${index}`, new Date(base + offset + index * 10_000).toISOString());
    }
    await seed(session, lines);
  }
  const reading = await readPromptHistory(ROOT);
  assert('prompts from two records are kept up to the cap and no further',
    reading.entries.length === MAX_HISTORY_ENTRIES && reading.available === 2 * (MAX_HISTORY_ENTRIES - 20));
  assert('and the note counts what it kept against what it found',
    promptHistoryNote(reading)?.startsWith(`newest ${MAX_HISTORY_ENTRIES} of ${reading.available}`) === true);
}

await resetProject();
{
  // A record larger than the tail bound: the oldest prompt in it must not come back,
  // and the reading must say the file was read from its end only.
  const filler = otherRecord('contentBlockEvent', '2026-01-06T00:00:00.000Z');
  let lines = userInput('the oldest prompt, beyond the tail bound', '2026-01-06T00:00:01.000Z');
  while (Buffer.byteLength(lines, 'utf8') < MAX_HISTORY_TAIL_BYTES + 64 * 1024) lines += filler;
  lines += userInput('the newest prompt, inside the tail bound', '2026-01-06T00:00:02.000Z');
  const file = await seed('session-20260106-000001', lines);
  const before = await sha256(file);

  const started = performance.now();
  const reading = await readPromptHistory(ROOT);
  const ms = performance.now() - started;
  console.log(`  read one ${(Buffer.byteLength(lines, 'utf8') / 1024).toFixed(0)}KiB record in ${ms.toFixed(1)}ms`);

  assert('the tail holds the newest prompt', reading.entries[0] === 'the newest prompt, inside the tail bound');
  assert('the prompt beyond the tail bound is not offered',
    !reading.entries.includes('the oldest prompt, beyond the tail bound'));
  assert('and the reading says the record was read from its end only', reading.tailBounded === 1);
  assert('which is stated where the user can see it',
    promptHistoryNote(reading)?.includes('1 record(s) read from the end only') === true);
  assert('a bounded read still touches no byte', (await sha256(file)) === before);
  assert('and one bounded read is far too fast to be worth blocking a keystroke on', ms < 1000);
}

await resetProject();
{
  const total = MAX_HISTORY_SESSIONS + 5;
  for (let index = 1; index <= total; index += 1) {
    const stamp = String(index).padStart(2, '0');
    await seed(`session-202601${stamp}-000002`, userInput(`prompt from session ${index}`, `2026-01-${stamp}T00:00:01.000Z`));
  }
  // The number that actually matters for an Ink app: renders and keystrokes are
  // callbacks on the same loop the read runs on, so what is measured is the lag it
  // causes, not just how long it takes.
  const lags: number[] = [];
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 5);
    last = now;
  }, 5);
  const started = performance.now();
  const reading = await readPromptHistory(ROOT);
  const ms = performance.now() - started;
  clearInterval(ticker);
  console.log(
    `  read ${reading.sessionsRead} of ${total} records in ${ms.toFixed(1)}ms; worst event-loop lag ${Math.max(0, ...lags).toFixed(2)}ms`,
  );
  assert('a whole-project read stays far off the keystroke path', ms < 1000);
  assert('and never holds the loop that keystrokes and renders arrive on',
    Math.max(0, ...lags) < 50);
  assert('no more records are opened than the session bound allows',
    reading.sessionsRead === MAX_HISTORY_SESSIONS);
  assert('the ones it did not open are counted', reading.sessionsSkipped === total - MAX_HISTORY_SESSIONS);
  assert('and stated where the user can see it',
    promptHistoryNote(reading)?.includes(`${total - MAX_HISTORY_SESSIONS} session(s) not read`) === true);
  assert('the records it opened are the most recently written ones',
    reading.entries[0] === `prompt from session ${total}`);
}

header('prompt history — what the recorder actually writes is what recall offers');

{
  // The records above are hand-written, which is fast but proves nothing about the shape
  // the writer really produces. This turn is recorded by the real `TrajectoryRecorder`
  // over a real `Agent` with a local scripted model — no network, no provider — so the
  // reading is taken from bytes darwin itself wrote.
  await resetProject();
  const file = trajectoryPath(ROOT, 'session-20260108-000001');
  await mkdir(path.dirname(file), { recursive: true });
  const rec = new TrajectoryRecorder({
    file,
    run: {
      session: 'session-20260108-000001',
      agentId: 'darwin',
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'fake.recall',
      permissionMode: 'default',
      thinkingEffort: 'high',
      resumed: false,
      restoredMessages: 0,
    },
  });
  const agent = new Agent({ id: 'darwin', model: new ScriptedModel('answered'), systemPrompt: 'recall test', printer: false });
  await agent.initialize();
  for (const prompt of ['what the recorder wrote first', 'what the recorder wrote second']) {
    for await (const _event of recordStream(agent.stream(prompt), rec.beginTurn(prompt))) {
      // Drained exactly as `AgentRuntime.send`'s caller drains it.
    }
  }
  await rec.close();

  const reading = await readPromptHistory(ROOT);
  assert('recall reads back the prompts the recorder really wrote, newest first',
    reading.entries[0] === 'what the recorder wrote second' &&
      reading.entries[1] === 'what the recorder wrote first');
  assert('and takes nothing else off those turns',
    reading.entries.length === 2 && !reading.entries.some((entry) => entry.includes('answered')));
}

header('prompt recall — the walk');

const history = {
  ...NO_PROMPT_HISTORY,
  entries: ['newest', 'middle', 'oldest'],
  available: 3,
  sessionsRead: 1,
};

{
  const opened = openPromptRecall(history);
  assert('opening a walk lands on the newest prompt', opened.text === 'newest');
  assert('and the walk knows where it is', opened.recall?.index === 0);

  const older = stepPromptRecall(opened.recall!, 'older');
  assert('older steps back one entry', older.text === 'middle' && older.recall?.index === 1);
  const oldest = stepPromptRecall(older.recall!, 'older');
  assert('and again', oldest.text === 'oldest' && oldest.recall?.index === 2);
  const past = stepPromptRecall(oldest.recall!, 'older');
  assert('the oldest entry holds still rather than wrapping to the newest',
    past.text === undefined && past.recall?.index === 2);

  const newer = stepPromptRecall(oldest.recall!, 'newer');
  assert('newer steps forward one entry', newer.text === 'middle' && newer.recall?.index === 1);
  const back = stepPromptRecall(stepPromptRecall(newer.recall!, 'newer').recall!, 'newer');
  assert('past the newest, the walk ends on the empty draft it started from',
    back.recall === undefined && back.text === '');
}

{
  const empty = openPromptRecall(NO_PROMPT_HISTORY);
  assert('a project with no prompts opens a walk that changes no text', empty.text === undefined);
  assert('and says so in one row',
    promptRecallIndicator(empty.recall!) === 'history: no earlier prompts in this project');
  assert('older on an empty walk holds the row', stepPromptRecall(empty.recall!, 'older').recall !== undefined);
  assert('and newer dismisses it', stepPromptRecall(empty.recall!, 'newer').recall === undefined);

  const pending = openPromptRecall(undefined);
  assert('a walk opened before the read landed says that instead of claiming no history',
    pending.recall?.pending === true && promptRecallIndicator(pending.recall!).includes('reading'));
  assert('and it applies no text while it waits', pending.text === undefined);
}

header('prompt recall — the one row it draws');

{
  const walk = openPromptRecall(history).recall!;
  const indicator = promptRecallIndicator(walk);
  assert('the indicator states the position and both keys',
    indicator === 'history 1/3 · ↑ older ↓ newer');
  assert('it is one row, always', !indicator.includes('\n'));
  const last = stepPromptRecall(stepPromptRecall(walk, 'older').recall!, 'older').recall!;
  assert('the oldest entry says so, so a still Up is explained',
    promptRecallIndicator(last).includes('(oldest)'));

  const bounded = openPromptRecall({
    ...history,
    available: 137,
    sessionsSkipped: 3,
    longSkipped: 2,
  }).recall!;
  const noted = promptRecallIndicator(bounded);
  assert('a bounded reading is a suffix of that same row',
    noted.startsWith('history 1/3 · ↑ older ↓ newer — ') && !noted.includes('\n'));
  assert('and it names each bound that cut something',
    noted.includes('newest 3 of 137') && noted.includes('3 session(s) not read') &&
      noted.includes('2 long prompt(s) skipped'));
}

report();
