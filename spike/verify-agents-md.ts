/**
 * Unit checks for AGENTS.md preloading: what gets injected, what is skipped, how an
 * oversized file is cut down, and when the CLAUDE.md fallback is (and is not) read.
 *
 * No model calls — this is file reading and string assembly. The live proof that
 * the injected text actually steers the model is a scenario in
 * spike/verify-step-1-2.ts.
 *
 * Run: pnpm tsx spike/verify-agents-md.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Agent } from '@strands-agents/sdk';

import {
  AGENTS_FILENAME,
  CLAUDE_FILENAME,
  CLAUDE_IMPORT_NOTICE,
  MAX_INSTRUCTIONS_BYTES,
  composeSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructions,
} from '../src/agent/instructions.js';
import { SkillsPlugin } from '../src/skills/plugin.js';
import { formatInstructionsLoadedRow, formatInstructionsProblemRow } from '../src/tui/instructions-format.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-agents-md';

/** Creates a project directory containing exactly the given file. */
async function withFile(filename: string, contents: string): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), contents, 'utf8');
  return dir;
}

/** Creates a project directory containing exactly the given AGENTS.md. */
async function withAgentsMd(contents: string): Promise<string> {
  return withFile(AGENTS_FILENAME, contents);
}

/** The instructions alone, for the cases that are not about failure reporting. */
async function load(projectRoot: string): Promise<ProjectInstructions | undefined> {
  return (await loadProjectInstructions(projectRoot)).instructions;
}

async function loadedAndDelimited(): Promise<void> {
  header('AGENTS.md — loaded, labelled with its source');

  const dir = await withAgentsMd('# House rules\n\nAlways run the tests before claiming success.\n');
  const loaded = await load(dir);

  console.log(`  fragment:\n${loaded?.fragment}`);

  assert('the file was loaded', loaded !== undefined);
  assert('the filename is reported', loaded?.filename === AGENTS_FILENAME);
  assert('the path is reported', loaded?.path === path.join(dir, AGENTS_FILENAME));
  assert('the size is reported', (loaded?.bytes ?? 0) > 0);
  assert('it is not marked truncated', loaded?.truncated === false);
  assert('the body is carried through', loaded?.fragment.includes('Always run the tests') === true);
  assert(
    'the fragment names its source so the model can tell whose rules these are',
    loaded?.fragment.includes(`<project-instructions source="${AGENTS_FILENAME}">`) === true,
  );
  assert('the fragment is closed', loaded?.fragment.trimEnd().endsWith('</project-instructions>') === true);
  assert(
    'the AGENTS.md fragment carries no Claude Code import notice',
    loaded?.fragment.includes(CLAUDE_IMPORT_NOTICE) === false,
  );
}

/**
 * CLAUDE.md is the one fallback: read only when AGENTS.md does not exist at all.
 *
 * Precedence is proved with a CLAUDE.md that cannot be read (a directory in its
 * place): if the loader so much as opened it next to a good AGENTS.md, the load
 * would fail. The reverse — an unreadable AGENTS.md beside a good CLAUDE.md — must
 * stay a reported problem, never a quiet switch to the other file, because the
 * file the user wrote rules into is the one that has to decide.
 */
