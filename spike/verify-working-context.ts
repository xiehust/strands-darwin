/**
 * Working context: what the block says, how it is bounded, and where it lands in
 * the assembled system prompt.
 *
 * No model calls. The parts worth proving here are the ones a live run cannot
 * show: that the entry list is capped rather than however large the directory
 * happens to be, that an unreadable directory still yields a usable block, and
 * that a *resumed* prompt ends up with exactly one working context — the current
 * one — because the SDK restores the previous run's prompt from the snapshot.
 *
 * Run: pnpm tsx spike/verify-working-context.ts
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CachePointBlock, TextBlock } from '@strands-agents/sdk';

import {
  applySystemPromptCachePoint,
  planPromptCache,
  type SystemPromptHolder,
} from '../src/agent/prompt-cache.js';
import { composeSystemPrompt, loadProjectInstructions } from '../src/agent/instructions.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import {
  MAX_LISTED_ENTRIES,
  WORKING_CONTEXT_TAG,
  applyWorkingContext,
  buildWorkingContext,
  stripWorkingContext,
  withWorkingContext,
} from '../src/agent/working-context.js';
import { withSoleChoice, type AppConfig } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-working-context-test';
const FIXED_NOW = new Date('2026-08-16T23:59:30Z');

// buildWorkingContext reads only the directory it is given, but a config load in
// the composition section resolves under HOME.
ownPrivateHome('working-context');

const CLAUDE_CONFIG: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxTokens: 8192,
  summaryRatio: 0.3,
  contextWarnRatio: 0.8,
  contextOffload: true,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: 'high',
});

function lineStartingWith(fragment: string, prefix: string): string | undefined {
  return fragment.split('\n').find((line) => line.startsWith(prefix));
}

async function contents(): Promise<void> {
  header('working context — what the block states');

  const root = path.join(ROOT, 'project');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# x\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), '{}\n', 'utf8');
  await symlink(path.join(root, 'src'), path.join(root, 'link-to-src'));

  const built = await buildWorkingContext(root, FIXED_NOW);
  const { fragment } = built;

  assert('nothing is reported when the directory was read', built.problem === undefined);
  assert('the block is delimited and closed', fragment.startsWith(`<${WORKING_CONTEXT_TAG}>`) && fragment.endsWith(`</${WORKING_CONTEXT_TAG}>`));

  // The whole point of the block: these are the questions a fresh agent otherwise
  // burns a tool call on, or guesses at.
  assert('it names the working directory', lineStartingWith(fragment, '- working directory:') === `- working directory: ${root}`);
  assert('it names the platform', lineStartingWith(fragment, '- platform:')?.includes(process.platform) === true);
  assert('it names the node version', lineStartingWith(fragment, '- node:')?.includes(process.version) === true);

  // A model with a training cutoff will confidently state the wrong year, so the
  // date has to be exact — and only the day, so the prompt is stable across a run.
  const date = lineStartingWith(fragment, '- date:');
  assert('it states today\'s UTC date', date?.startsWith('- date: 2026-08-16 (UTC)') === true);
  assert('…without a clock time, which would change the cached prefix every run', date?.includes('23:59') !== true);

  const entryLines = fragment.split('\n').filter((line) => line.startsWith('    '));
  const listed = entryLines.join(' ').trim().split(/\s+/);
  assert('directories are marked and come first', listed[0] === '.darwin/' && listed[1] === 'src/');
  // Case-insensitive collation, so the list reads the way a person would write it
  // rather than putting every capitalised name first.
  assert('files follow them, sorted', listed.slice(2).join(',') === 'link-to-src@,package.json,README.md');
  assert('a symlink is flagged rather than called a file', listed.includes('link-to-src@'));
  assert('the counts are stated', lineStartingWith(fragment, '- contents')?.includes('(2 directories, 3 files)') === true);

  const empty = path.join(ROOT, 'empty');
  await mkdir(empty, { recursive: true });
  assert(
    'an empty directory says so instead of listing nothing',
    (await buildWorkingContext(empty, FIXED_NOW)).fragment.includes('- contents: empty'),
  );
}

async function bounded(): Promise<void> {
  header('working context — bounded, because it is re-sent every request');

  const root = path.join(ROOT, 'crowded');
  await mkdir(root, { recursive: true });
  const total = MAX_LISTED_ENTRIES + 25;
  await Promise.all(
    Array.from({ length: total }, (_, index) =>
      writeFile(path.join(root, `file-${String(index).padStart(4, '0')}.ts`), '', 'utf8'),
    ),
  );

  const { fragment } = await buildWorkingContext(root, FIXED_NOW);
  const listed = fragment
    .split('\n')
    .filter((line) => line.startsWith('    ') && !line.includes('not listed'))
    .join(' ')
    .trim()
    .split(/\s+/);

  assert('the listing is capped', listed.length === MAX_LISTED_ENTRIES);
  assert('the cap is not silent', fragment.includes(`(${total - MAX_LISTED_ENTRIES} more entries not listed)`));
  assert('the counts still describe the whole directory', fragment.includes(`${total} files`));
  // A repository root is a few hundred bytes; the cap is what keeps a directory of
  // thousands from quietly costing more than the conversation.
  assert('the whole block stays small', Buffer.byteLength(fragment) < 8 * 1024);
}

async function unreadable(): Promise<void> {
  header('working context — an unreadable directory degrades, never blocks');

  const missing = path.join(ROOT, 'does-not-exist');
  const built = await buildWorkingContext(missing, FIXED_NOW);

  assert('the failure is reported', built.problem !== undefined && built.problem.length > 0);
  assert('the block is still produced', built.fragment.startsWith(`<${WORKING_CONTEXT_TAG}>`));
  assert('the directory and date survive', built.fragment.includes(`- working directory: ${missing}`) && built.fragment.includes('- date: 2026-08-16'));
  assert('no contents line is invented', !built.fragment.includes('- contents'));
}

function resumed(): void {
  header('working context — one block, always the current one');

  const base = 'BASE PROMPT\n\n<project-instructions>rules</project-instructions>\n\n<available-skills>menu</available-skills>';
  const yesterday = `<${WORKING_CONTEXT_TAG}>\n- date: 2026-08-15 (UTC)\n</${WORKING_CONTEXT_TAG}>`;
  const today = `<${WORKING_CONTEXT_TAG}>\n- date: 2026-08-16 (UTC)\n</${WORKING_CONTEXT_TAG}>`;

  const fresh = withWorkingContext(base, today);
  assert('a fresh prompt gets the block appended last', fresh === `${base}\n\n${today}`);

  // The resume case. `initialize()` restores the snapshot's systemPrompt, so the
  // prompt in hand can already carry a previous run's context — with its date.
  const restored = withWorkingContext(`${base}\n\n${yesterday}`, today);
  assert('a restored block is replaced, not accumulated', restored === `${base}\n\n${today}`);
  assert('yesterday\'s date is gone', !restored.includes('2026-08-15'));
  assert('exactly one block remains', restored.split(`<${WORKING_CONTEXT_TAG}>`).length - 1 === 1);
  assert('the rest of the prompt is untouched', restored.startsWith(base));

  assert('applying twice is idempotent', withWorkingContext(restored, today) === restored);
  assert(
    'even a doubled block from some earlier run is cleaned up',
    withWorkingContext(`${base}\n\n${yesterday}\n\n${yesterday}`, today) === `${base}\n\n${today}`,
  );

  assert('stripping leaves the prompt as it was', stripWorkingContext(`${base}\n\n${today}`) === base);
  assert('stripping a prompt without a block changes nothing', stripWorkingContext(base) === base);
  assert('a prompt that is only context strips to nothing', stripWorkingContext(today) === '');
}

async function composition(): Promise<void> {
  header('working context — where it sits in the assembled prompt');

  const root = path.join(ROOT, 'ordered');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Project rule: commit small.\n', 'utf8');

  // The runtime's own order: base → AGENTS.md → skills (during initialize) →
  // working context (after it) → cache point.
  const loaded = await loadProjectInstructions(root);
  const composed = composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, loaded.instructions);
  const withSkills = new TextBlock('<available_skills>\n  <skill><name>x</name><description>y</description></skill>\n</available_skills>');
  const { fragment } = await buildWorkingContext(root, FIXED_NOW);

  const holder: SystemPromptHolder = { systemPrompt: [new TextBlock(composed), withSkills] };
  assert('the fragment converts the known prompt to explicit blocks', applyWorkingContext(holder, fragment));
  const assembled = Array.isArray(holder.systemPrompt)
    ? holder.systemPrompt.map((block) => block instanceof TextBlock ? block.text : '').join('\n')
    : '';

  const order = ['You are darwin', '<project-instructions', '<available_skills>', `<${WORKING_CONTEXT_TAG}>`].map((marker) =>
    assembled.indexOf(marker),
  );
  assert('every part is present', order.every((index) => index >= 0));
  assert(
    'the order is base → instructions → skills → working context',
    order.every((index, position) => position === 0 || index > (order[position - 1] ?? -1)),
  );
  assert('the project\'s own rules are still intact', assembled.includes('Project rule: commit small.'));

  // Applied before the cache point, so the block is inside the cached prefix
  // rather than after it, where it would cache nothing.
  const placed = applySystemPromptCachePoint(holder, planPromptCache(CLAUDE_CONFIG));
  const blocks = Array.isArray(holder.systemPrompt) ? holder.systemPrompt : [];
  assert('the cache point is added to explicit prompt blocks', placed && blocks.length === 4);
  assert('the working context stays immediately before the cache point', blocks[2] instanceof TextBlock && (blocks[2] as TextBlock).text.trimEnd().endsWith(`</${WORKING_CONTEXT_TAG}>`));
  assert('the cache point is last', blocks[3] instanceof CachePointBlock);

  // Order broken by something other than darwin: the text boundary is no longer
  // knowable, so refuse rather than guess.
  const strange: SystemPromptHolder = { systemPrompt: [new TextBlock('a'), new TextBlock('b')] };
  assert('an unrecognized block array is refused', !applyWorkingContext(strange, fragment));
}

/**
 * The resume path, end to end in memory: darwin's own cached prompt shape comes
 * back from the snapshot, and the block inside it has to be replaced — not left
 * asserting a date from whenever the session was created.
 */
