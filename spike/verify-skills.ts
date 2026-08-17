/**
 * Unit checks for the skill loader and slash-command expansion.
 *
 * No model calls: everything here is filesystem and string handling, so it runs
 * in milliseconds and covers the error paths a live run would not reach.
 *
 * Run: pnpm tsx spike/verify-skills.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Agent } from '@strands-agents/sdk';
import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

import { darwinDir, userDarwinDir } from '../src/paths.js';
import {
  BUILTIN_SKILLS_DIR,
  REQUIRED_BUILTIN_SKILLS,
  SKILLS_DIRNAME,
  scanSkills,
} from '../src/skills/loader.js';
import { SkillsPlugin, expandSkillCommand } from '../src/skills/plugin.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, report } from './shared.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TMP_ROOT = '/tmp/darwin-skills-test';

/** Where the scanner looks: `<root>/.darwin/skills`. */
const SKILLS_ROOT = path.join(darwinDir(TMP_ROOT), SKILLS_DIRNAME);

/**
 * The developer's own globally installed skills — a legitimate third layer of every
 * scan, and never this suite's subject.
 *
 * `scanSkills` merges built-in, project, and global skills into one array, so a
 * count over that whole array quietly asserts "this machine has no global skill" —
 * a fact about somebody's `~/.darwin/skills/`, not about the loader. `pnpm test`
 * hides the difference by handing every fast suite a private HOME
 * (`spike/run-tests.ts`); running this file directly does not. The two helpers below
 * keep each assertion about the layer it actually names, so both ways of running
 * agree.
 */
const GLOBAL_SKILLS_ROOT = path.join(userDarwinDir(), SKILLS_DIRNAME);

function isUnder(directory: string, root: string): boolean {
  return directory.startsWith(`${root}${path.sep}`);
}

function skillDirectory(skill: Skill): string {
  if (skill.path === undefined) throw new Error(`skill ${skill.name} has no host path`);
  return skill.path;
}

function builtinsOf(skills: readonly Skill[]): Skill[] {
  return skills.filter((skill) => isUnder(skillDirectory(skill), BUILTIN_SKILLS_DIR));
}

/** Builds a throwaway skills tree covering the good and broken cases. */
async function buildFixture(): Promise<void> {
  await rm(TMP_ROOT, { recursive: true, force: true });

  const good = path.join(SKILLS_ROOT, 'pdf-forms');
  await mkdir(path.join(good, 'scripts'), { recursive: true });
  await mkdir(path.join(good, 'references'), { recursive: true });
  await writeFile(
    path.join(good, 'SKILL.md'),
    `---\nname: pdf-forms\ndescription: Fill in PDF form fields.\n---\n\n# PDF forms\n\nRun scripts/fill.py.\n`,
    'utf8',
  );
  await writeFile(path.join(good, 'scripts', 'fill.py'), '# fill\n', 'utf8');
  await writeFile(path.join(good, 'references', 'spec.md'), '# spec\n', 'utf8');

  // Name omitted: the directory name should be used instead.
  const implicit = path.join(SKILLS_ROOT, 'implicit-name');
  await mkdir(implicit, { recursive: true });
  await writeFile(
    path.join(implicit, 'SKILL.md'),
    `---\ndescription: Has no explicit name field.\n---\n\nbody\n`,
    'utf8',
  );

  // Description missing: must be reported as a problem, not silently dropped.
  const noDescription = path.join(SKILLS_ROOT, 'no-description');
  await mkdir(noDescription, { recursive: true });
  await writeFile(path.join(noDescription, 'SKILL.md'), `---\nname: broken\n---\n\nbody\n`, 'utf8');

  // Unparseable YAML.
  const badYaml = path.join(SKILLS_ROOT, 'bad-yaml');
  await mkdir(badYaml, { recursive: true });
  await writeFile(
    path.join(badYaml, 'SKILL.md'),
    `---\nname: "unterminated\ndescription: [oops\n---\n\nbody\n`,
    'utf8',
  );

  const compatible = path.join(SKILLS_ROOT, 'compatible-name');
  await mkdir(compatible, { recursive: true });
  await writeFile(
    path.join(compatible, 'SKILL.md'),
    `---\nname: BUILD_Helper\ndescription: Preserve Darwin's established name grammar.\n---\n\ncompatible body\n`,
    'utf8',
  );


  // A directory with no SKILL.md is not a skill and should be ignored quietly.
  await mkdir(path.join(SKILLS_ROOT, 'not-a-skill'), { recursive: true });
  await writeFile(path.join(SKILLS_ROOT, 'not-a-skill', 'README.md'), 'hi\n', 'utf8');
}