async function claudeFallback(): Promise<void> {
  header('CLAUDE.md — read only when AGENTS.md is absent, labelled as itself');

  // (a) Only CLAUDE.md: loaded, named, and warned about @path imports.
  const only = await withFile(CLAUDE_FILENAME, '# Claude rules\n\n@docs/style.md\n\nPrefer small commits.\n');
  const claude = await loadProjectInstructions(only);
  console.log(`  fragment:\n${claude.instructions?.fragment}`);
  assert('a lone CLAUDE.md is loaded', claude.instructions !== undefined && claude.problem === undefined);
  assert('its filename is CLAUDE.md', claude.instructions?.filename === CLAUDE_FILENAME);
  assert('its path ends with CLAUDE.md', claude.instructions?.path === path.join(only, CLAUDE_FILENAME));
  assert(
    'the fragment names CLAUDE.md as its source',
    claude.instructions?.fragment.includes(`<project-instructions source="${CLAUDE_FILENAME}">`) === true,
  );
  assert('the fragment says @path imports are not expanded', claude.instructions?.fragment.includes(CLAUDE_IMPORT_NOTICE) === true);
  assert('the notice sits inside the block, before the file text',
    (claude.instructions?.fragment.indexOf(CLAUDE_IMPORT_NOTICE) ?? -1) > (claude.instructions?.fragment.indexOf('<project-instructions') ?? -1)
      && (claude.instructions?.fragment.indexOf(CLAUDE_IMPORT_NOTICE) ?? -1) < (claude.instructions?.fragment.indexOf('# Claude rules') ?? -1));
  assert('an @path line stays literal text', claude.instructions?.fragment.includes('\n@docs/style.md\n') === true);
  assert('the body is carried through', claude.instructions?.fragment.includes('Prefer small commits') === true);

  // (b) Both present: AGENTS.md wins and CLAUDE.md is never opened — here it is a
  // directory, so opening it would have produced a problem.
  const both = await withAgentsMd('# Agents rules\n');
  await mkdir(path.join(both, CLAUDE_FILENAME), { recursive: true });
  const agents = await loadProjectInstructions(both);
  assert('with both present AGENTS.md is loaded', agents.instructions?.filename === AGENTS_FILENAME);
  assert('and reports no problem — the unreadable CLAUDE.md was never opened', agents.problem === undefined && agents.problemFile === undefined);
  assert('the fragment names AGENTS.md', agents.instructions?.fragment.includes(`source="${AGENTS_FILENAME}"`) === true);
  assert('no import notice in the AGENTS.md case', agents.instructions?.fragment.includes(CLAUDE_IMPORT_NOTICE) === false);
  assert('nothing of CLAUDE.md is merged in', agents.instructions?.fragment.includes(CLAUDE_FILENAME) === false);

  // The first file that *exists* decides, even when it has nothing to say: an
  // empty AGENTS.md is the user's (empty) choice, not an invitation to read on.
  const emptyAgents = await withAgentsMd('');
  await writeFile(path.join(emptyAgents, CLAUDE_FILENAME), '# Claude rules\n', 'utf8');
  const emptyWins = await loadProjectInstructions(emptyAgents);
  assert('an empty AGENTS.md beside a CLAUDE.md still preloads nothing',
    emptyWins.instructions === undefined && emptyWins.problem === undefined);

  // (c) Unreadable AGENTS.md beside a good CLAUDE.md: reported, no fallthrough.
  const broken = await withFile(CLAUDE_FILENAME, '# Claude rules\n');
  await mkdir(path.join(broken, AGENTS_FILENAME), { recursive: true });
  const stuck = await loadProjectInstructions(broken);
  console.log(`  problem : ${stuck.problem}`);
  assert('an unreadable AGENTS.md still yields nothing', stuck.instructions === undefined);
  assert('and is still reported as a problem', stuck.problem !== undefined && /EISDIR|illegal operation/i.test(stuck.problem));
  assert('the problem names AGENTS.md, not the fallback', stuck.problemFile === AGENTS_FILENAME);

  // An unreadable CLAUDE.md with no AGENTS.md is the same kind of failure, named.
  const brokenClaude = path.join(ROOT, 'unreadable-claude');
  await mkdir(path.join(brokenClaude, CLAUDE_FILENAME), { recursive: true });
  const claudeStuck = await loadProjectInstructions(brokenClaude);
  assert('an unreadable lone CLAUDE.md is reported against its own name',
    claudeStuck.instructions === undefined && claudeStuck.problem !== undefined && claudeStuck.problemFile === CLAUDE_FILENAME);

  // (d) Neither file.
  const neither = path.join(ROOT, 'neither');
  await mkdir(neither, { recursive: true });
  const none = await loadProjectInstructions(neither);
  assert('neither file yields nothing and no problem',
    none.instructions === undefined && none.problem === undefined && none.problemFile === undefined);

  // (e) Empty/whitespace and truncation rules apply to CLAUDE.md unchanged.
  const empty = await loadProjectInstructions(await withFile(CLAUDE_FILENAME, '\n  \n'));
  assert('a whitespace-only CLAUDE.md yields nothing and no problem', empty.instructions === undefined && empty.problem === undefined);
  const line = `${'y'.repeat(63)}\n`;
  const over = await load(await withFile(CLAUDE_FILENAME, line.repeat(Math.ceil((MAX_INSTRUCTIONS_BYTES * 2) / line.length))));
  assert('an oversized CLAUDE.md is flagged as truncated', over?.filename === CLAUDE_FILENAME && over?.truncated === true);
  assert('its fragment declares itself truncated under the CLAUDE.md source',
    over?.fragment.includes(`<project-instructions source="${CLAUDE_FILENAME}" truncated="true">`) === true
      && over.fragment.includes('was cut off here'));
  assert('the kept text stays within the cap',
    Buffer.byteLength(over?.fragment ?? '', 'utf8') < MAX_INSTRUCTIONS_BYTES + 400 + CLAUDE_IMPORT_NOTICE.length);

  // The header rows name the file that was loaded or failed — the same helper the
  // TUI header renders, checked here without a pty.
  const summary = { filename: claude.instructions!.filename, path: claude.instructions!.path, bytes: 1536, truncated: false };
  assert('the header row names CLAUDE.md when it was loaded',
    formatInstructionsLoadedRow(summary) === 'CLAUDE.md: loaded (1.5 KB)');
  assert('the truncated header row names the file and the cap',
    formatInstructionsLoadedRow({ ...summary, filename: AGENTS_FILENAME, bytes: 40_000, truncated: true })
      === `AGENTS.md: loaded (39.1 KB, truncated to ${MAX_INSTRUCTIONS_BYTES / 1024} KB)`);
  assert('the problem row names the file the problem is about',
    formatInstructionsProblemRow(CLAUDE_FILENAME, 'EISDIR: illegal operation on a directory, read')
      === 'CLAUDE.md: skipped — EISDIR: illegal operation on a directory, read');
}