function resumedPrompt(): void {
  header('working context — refreshed on a restored prompt');

  const stale = [
    'BASE',
    [
      '<available-skills>',
      'Skills are instruction sets for specific tasks. When a request matches one,',
      'call the load_skill tool with its name to read the full instructions before',
      'you begin. Only the name and description are shown here.',
      '  <skill name="old">menu</skill>',
      '</available-skills>',
    ].join('\n'),
    [
      `<${WORKING_CONTEXT_TAG}>`,
      'Where this session started. The directory listing and the date are a snapshot taken at',
      'startup, not live state: re-check anything that may have changed since, including your own',
      'edits. Paths are absolute unless stated otherwise.',
      '- date: 2026-08-01 (UTC)',
      `</${WORKING_CONTEXT_TAG}>`,
    ].join('\n'),
  ].join('\n\n');
  const today = `<${WORKING_CONTEXT_TAG}>\n- date: 2026-08-16 (UTC)\n</${WORKING_CONTEXT_TAG}>`;

  // Exactly what `initialize()` hands back for a resumed session: the two blocks
  // this project's own cache point produced, round-tripped through the snapshot.
  const restored: SystemPromptHolder = {
    systemPrompt: [new TextBlock(stale), new CachePointBlock({ cacheType: 'default' })],
  };
  assert('darwin\'s own cached shape is accepted', applyWorkingContext(restored, today));
  assert('it is migrated to explicit base/context/cache blocks and drops the stale catalogue', Array.isArray(restored.systemPrompt) && restored.systemPrompt.length === 3);
  const refreshed = Array.isArray(restored.systemPrompt)
    ? restored.systemPrompt.map((block) => block instanceof TextBlock ? block.text : '').join('\n')
    : '';
  assert('the stale date is gone', !refreshed.includes('2026-08-01'));
  assert('the current one is there, exactly once', refreshed.split(`<${WORKING_CONTEXT_TAG}>`).length - 1 === 1 && refreshed.includes('2026-08-16'));
  assert('the base survives while the stale pre-official catalogue is removed', refreshed.startsWith('BASE') && !refreshed.includes('<available-skills>'));

  assert('the cache point is placed again', applySystemPromptCachePoint(restored, planPromptCache(CLAUDE_CONFIG)));

  // Identical current facts preserve the same explicit text blocks.
  const before = JSON.stringify(restored.systemPrompt);
  applyWorkingContext(restored, today);
  applySystemPromptCachePoint(restored, planPromptCache(CLAUDE_CONFIG));
  assert('refreshing with identical facts changes nothing', JSON.stringify(restored.systemPrompt) === before);
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  try {
    await contents();
    await bounded();
    await unreadable();
    resumed();
    await composition();
    resumedPrompt();
  } finally {
    await rm(ROOT, { recursive: true, force: true });
  }
  report();
}

await main();