function requireSkill(skills: readonly Skill[], name: string): Skill {
  const found = skills.find((skill) => skill.name === name);
  if (found === undefined) throw new Error(`fixture is missing skill ${name}`);
  return found;
}

async function scanning(): Promise<void> {
  header('scanSkills — discovery and error tolerance');

  await buildFixture();
  const { skills, problems } = await scanSkills(TMP_ROOT);
  const names = skills.map((s) => s.name);
  const problemDirs = problems.map((p) => path.basename(p.directory)).sort();

  console.log(`  skills   : ${JSON.stringify(names)}`);
  console.log(`  problems : ${JSON.stringify(problemDirs)}`);
  for (const problem of problems) {
    console.log(`    ${path.basename(problem.directory)}: ${problem.reason}`);
  }

  assert('found the well-formed skill', names.includes('pdf-forms'));
  assert('fell back to the directory name when name was omitted', names.includes('implicit-name'));
  assert('skipped the skill missing a description', !names.includes('broken'));
  assert('reported the missing description as a problem', problemDirs.includes('no-description'));
  assert('reported the unparseable YAML as a problem', problemDirs.includes('bad-yaml'));
  assert('uppercase/underscore names remain accepted by Darwin product policy', names.includes('BUILD_Helper'));
  assert('compatible names still use official Skill body parsing', requireSkill(skills, 'BUILD_Helper').instructions === 'compatible body');

  assert('ignored a directory without SKILL.md silently', !problemDirs.includes('not-a-skill'));
  assert('one bad skill did not prevent loading the good ones', names.includes('pdf-forms'));
  assert('every required built-in is merged into project skills', REQUIRED_BUILTIN_SKILLS.every((name) => names.includes(name)));
  assert('required built-ins stay first in declared order', names.slice(0, REQUIRED_BUILTIN_SKILLS.length).join(',') === REQUIRED_BUILTIN_SKILLS.join(','));
  assert('project and global skills are sorted within their product-policy tail', names.slice(REQUIRED_BUILTIN_SKILLS.length).join(',') === [...names.slice(REQUIRED_BUILTIN_SKILLS.length)].sort().join(','));
}