async function skipped(): Promise<void> {
  header('AGENTS.md — absent, empty and whitespace-only files are skipped');

  const absent = await loadProjectInstructions(path.join(ROOT, 'no-such-project'));
  assert('a missing AGENTS.md yields nothing', absent.instructions === undefined);
  assert('a missing AGENTS.md is not reported as a problem', absent.problem === undefined);

  const empty = await loadProjectInstructions(await withAgentsMd(''));
  assert('an empty AGENTS.md yields nothing', empty.instructions === undefined);
  assert('an empty AGENTS.md is not reported as a problem', empty.problem === undefined);

  // Delimiters around nothing would just point the model at emptiness.
  const blank = await load(await withAgentsMd('\n\n   \n\t\n'));
  assert('a whitespace-only AGENTS.md yields nothing', blank === undefined);

  // Only the run directory is read: no walking up to a parent's AGENTS.md.
  const parent = await withAgentsMd('# Parent rules\n');
  const child = path.join(parent, 'nested');
  await mkdir(child, { recursive: true });
  assert("a parent directory's AGENTS.md is not picked up", (await load(child)) === undefined);
}

/**
 * A file that is there but unreadable is not the same as no file.
 *
 * Both end with the model getting no project rules, but only one of them is
 * something the user needs to hear about — silence there means they keep believing
 * rules are in effect. Uses a directory named AGENTS.md rather than a chmod, so the
 * case also holds when the suite runs as root.
 */
async function unreadable(): Promise<void> {
  header('AGENTS.md — a present but unreadable file is reported, not silently dropped');

  const dir = path.join(ROOT, 'unreadable');
  await mkdir(path.join(dir, AGENTS_FILENAME), { recursive: true });

  const result = await loadProjectInstructions(dir);
  console.log(`  problem : ${result.problem}`);

  assert('nothing is injected', result.instructions === undefined);
  assert('the failure is reported', result.problem !== undefined);
  assert('the report says what went wrong', /EISDIR|illegal operation/i.test(result.problem ?? ''));
  assert('the report names the file', result.problemFile === AGENTS_FILENAME);
}

