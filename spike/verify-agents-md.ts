/**
 * Unit checks for AGENTS.md preloading: what gets injected, what is skipped, and
 * how an oversized file is cut down.
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
  MAX_INSTRUCTIONS_BYTES,
  composeSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructions,
} from '../src/agent/instructions.js';
import { SkillsPlugin } from '../src/skills/plugin.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-agents-md';

/** Creates a project directory containing exactly the given AGENTS.md. */
async function withAgentsMd(contents: string): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, AGENTS_FILENAME), contents, 'utf8');
  return dir;
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
  assert('the path is reported', loaded?.path === path.join(dir, AGENTS_FILENAME));
  assert('the size is reported', (loaded?.bytes ?? 0) > 0);
  assert('it is not marked truncated', loaded?.truncated === false);
  assert('the body is carried through', loaded?.fragment.includes('Always run the tests') === true);
  assert(
    'the fragment names its source so the model can tell whose rules these are',
    loaded?.fragment.includes(`<project-instructions source="${AGENTS_FILENAME}">`) === true,
  );
  assert('the fragment is closed', loaded?.fragment.trimEnd().endsWith('</project-instructions>') === true);
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
  await skipped();
  await unreadable();
  await truncation();
  await promptComposition();
  report();
}

await main();