async function missingDirectory(): Promise<void> {
  header('scanSkills — absent .darwin/skills/ directory');

  const { skills, problems } = await scanSkills('/tmp/darwin-skills-does-not-exist');

  assert('all required built-ins remain without a project directory', builtinsOf(skills).length === REQUIRED_BUILTIN_SKILLS.length && REQUIRED_BUILTIN_SKILLS.every((name) => builtinsOf(skills).some((skill) => skill.name === name)));
  assert('no problems reported (project absence is normal, not an error)', problems.filter((problem) => !isUnder(problem.directory, GLOBAL_SKILLS_ROOT)).length === 0);
  assert('the built-ins resolve beside the loader module', REQUIRED_BUILTIN_SKILLS.every((name) => skillDirectory(requireSkill(skills, name)) === path.join(BUILTIN_SKILLS_DIR, name)));

  const plugin = await SkillsPlugin.load('/tmp/darwin-skills-does-not-exist');
  const agent = new Agent({ plugins: [plugin], printer: false });
  await agent.initialize();
  const expanded = await expandSkillCommand(plugin, '/developer fix the defect');
  assert('/developer expands without any project skills', expanded?.message.includes('# Developer supervisor') === true);
  const developer = plugin.find('developer');
  const workflow = developer?.instructions ?? '';
  assert('official Skill parsed the built-in developer', workflow.includes('# Developer supervisor'));
  assert('developer frames requirement, acceptance, repository, and authorization', ['exact requirement', 'acceptance checks', 'absolute target repository root', 'authorized mutation'].every((term) => workflow.includes(term)));
  assert('developer requires managed launch and complete output consumption', workflow.includes('`start` mode') && workflow.includes('bash status') && workflow.includes('call `bash output` at least once') && workflow.includes('until `hasMore: false`'));
  assert('developer forbids recursive delegation and target-root drift', workflow.includes('must not load the `developer` skill') && workflow.includes('Do not substitute the Host\'s source repository'));
  assert('developer marks planning turns for hook-enforced read-only behavior', workflow.includes('DARWIN_PLANNING_ONLY=1'));
  assert('developer runs every headless child turn in yolo mode', workflow.includes('Run every child invocation with `--yolo`') && workflow.includes('`--session <captured-id> --yolo`'));
  assert('developer separates task and conversation ids', workflow.includes('not the `bg-*` task id') && workflow.includes('^session: ([a-z0-9_-]+)$'));
  assert('developer requires explicit same-session continuation', workflow.includes('`--session <captured-id> --yolo`') && workflow.includes('Never use `--continue` or `--resume`'));
  assert('developer preserves product and task-scope authority', workflow.includes('ask the user') && workflow.includes('yolo changes confirmation behavior, not task scope'));
  assert('developer requires independent acceptance and no hidden Host patch', workflow.includes('independently inspect') && workflow.includes('Do not patch the implementation yourself'));
  assert(
    'developer retries transient child server failures without looping',
    workflow.includes('turn failed: The server had an error while processing your request. Sorry about that!') &&
      workflow.includes('Retry at most two times') &&
      workflow.includes('same explicit `--session <captured-id>`'),
  );

  const researchExpanded = await expandSkillCommand(plugin, '/self-evolution-research choose the next iteration');
  assert('/self-evolution-research expands without project skills', researchExpanded?.message.includes('# Self-evolution research') === true);
  const research = plugin.find('self-evolution-research');
  const researchWorkflow = research?.instructions ?? '';
  assert('official Skill parsed self-evolution-research', researchWorkflow.includes('# Self-evolution research'));
  assert('research inspects the backlog before any product source', researchWorkflow.includes('Before using any product-research source, read `docs/research/backlog_index.md`'));
  assert(
    'the research path is rolled once, before any source is read',
    researchWorkflow.includes('scripts/roll-research-path.mjs') &&
      researchWorkflow.includes('Before reading a single source') &&
      researchWorkflow.includes('Once per research run, before any source'),
  );
  assert(
    'the five paths and their weights are stated',
    researchWorkflow.includes('`tui=2 observability=0.5 sdk=1 open=1.5 peer=5`') &&
      ['`tui`', '`observability`', '`sdk`', '`open`', '`peer`'].every((id) => researchWorkflow.includes(id)) &&
      researchWorkflow.includes('20% TUI, 15% open, 10% SDK, 5% observability, and 50% peer research'),
  );
  assert(
    'an unappealing roll cannot be re-rolled or self-overridden',
    researchWorkflow.includes('Never re-roll an unappealing outcome') &&
      researchWorkflow.includes('use the first') &&
      researchWorkflow.includes('A run does not override on its own initiative'),
  );
  assert(
    'the roll changes the evidence source, not the standard',
    researchWorkflow.includes('The path decides where evidence comes from, not the standard it meets') &&
      researchWorkflow.includes('the same score gate'),
  );
  assert(
    'a self-review path cites the repository and fabricates no peer coverage',
    researchWorkflow.includes('that repository evidence *is* the evidence') &&
      researchWorkflow.includes('never list a product the run did not open') &&
      researchWorkflow.includes('propose nothing'),
  );
  assert('the roll is bundled with the skill and advertised to the model', researchExpanded?.message.includes('scripts/roll-research-path.mjs') === true);
  assert('research prioritizes in-progress then not-started work and suppresses fresh research', researchWorkflow.indexOf('`in-progress` direction') < researchWorkflow.indexOf('`not-started` direction') && researchWorkflow.includes('do **not** perform fresh product research'));
  assert('research has the exact four-state vocabulary', ['`not-started`', '`in-progress`', '`done`', '`abandoned`'].every((status) => researchWorkflow.includes(status)));
  assert('fresh research covers named and additional products', ['Claude Code', 'Codex', 'DeepSeek harness', 'PenguinHarness', 'at least one additional relevant'].every((term) => researchWorkflow.includes(term)));
  assert('research refuses fabricated claims without source access', researchWorkflow.includes('source access is unavailable') && researchWorkflow.includes('never fabricate'));
  assert('peer evidence is compared with current Darwin architecture', researchWorkflow.includes('source, tests, README, `.trellis/spec/`') && researchWorkflow.includes('SDK-extension architecture'));
  assert('same-day runs append safely', researchWorkflow.includes('append a new `## Run — <UTC timestamp>` section') && researchWorkflow.includes('Never replace or rewrite an earlier same-day run'));
  assert('research proposes at most five directions', researchWorkflow.includes('zero to five new, non-duplicate iteration directions'));
  assert('ranking includes importance, difficulty, and supporting dimensions', ['**Importance**', '**Implementation difficulty**', '**Architecture fit**', '**Evidence confidence**', '**Implementation risk**'].every((term) => researchWorkflow.includes(term)));
  assert(
    'research delegates each batch direction through developer, one at a time',
    researchWorkflow.includes('`load_skill` with the exact name `developer`') &&
      researchWorkflow.includes('Exactly one direction is `in-progress` at a time') &&
      researchWorkflow.includes('continue immediately with the next direction'),
  );
  assert(
    'research keeps iterating the batch instead of stopping after one direction',
    researchWorkflow.includes('Finishing one direction successfully is not a reason to stop') &&
      researchWorkflow.includes('Do not wait for another instruction to keep going'),
  );
  assert(
    'each iteration is delegated to the newest accepted Darwin from a verified HEAD',
    researchWorkflow.includes('Never hand iteration N+1 to a stale artifact') &&
      researchWorkflow.includes('`pnpm typecheck` plus `pnpm test` must pass at HEAD'),
  );
  assert(
    'a low score is gated out rather than implemented',
    researchWorkflow.includes('MINIMUM_IMPLEMENTATION_SCORE = 6') &&
      researchWorkflow.includes('below score gate (Score = <n> < 6)') &&
      researchWorkflow.includes('a gated row never halts the batch'),
  );
  assert(
    'the batch halts only for an enumerated reason',
    researchWorkflow.includes('## 7. Halt the batch only for a recorded reason') &&
      researchWorkflow.includes('a premise was falsified') &&
      researchWorkflow.includes('Difficulty alone is not a halt condition'),
  );
  assert('completion requires independent acceptance and blockers remain in progress', researchWorkflow.includes('Never mark `done` from the child\'s report alone') && researchWorkflow.includes('keep it `in-progress`') && researchWorkflow.includes('explicit product decision'));

  // The pre-`.darwin` location is dead: a leftover root skills/ must not still be
  // advertised to the model, or a user who moved theirs would see duplicates.
  const legacyRoot = '/tmp/darwin-skills-legacy';
  const legacy = path.join(legacyRoot, SKILLS_DIRNAME, 'old-skill');
  await rm(legacyRoot, { recursive: true, force: true });
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'SKILL.md'), `---\ndescription: Legacy location.\n---\n\nbody\n`, 'utf8');

  const legacyScan = await scanSkills(legacyRoot);
  assert(
    'a root skills/ directory is no longer scanned',
    !legacyScan.skills.some((skill) => isUnder(skillDirectory(skill), legacyRoot)) &&
      builtinsOf(legacyScan.skills).length === REQUIRED_BUILTIN_SKILLS.length &&
      REQUIRED_BUILTIN_SKILLS.every((name) => legacyScan.skills.some((skill) => skill.name === name)),
  );
}