async function truncation(): Promise<void> {
  header('AGENTS.md — an oversized file is truncated, not sent whole');

  // Just under, exactly at, and well over the cap. Line-sized chunks so the cut
  // has newlines to land on.
  const line = `${'x'.repeat(63)}\n`;
  const underDir = await withAgentsMd(line.repeat(Math.floor(MAX_INSTRUCTIONS_BYTES / line.length) - 1));
  const overDir = await withAgentsMd(line.repeat(Math.ceil((MAX_INSTRUCTIONS_BYTES * 2) / line.length)));

  const under = await load(underDir);
  const over = await load(overDir);

  console.log(`  under cap: ${under?.bytes} bytes, truncated=${under?.truncated}`);
  console.log(`  over cap : ${over?.bytes} bytes, truncated=${over?.truncated}`);

  assert('a file under the cap is not truncated', under?.truncated === false);
  assert('a file over the cap is flagged as truncated', over?.truncated === true);
  assert(
    'the reported size is the size on disk, not the kept size',
    (over?.bytes ?? 0) > MAX_INSTRUCTIONS_BYTES,
  );
  assert(
    'the kept text stays within the cap',
    Buffer.byteLength(over?.fragment ?? '', 'utf8') < MAX_INSTRUCTIONS_BYTES + 400,
  );
  // Truncation has to be visible to the model too: silently cutting instructions
  // in half reads to it as a complete but contradictory set of rules.
  assert('the fragment declares itself truncated', over?.fragment.includes('truncated="true"') === true);
  assert('the fragment says where it was cut', over?.fragment.includes('was cut off here') === true);

  // A byte-offset cut can land inside a multi-byte character; ending at the last
  // newline avoids handing the model a broken one.
  const multibyte = await load(await withAgentsMd(`${'。'.repeat(MAX_INSTRUCTIONS_BYTES)}\n`));
  assert('truncating multi-byte text produces no replacement character', multibyte?.fragment.includes('�') === false);
}

async function promptComposition(): Promise<void> {
  header('composeSystemPrompt — fixed order: base, instructions, then skills');

  const dir = await withAgentsMd('# House rules\n\nPrefer small commits.\n');
  const instructions = await load(dir);
  const composed = composeSystemPrompt('BASE PROMPT', instructions);

  assert('the base prompt is kept', composed.startsWith('BASE PROMPT'));
  assert('instructions follow it', composed.indexOf('Prefer small commits') > composed.indexOf('BASE PROMPT'));
  assert('no instructions leaves the prompt untouched', composeSystemPrompt('BASE PROMPT', undefined) === 'BASE PROMPT');

  // Official AgentSkills injects before the first invocation, not initialize.
  const skills = await SkillsPlugin.load(path.resolve(import.meta.dirname, '..'));
  const model = new CaptureModel();
  const agent = new Agent({ model, systemPrompt: composed, plugins: [skills], printer: false });
  await agent.initialize();
  assert('initialize preserves the composed string', agent.systemPrompt === composed);
  await agent.invoke('show catalogue');
  assert('prompt composition used the deterministic offline model exactly once', model.calls.length === 1);

  const full = typeof agent.systemPrompt === 'string'
    ? agent.systemPrompt
    : agent.systemPrompt?.map((block) => block.type === 'textBlock' ? block.text : '').join('\n') ?? '';

  console.log(`  order: base(${full.indexOf('BASE PROMPT')}) → instructions(${full.indexOf('<project-instructions')}) → skills(${full.indexOf('<available_skills>')})`);
  assert('project instructions survive the official skills injection', full.includes('<project-instructions'));
  assert(
    'the official skills catalogue follows project instructions',
    full.indexOf('<available_skills>') > full.indexOf('<project-instructions'),
  );
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await loadedAndDelimited();
  await claudeFallback();
  await skipped();
  await unreadable();
  await truncation();
  await promptComposition();
  report();
}

await main();