async function builtinCollision(): Promise<void> {
  header('scanSkills — built-in name reservation');
  const root = '/tmp/darwin-skills-collision';
  await rm(root, { recursive: true, force: true });

  for (const name of REQUIRED_BUILTIN_SKILLS) {
    const directory = path.join(darwinDir(root), SKILLS_DIRNAME, `shadow-${name}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name.toUpperCase()}\ndescription: Shadow the built-in.\n---\n\nshadow\n`,
    );
  }

  const { skills, problems } = await scanSkills(root);
  for (const name of REQUIRED_BUILTIN_SKILLS) {
    const directory = path.join(darwinDir(root), SKILLS_DIRNAME, `shadow-${name}`);
    assert(`the built-in ${name} wins a case-insensitive collision`, skills.filter((skill) => skill.name.toLowerCase() === name).length === 1);
    assert(`the colliding ${name} project skill is surfaced`, problems.some((problem) => problem.directory === directory && problem.reason.includes(`reserved by built-in skill ${name}`)));
  }
}

async function requiredBuiltinFailures(): Promise<void> {
  header('scanSkills — required built-ins are fatal');
  const root = '/tmp/darwin-skills-required';
  const builtins = path.join(root, 'builtins');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(builtins, 'developer'), { recursive: true });
  await writeFile(path.join(builtins, 'developer', 'SKILL.md'), '---\nname: developer\ndescription: required\n---\nbody\n');

  let missing = '';
  try {
    await scanSkills(path.join(root, 'project'), { builtinSkillsDir: builtins });
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  assert('a missing required built-in refuses discovery', missing.includes('self-evolution-research') && missing.includes(builtins));

  await mkdir(path.join(builtins, 'self-evolution-research'), { recursive: true });
  await writeFile(path.join(builtins, 'self-evolution-research', 'SKILL.md'), '---\nname: self-evolution-research\n---\nbody\n');
  let invalid = '';
  try {
    await scanSkills(path.join(root, 'project'), { builtinSkillsDir: builtins });
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  assert('an invalid required built-in names its packaged path and reason', invalid.includes(path.join(builtins, 'self-evolution-research')) && invalid.includes('description'));
}


async function officialSkillModel(): Promise<void> {
  header('official Skill — parsing and host paths');

  const { skills } = await scanSkills(TMP_ROOT);
  const pdfSkill = requireSkill(skills, 'pdf-forms');

  assert('official Skill carries the parsed description', pdfSkill.description === 'Fill in PDF form fields.');
  assert('official Skill carries only the instruction body', pdfSkill.instructions.includes('Run scripts/fill.py') && !pdfSkill.instructions.includes('description:'));
  assert('official Skill carries the host directory for resources', skillDirectory(pdfSkill).includes(TMP_ROOT));
}

async function slashCommands(): Promise<void> {
  header('expandSkillCommand — slash-command expansion');

  const plugin = await SkillsPlugin.load(TMP_ROOT);
  const agent = new Agent({ plugins: [plugin], printer: false });
  await agent.initialize();


  const exact = await expandSkillCommand(plugin, '/pdf-forms');
  const withArgs = await expandSkillCommand(plugin, '/pdf-forms fill in the tax form');
  const mixedCase = await expandSkillCommand(plugin, '/PDF-Forms');
  const unknown = await expandSkillCommand(plugin, '/nope');
  const exitCommand = await expandSkillCommand(plugin, '/exit');
  const plainProse = await expandSkillCommand(plugin, 'please fill in the pdf');
  const slashInMiddle = await expandSkillCommand(plugin, 'use /pdf-forms for this');

  assert('bare /skill-name expands', exact !== null);
  assert('expansion carries the full skill text', exact?.message.includes('Run scripts/fill.py') === true);
  assert('expansion names the resolved skill', exact?.skill.name === 'pdf-forms');
  assert('bare command adds a default request', exact?.message.includes('Apply the "pdf-forms" skill') === true);

  assert('trailing text is kept as the request', withArgs?.message.includes('fill in the tax form') === true);
  assert(
    'trailing text replaces the default request',
    withArgs?.message.includes('Apply the "pdf-forms" skill') === false,
  );

  assert('matching is case-insensitive', mixedCase?.skill.name === 'pdf-forms');
  assert('unknown skill returns null (caller treats it as ordinary input)', unknown === null);
  assert('/exit is left for the caller to handle', exitCommand === null);
  assert('plain prose returns null', plainProse === null);
  assert('a slash mid-sentence is not a command', slashInMiddle === null);
}

async function pluginShape(): Promise<void> {
  header('SkillsPlugin — one compatibility tool over official AgentSkills');

  const plugin = await SkillsPlugin.load(TMP_ROOT);
  const tools = plugin.getTools();
  const model = new CaptureModel();
  const agent = new Agent({ model, systemPrompt: 'BASE PROMPT', plugins: [plugin], printer: false });
  await agent.initialize();

  console.log(`  tools: ${JSON.stringify(agent.tools.map((tool) => tool.name))}`);

  assert('exposes exactly the load_skill tool', tools.length === 1 && agent.tools.map((tool) => tool.name).join(',') === 'load_skill');
  assert('does not expose the native skills tool', !agent.tools.some((tool) => tool.name === 'skills'));
  assert('tool description enumerates the skills', tools[0]?.description.includes('pdf-forms') === true);
  assert('official plugin waits until invocation to inject', agent.systemPrompt === 'BASE PROMPT');

  await agent.invoke('show catalogue');
  const injected = typeof agent.systemPrompt === 'string'
    ? agent.systemPrompt
    : agent.systemPrompt?.map((block) => block.type === 'textBlock' ? block.text : '').join('\n') ?? '';
  assert('plugin shape used the deterministic offline model exactly once', model.calls.length === 1);

  assert('official catalogue is injected before invocation', injected.includes('<available_skills>'));
  assert('official progressive disclosure omits bodies', !injected.includes('Run scripts/fill.py'));

  const builtinOnlyPlugin = await SkillsPlugin.load('/tmp/darwin-skills-does-not-exist');
  assert('built-in-only discovery still registers load_skill', builtinOnlyPlugin.getTools().length === 1);
}

async function researchPathRoll(): Promise<void> {
  header('self-evolution research — the weighted path roll');

  const scriptPath = path.join(BUILTIN_SKILLS_DIR, 'self-evolution-research', 'scripts', 'roll-research-path.mjs');
  // Imported, not re-implemented: the weights the skill documents and the weights
  // the script draws on have to be the same object, or the odds are prose.
  const rolled = (await import(pathToFileURL(scriptPath).href)) as {
    RESEARCH_PATHS: readonly { id: string; weight: number; focus: string }[];
    TOTAL_WEIGHT: number;
    TOTAL_DRAW_UNITS: number;
    pathForDraw: (draw: number) => { id: string };
    findResearchPath: (id: string) => { id: string } | undefined;
  };

  assert('the five paths are weighted 2:0.5:1:1.5:5', JSON.stringify(rolled.RESEARCH_PATHS.map((entry) => [entry.id, entry.weight])) === JSON.stringify([['tui', 2], ['observability', 0.5], ['sdk', 1], ['open', 1.5], ['peer', 5]]));
  assert('the weights total 10 and the draw runs over half-units, so every share is exact', rolled.TOTAL_WEIGHT === 10 && rolled.TOTAL_DRAW_UNITS === 20);

  // Exhaustive rather than statistical: twenty half-unit draws are the whole sample
  // space, so the mapping is checked outright instead of being sampled and hoped
  // about — including that a fractional weight became a proportional range and not a
  // rounded one.
  const mapped = Array.from({ length: rolled.TOTAL_DRAW_UNITS }, (_, draw) => rolled.pathForDraw(draw).id);
  const drawsPerPath = Object.fromEntries(rolled.RESEARCH_PATHS.map((entry) => [entry.id, mapped.filter((id) => id === entry.id).length]));
  assert('every draw maps to the documented path in weight order', JSON.stringify(mapped) === JSON.stringify([...Array<string>(4).fill('tui'), 'observability', ...Array<string>(2).fill('sdk'), ...Array<string>(3).fill('open'), ...Array<string>(10).fill('peer')]));
  assert('each path takes exactly its weighted share of the range', JSON.stringify(drawsPerPath) === JSON.stringify({ tui: 4, observability: 1, sdk: 2, open: 3, peer: 10 }));

  for (const draw of [-1, 20, 1.5, Number.NaN]) {
    let threw = false;
    try {
      rolled.pathForDraw(draw);
    } catch {
      threw = true;
    }
    // A clamp here would silently bias the first or last path — the one bug the
    // script exists to prevent.
    assert(`draw ${String(draw)} is refused rather than clamped`, threw);
  }
  assert('an unknown path id resolves to nothing', rolled.findResearchPath('nope') === undefined);

  const roll = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert(
    'a bare run records the drawn path with its draw',
    roll.status === 0 &&
      /^research-path: (?:tui|observability|sdk|open|peer)$/m.test(roll.stdout) &&
      /^draw: (?:[0-9]|1[0-9]) of 20 half-units$/m.test(roll.stdout) &&
      /^path-source: roll$/m.test(roll.stdout) &&
      roll.stdout.includes('weights: tui=2 observability=0.5 sdk=1 open=1.5 peer=5'),
  );

  const override = spawnSync(process.execPath, [scriptPath, '--path', 'tui'], { encoding: 'utf8' });
  assert(
    'a directed path can never be recorded as chance',
    override.status === 0 &&
      override.stdout.includes('research-path: tui') &&
      override.stdout.includes('path-source: override (user-directed)') &&
      !/^path-source: roll$/m.test(override.stdout) &&
      override.stdout.includes('draw: none'),
  );

  const unknown = spawnSync(process.execPath, [scriptPath, '--path', 'nope'], { encoding: 'utf8' });
  assert('an unknown path id exits 2 and rolls nothing', unknown.status === 2 && unknown.stdout === '' && unknown.stderr.includes('unknown path'));

  const badFlag = spawnSync(process.execPath, [scriptPath, '--seed', '5'], { encoding: 'utf8' });
  assert('an unexpected flag exits 2 rather than quietly rolling', badFlag.status === 2 && badFlag.stdout === '');

  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert('--help lists every path with its share', help.status === 0 && ['tui', 'observability', 'sdk', 'open', 'peer', '20%', '15%', '10%', '5%', '50%'].every((term) => help.stdout.includes(term)));
}

async function researchDocs(): Promise<void> {
  header('self-evolution research — persistent document contracts');

  const backlog = await readFile(path.join(REPO_ROOT, 'docs', 'research', 'backlog_index.md'), 'utf8');
  const template = await readFile(path.join(REPO_ROOT, 'docs', 'research', 'research_template.md'), 'utf8');

  assert('backlog declares the exact status vocabulary', ['`not-started`', '`in-progress`', '`done`', '`abandoned`'].every((status) => backlog.includes(status)));
  assert('backlog prioritizes unfinished work before research', backlog.includes('Selection order is `in-progress` first, then `not-started`') && backlog.includes('do not perform fresh product research'));
  assert('backlog records ranking and acceptance fields', ['Importance', 'Architecture fit', 'Evidence confidence', 'Difficulty', 'Risk', 'Implementation / acceptance evidence'].every((heading) => backlog.includes(heading)));
  assert('backlog documents the score formula', backlog.includes('Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk'));
  assert('backlog works a whole batch one direction at a time', backlog.includes('Exactly one row is `in-progress` at a time') && backlog.includes('advancing to the next direction after each one is accepted and closed'));
  assert('backlog gates low-scoring directions out', backlog.includes('MINIMUM_IMPLEMENTATION_SCORE = 6') && backlog.includes('below score gate (Score = <n> < 6)'));
  assert('backlog forbids re-rating a direction across the gate', backlog.includes('never restated to move a direction across the gate'));
  assert('research template targets dated append-only reports', template.includes('research_<YYYY-MM-DD>.md') && template.includes('append another timestamped `## Run` section') && template.includes('Never overwrite an earlier run'));
  assert(
    'research template records the rolled path verbatim, roll or override',
    template.includes('### Research path') &&
      template.includes('roll-research-path.mjs') &&
      template.includes('rolled once before any source was read') &&
      template.includes('path-source: <roll | override (user-directed)>'),
  );
  assert(
    'research template tells a self-review run to cite the repository instead of padding the peer table',
    template.includes('the evidence is this repository') && template.includes('no peer product was consulted'),
  );
  assert('research template covers all mandatory products and an additional product', ['Claude Code', 'Codex', 'DeepSeek harness', 'PenguinHarness', '`<additional product>`'].every((product) => template.includes(product)));
  assert('research template joins peer sources to Darwin evidence', template.includes('### Peer highlights and innovations') && template.includes('### Current Darwin baseline') && template.includes('### Comparison and gaps'));
  assert('research template caps and scores directions', template.includes('at most five new directions') && template.includes('Implementation difficulty') && template.includes('Implementation risk'));
  assert('research template records the gate decision for rejected directions', template.includes('### Gated-out directions') && template.includes('MINIMUM_IMPLEMENTATION_SCORE = 6'));
  assert('research template records per-direction acceptance and the halt reason', template.includes('### Batch iteration outcome') && template.includes('Child session and managed tasks') && template.includes('Host acceptance') && template.includes('Halt condition that ended the loop'));
}

async function realProjectSkill(): Promise<void> {
  header("this repo's own .darwin/skills/ directory");

  const { skills, problems } = await scanSkills(REPO_ROOT);
  console.log(`  skills   : ${JSON.stringify(skills.map((s) => s.name))}`);
  console.log(`  problems : ${JSON.stringify(problems)}`);

  assert('commit-message skill is discovered', skills.some((s) => s.name === 'commit-message'));
  // Same reason as `GLOBAL_SKILLS_ROOT` above: this check is about *this repo's*
  // skills, so a broken skill in the developer's own global directory must not be
  // reported here, where the message would point at the wrong tree.
  assert('no problems in the real skills directory', problems.filter((problem) => !isUnder(problem.directory, GLOBAL_SKILLS_ROOT)).length === 0);
  assert(
    'it is found under .darwin/skills/',
    skillDirectory(requireSkill(skills, 'commit-message')).includes(path.join('.darwin', SKILLS_DIRNAME)),
  );

  const plugin = await SkillsPlugin.load(REPO_ROOT);
  const agent = new Agent({ plugins: [plugin], printer: false });
  await agent.initialize();
  const expanded = await expandSkillCommand(plugin, '/commit-message test resources');
  assert('official activation lists its reference file', expanded?.message.includes('references/types.md') === true);
}

async function main(): Promise<void> {
  await scanning();
  await missingDirectory();
  await builtinCollision();
  await requiredBuiltinFailures();
  await officialSkillModel();
  await slashCommands();
  await pluginShape();
  await researchPathRoll();
  await researchDocs();
  await realProjectSkill();
  report();
}

await main();
