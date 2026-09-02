/**
 * Unit checks for the skill loader and slash-command expansion.
 *
 * No model calls: everything here is filesystem and string handling, so it runs
 * in milliseconds and covers the error paths a live run would not reach.
 *
 * Run: pnpm tsx spike/verify-skills.ts
 */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

  const symlinkTarget = path.join(TMP_ROOT, 'symlink-target');
  await mkdir(symlinkTarget, { recursive: true });
  await writeFile(path.join(symlinkTarget, 'SKILL.md'), '---\nname: symlink-skill\ndescription: Root symlink works.\n---\nbody\n');
  await symlink(symlinkTarget, path.join(SKILLS_ROOT, 'symlink-skill'));

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
  assert('a root skill symlink resolving to a directory is discovered', names.includes('symlink-skill'));

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
  assert('each extension layer is deterministic and higher-priority layers remain ahead of lower ones', names.indexOf('BUILD_Helper') < names.indexOf('pdf-forms'));
}

async function missingDirectory(): Promise<void> {
  header('scanSkills — absent .darwin/skills/ directory');

  const { skills, problems } = await scanSkills('/tmp/darwin-skills-does-not-exist');

  assert('all required built-ins remain without a project directory', builtinsOf(skills).length === REQUIRED_BUILTIN_SKILLS.length && REQUIRED_BUILTIN_SKILLS.every((name) => builtinsOf(skills).some((skill) => skill.name === name)));
  assert('project absence is silent (global .agents problems remain attributable)', problems.every((problem) => !problem.directory.includes('/tmp/darwin-skills-does-not-exist/')));
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
  assert('developer launches one complete worker rather than a planning-only child', workflow.includes('Launch the complete child worker') && workflow.includes('Do not set `DARWIN_PLANNING_ONLY`') && workflow.includes('one turn owns the complete repository workflow'));
  assert('developer lets the child own configured skills and repository lifecycle', workflow.includes('load any relevant non-developer skills') && workflow.includes('create or maintain task/planning/research artifacts') && workflow.includes('update specs, and commit'));
  assert('developer makes model-call budgets explicit opt-in only', workflow.includes('Model-call budgets are opt-in') && workflow.includes('Do not add `--max-model-calls`') && workflow.includes('explicit user/Host ceiling'));
  assert('developer keeps the process force-on override while stating ordinary default safety',
    workflow.includes('Run the first worker with `--yolo --context-offload`') &&
    workflow.includes('offload is already default-on for ordinary runs') &&
    workflow.includes('force-enables it even if persistent config opted out'));
  assert('developer does not compact a fresh direct worker', workflow.includes('do not use `--compact-before` on a fresh child'));
  assert('developer compacts only broad corrections and keeps budgets opt-in', workflow.includes('prior worker turn left a broad implementation/check transcript') && workflow.includes('narrow correction') && workflow.includes('Add `--max-model-calls <n>` only'));
  assert('developer batches independent tools but serializes dependent writes', workflow.includes('batch mutually independent read-only work') && workflow.includes('Writes, commits, and commands whose inputs depend on an earlier result stay serial'));
  assert('developer enforces the focused-child/full-child/full-Host test pyramid', workflow.includes('smallest reproduction and focused suite') && workflow.includes('complete project gate once before commit') && workflow.includes('Host independently runs the complete acceptance gate once'));
  assert('developer separates task and conversation ids', workflow.includes('not the `bg-*` task id') && workflow.includes('^session: ([a-z0-9_-]+)$'));
  assert('developer reserves explicit same-session continuation for correction', workflow.includes('Continue the exact child session only for correction') && workflow.includes('`--session <captured-id> --yolo --context-offload') && workflow.includes('Never use `--continue` or `--resume`'));
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
  assert('research searches paged metadata before selective section reads', researchWorkflow.includes('metadata-only search across the routed pages') && researchWorkflow.includes('Read only the selected direction section') && researchWorkflow.includes('Do not read completed directions\' evidence or notes'));
  assert('research appends to stable pages and rolls over without a status mirror', researchWorkflow.includes('current priority-range page') && researchWorkflow.includes('next zero-padded `directions-NNN-NNN.md` page') && researchWorkflow.includes('never rebalance a closed page') && researchWorkflow.includes('do not create an index status summary'));
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
      researchWorkflow.includes('a gated record never halts the batch'),
  );
  assert(
    'the batch halts only for an enumerated reason',
    researchWorkflow.includes('## 7. Halt the batch only for a recorded reason') &&
      researchWorkflow.includes('a premise was falsified') &&
      researchWorkflow.includes('Difficulty alone is not a halt condition'),
  );
  assert('completion requires independent acceptance and blockers remain in progress', researchWorkflow.includes('Never mark `done` from the child\'s report alone') && researchWorkflow.includes('keep it `in-progress`') && researchWorkflow.includes('explicit product decision'));

  const reflectionExpanded = await expandSkillCommand(plugin, '/self-reflection review this session');
  assert('/self-reflection expands without project skills', reflectionExpanded?.message.includes('# Self-reflection') === true);
  const reflection = plugin.find('self-reflection');
  const reflectionWorkflow = reflection?.instructions ?? '';
  assert('official Skill parsed self-reflection', reflectionWorkflow.includes('# Self-reflection'));
  assert(
    'reflection locates the subject trajectory before launching the child',
    reflectionWorkflow.includes('scripts/locate-trajectory.mjs') &&
      reflectionWorkflow.includes('run the locator **before** starting the child') &&
      reflectionWorkflow.includes('last-user-input:') &&
      reflectionWorkflow.includes('closed-through-turn:') &&
      reflectionWorkflow.includes('closed-through-seq:'),
  );
  assert(
    'reflection delegates to a managed headless worker without recursion',
    reflectionWorkflow.includes('`start` mode') &&
      reflectionWorkflow.includes('--yolo --context-offload') &&
      reflectionWorkflow.includes('offload is already default-on') &&
      reflectionWorkflow.includes('force-enables it if persistent config opted out') &&
      reflectionWorkflow.includes('must not load the `developer`, `self-evolution-research`, or `self-reflection` skills'),
  );
  assert(
    'reflection treats the record as read-only and states what it read',
    reflectionWorkflow.includes('never rewrites, repairs, or appends to the record') &&
      reflectionWorkflow.includes('unknown spend metrics stay unknown, never 0'),
  );
  assert(
    'reflection hands off and enforces only the latest closed subject range',
    reflectionWorkflow.includes('read and grade only records with `seq <= <seq>`') &&
      reflectionWorkflow.includes('Replay may show the open tail') &&
      reflectionWorkflow.includes('no `turnEnded` also exits') &&
      reflectionWorkflow.includes('must never be graded as unfinished'),
  );
  assert(
    'reflection writes one templated document at the exact path',
    reflectionWorkflow.includes('docs/reflections/reflection_<UTC-date>_<session-id>.md') &&
      reflectionWorkflow.includes('references/reflection-template.md'),
  );
  assert(
    'reflection grades on the four-level rubric',
    ['**Perfect**', '**High**', '**Medium**', '**Low**'].every((grade) => reflectionWorkflow.includes(grade)),
  );
  assert(
    'reflection applies the self-evolution score formula and gate',
    reflectionWorkflow.includes('Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk') &&
      reflectionWorkflow.includes('MINIMUM_IMPLEMENTATION_SCORE = 6') &&
      reflectionWorkflow.includes('zero to five new,'),
  );
  assert(
    'accepted directions queue into the backlog append-only for self-evolution-research',
    reflectionWorkflow.includes('docs/research/backlog_index.md') &&
      reflectionWorkflow.includes('`SRF-NNN`') &&
      reflectionWorkflow.includes('appended sections only') &&
      reflectionWorkflow.includes('exactly one route') &&
      reflectionWorkflow.includes('This workflow never starts implementing them itself'),
  );

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


type BacklogRecord = {
  id: string;
  direction: string;
  status: string;
  priority: number;
  score: number;
  importance: number;
  architectureFit: number;
  evidenceConfidence: number;
  difficulty: number;
  risk: number;
  originTarget: string;
  evidence: string;
  notes: string;
  page: string;
};

type BacklogPage = {
  fileName: string;
  content: string;
};

const BACKLOG_ROUTE_LINE_PATTERN = /^- \[Priorities (\d{3})–(\d{3})\]\(\.\/backlog\/(directions-(\d{3})-(\d{3})\.md)\)(?:[ \t]+.*)?$/gm;
const BACKLOG_ROUTE_CANDIDATE_PATTERN = /^- \[[^\]]+\]\((\.\/backlog\/[^)]+)\)(?:[ \t]+.*)?$/gm;
const BACKLOG_SECTION_PATTERN = /^## ((?:SER|SRF)-\d{3}) — (.+)\n\n([\s\S]*?)(?=^## (?:SER|SRF)-\d{3} — |(?![\s\S]))/gm;
const BACKLOG_DIRECTION_HEADING_PATTERN = /^## (?:SER|SRF)-/gm;
const BACKLOG_INDEX_DIRECTION_PATTERN = /^## (?:SER|SRF)-/m;
const BACKLOG_METADATA = [
  ['status', 'Status', false],
  ['priority', 'Priority', true],
  ['score', 'Score', true],
  ['importance', 'Importance', true],
  ['architectureFit', 'Architecture fit', true],
  ['evidenceConfidence', 'Evidence confidence', true],
  ['difficulty', 'Difficulty', true],
  ['risk', 'Risk', true],
  ['originTarget', 'Origin report', false],
] as const;
const BACKLOG_STATUSES = new Set(['not-started', 'in-progress', 'done', 'abandoned']);

function parseBacklogRecord(id: string, direction: string, body: string, page: string): BacklogRecord {
  const values: Record<string, string | number> = {};
  for (const [key, label, numeric] of BACKLOG_METADATA) {
    const matches = [...body.matchAll(new RegExp(`^- ${label}: (.+)$`, 'gm'))];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      throw new Error(`${page} ${id}: expected exactly one ${label} field`);
    }
    const raw = matches[0][1];
    if (numeric) {
      if (!/^\d+$/.test(raw)) throw new Error(`${page} ${id}: ${label} must be an integer`);
      values[key] = Number(raw);
    } else {
      values[key] = raw;
    }
  }

  const evidenceMatch = body.match(/### Implementation \/ acceptance evidence\n\n([\s\S]*?)\n\n### Notes \/ blockers \/ abandonment reason\n\n([\s\S]+?)\s*$/);
  if (evidenceMatch?.[1] === undefined || evidenceMatch[2] === undefined) {
    throw new Error(`${page} ${id}: missing evidence or notes subsection`);
  }
  const statusRaw = String(values.status);
  const statusMatch = statusRaw.match(/^`([^`]+)`$/);
  const originMatch = String(values.originTarget).match(/^\[[^\]]+\]\(([^)]+)\)/);
  if (statusMatch?.[1] === undefined) throw new Error(`${page} ${id}: Status must be code-formatted`);
  if (originMatch?.[1] === undefined) throw new Error(`${page} ${id}: Origin report must start with a Markdown link`);

  return {
    id,
    direction,
    status: statusMatch[1],
    priority: Number(values.priority),
    score: Number(values.score),
    importance: Number(values.importance),
    architectureFit: Number(values.architectureFit),
    evidenceConfidence: Number(values.evidenceConfidence),
    difficulty: Number(values.difficulty),
    risk: Number(values.risk),
    originTarget: originMatch[1],
    evidence: evidenceMatch[1].trim(),
    notes: evidenceMatch[2].trim(),
    page,
  };
}

async function validateBacklog(
  index: string,
  pages: readonly BacklogPage[],
  root: string,
  allowedLegacyScoreMismatches: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  const errors: string[] = [];
  const routeCandidates = [...index.matchAll(BACKLOG_ROUTE_CANDIDATE_PATTERN)];
  const routes = [...index.matchAll(BACKLOG_ROUTE_LINE_PATTERN)].map((match) => ({
    labelStart: Number(match[1]),
    labelEnd: Number(match[2]),
    fileName: match[3]!,
    start: Number(match[4]),
    end: Number(match[5]),
  }));
  if (routeCandidates.length !== routes.length) errors.push('malformed backlog page route');
  if (BACKLOG_INDEX_DIRECTION_PATTERN.test(index)) errors.push('index contains a direction record');

  const pageNames = new Set<string>();
  for (const page of pages) {
    if (pageNames.has(page.fileName)) errors.push(`duplicate page input ${page.fileName}`);
    pageNames.add(page.fileName);
  }
  const routedNames = new Set<string>();
  let previousEnd = 0;
  for (const route of routes) {
    if (routedNames.has(route.fileName)) errors.push(`duplicate route ${route.fileName}`);
    routedNames.add(route.fileName);
    if (route.labelStart !== route.start || route.labelEnd !== route.end) errors.push(`route label does not match ${route.fileName}`);
    if (route.start <= previousEnd) errors.push(`overlapping or unordered range ${route.fileName}`);
    previousEnd = Math.max(previousEnd, route.end);
    if (!pageNames.has(route.fileName)) errors.push(`missing routed page ${route.fileName}`);
  }
  for (const page of pages) if (!routedNames.has(page.fileName)) errors.push(`unlisted page ${page.fileName}`);

  const records: BacklogRecord[] = [];
  for (const route of routes) {
    if (route.end - route.start !== 19 || (route.start - 1) % 20 !== 0) {
      errors.push(`invalid 20-priority range ${route.fileName}`);
    }
    const page = pages.find((candidate) => candidate.fileName === route.fileName);
    if (page === undefined) continue;
    const pageRecords: BacklogRecord[] = [];
    const directionHeadingCount = [...page.content.matchAll(BACKLOG_DIRECTION_HEADING_PATTERN)].length;
    for (const match of page.content.matchAll(BACKLOG_SECTION_PATTERN)) {
      try {
        pageRecords.push(parseBacklogRecord(match[1]!, match[2]!, match[3]!, page.fileName));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (pageRecords.length !== directionHeadingCount) {
      errors.push(`${page.fileName} contains ${directionHeadingCount - pageRecords.length} malformed direction heading(s)`);
    }
    if (pageRecords.length > 20) errors.push(`${page.fileName} exceeds 20 records`);
    for (const record of pageRecords) {
      if (record.priority < route.start || record.priority > route.end) {
        errors.push(`${record.id} priority ${record.priority} is outside ${route.start}-${route.end}`);
      }
      records.push(record);
    }
    const priorities = pageRecords.map((record) => record.priority);
    if (priorities.some((priority, index) => index > 0 && priority <= priorities[index - 1]!)) {
      errors.push(`${page.fileName} records are not ordered by Priority`);
    }
  }

  const ids = new Set<string>();
  const priorities = new Set<number>();
  for (const record of records) {
    if (ids.has(record.id)) errors.push(`duplicate ID ${record.id}`);
    ids.add(record.id);
    if (priorities.has(record.priority)) errors.push(`duplicate Priority ${record.priority}`);
    priorities.add(record.priority);
    if (!BACKLOG_STATUSES.has(record.status)) errors.push(`${record.id} invalid Status ${record.status}`);
    for (const [label, rating] of [
      ['Importance', record.importance],
      ['Architecture fit', record.architectureFit],
      ['Evidence confidence', record.evidenceConfidence],
      ['Difficulty', record.difficulty],
      ['Risk', record.risk],
    ] as const) {
      if (rating < 1 || rating > 5) errors.push(`${record.id} ${label} must be 1-5`);
    }
    const expectedScore = 2 * record.importance + record.architectureFit + record.evidenceConfidence - record.difficulty - record.risk;
    if (record.score !== expectedScore) {
      const expectedLegacySignature = allowedLegacyScoreMismatches.get(record.id);
      const actualSignature = `${record.score}:${record.importance}:${record.architectureFit}:${record.evidenceConfidence}:${record.difficulty}:${record.risk}`;
      if (actualSignature !== expectedLegacySignature) {
        errors.push(`${record.id} Score ${record.score} does not equal ${expectedScore}`);
      }
    }
    const origin = path.resolve(root, 'docs', 'research', 'backlog', record.originTarget);
    const relativeOrigin = path.relative(root, origin);
    if (relativeOrigin === '' || relativeOrigin.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOrigin)) {
      errors.push(`${record.id} Origin report escapes the repository`);
    } else {
      try {
        const [originStat, resolvedRoot, resolvedOrigin] = await Promise.all([
          lstat(origin),
          realpath(root),
          realpath(origin),
        ]);
        const relativeResolvedOrigin = path.relative(resolvedRoot, resolvedOrigin);
        if (originStat.isSymbolicLink() || !originStat.isFile() || relativeResolvedOrigin.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResolvedOrigin)) {
          errors.push(`${record.id} unsafe Origin report ${record.originTarget}`);
        }
      } catch {
        errors.push(`${record.id} broken Origin report ${record.originTarget}`);
      }
    }
  }
  return errors;
}

function fixtureRecord(overrides: Partial<BacklogRecord> = {}): string {
  const record: BacklogRecord = {
    id: 'SER-001', direction: 'Fixture direction', status: 'not-started', priority: 1,
    score: 6, importance: 3, architectureFit: 3, evidenceConfidence: 3, difficulty: 3,
    risk: 3, originTarget: '../research_2026-08-15.md', evidence: 'Evidence.', notes: 'Notes.',
    page: 'directions-001-020.md', ...overrides,
  };
  return `## ${record.id} — ${record.direction}\n\n- Status: \`${record.status}\`\n- Priority: ${record.priority}\n- Score: ${record.score}\n- Importance: ${record.importance}\n- Architecture fit: ${record.architectureFit}\n- Evidence confidence: ${record.evidenceConfidence}\n- Difficulty: ${record.difficulty}\n- Risk: ${record.risk}\n- Origin report: [\`research_2026-08-15.md\`](${record.originTarget})\n\n### Implementation / acceptance evidence\n\n${record.evidence}\n\n### Notes / blockers / abandonment reason\n\n${record.notes}\n`;
}


async function researchDocs(): Promise<void> {
  header('self-evolution research — persistent document contracts');

  const backlog = await readFile(path.join(REPO_ROOT, 'docs', 'research', 'backlog_index.md'), 'utf8');
  const backlogDir = path.join(REPO_ROOT, 'docs', 'research', 'backlog');
  const pageNames = (await readdir(backlogDir)).filter((name) => name.endsWith('.md')).sort();
  const pages = await Promise.all(pageNames.map(async (fileName) => ({ fileName, content: await readFile(path.join(backlogDir, fileName), 'utf8') })));
  const template = await readFile(path.join(REPO_ROOT, 'docs', 'research', 'research_template.md'), 'utf8');
  const routedPageNames = [...backlog.matchAll(BACKLOG_ROUTE_LINE_PATTERN)].map((match) => match[3]!);

  assert('backlog index is a thin router with no direction records', Buffer.byteLength(backlog) < 8_000 && !/^## (?:SER|SRF)-\d{3} — /m.test(backlog));
  assert('backlog routes every and only existing priority page', routedPageNames.join(',') === pageNames.join(','));
  assert(
    'backlog retains every initial migration page while allowing later rollover pages',
    ['directions-001-020.md', 'directions-021-040.md', 'directions-041-060.md'].every((name) => pageNames.includes(name)),
  );
  assert('backlog declares the exact status vocabulary', ['`not-started`', '`in-progress`', '`done`', '`abandoned`'].every((status) => backlog.includes(status)));
  assert('backlog prioritizes unfinished work before research', backlog.includes('Selection order is `in-progress` first, then `not-started`') && backlog.includes('do not perform fresh product research'));
  assert('backlog records ranking and acceptance fields', ['Importance', 'Architecture fit', 'Evidence confidence', 'Difficulty', 'Risk', 'Implementation / acceptance evidence'].every((heading) => backlog.includes(heading) || pages.some((page) => page.content.includes(heading))));
  assert('backlog documents the score formula', backlog.includes('Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk'));
  assert('backlog works a whole batch one direction at a time', backlog.includes('Exactly one direction is `in-progress` at a time') && backlog.includes('advancing after each accepted closure'));
  assert('backlog gates low-scoring directions out', backlog.includes('MINIMUM_IMPLEMENTATION_SCORE = 6') && backlog.includes('below score gate (Score = <n> < 6)'));
  assert('backlog forbids re-rating a direction across the gate', backlog.includes('never restated to move a direction across the gate'));
  // SER-023's persisted score predates this validator and intentionally remains lossless in
  // this migration. New/edited fixture records receive no exception.
  const productionBacklogErrors = await validateBacklog(backlog, pages, REPO_ROOT, new Map([['SER-023', '13:4:5:4:3:3']]));
  if (productionBacklogErrors.length > 0) console.log(`  backlog errors: ${JSON.stringify(productionBacklogErrors)}`);
  assert('all 77 production records pass paged-backlog validation', productionBacklogErrors.length === 0 && pages.reduce((count, page) => count + [...page.content.matchAll(BACKLOG_SECTION_PATTERN)].length, 0) === 77);

  const fixtureIndex = '- [Priorities 001–020](./backlog/directions-001-020.md)\n';
  const fixturePage = (content: string, fileName = 'directions-001-020.md'): BacklogPage => ({ fileName, content });
  const fixtureErrors = async (index: string, fixtures: readonly BacklogPage[]) => validateBacklog(index, fixtures, REPO_ROOT);
  assert('validator accepts a complete valid fixture', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord())])).length === 0);
  assert('validator rejects a missing routed page', (await fixtureErrors(fixtureIndex, [])).some((error) => error.includes('missing routed page')));
  assert('validator rejects an unlisted page', (await fixtureErrors('', [fixturePage(fixtureRecord())])).some((error) => error.includes('unlisted page')));
  assert('validator rejects malformed route names instead of ignoring them', (await fixtureErrors('- [Priorities 001–020](./backlog/directions-1-20.md)\n', [fixturePage(fixtureRecord())])).some((error) => error.includes('malformed backlog page route')));
  assert('validator rejects a route label that disagrees with its filename range', (await fixtureErrors('- [Priorities 002–021](./backlog/directions-001-020.md)\n', [fixturePage(fixtureRecord())])).some((error) => error.includes('route label does not match')));
  assert('validator rejects direction records duplicated into the index', (await fixtureErrors(`${fixtureIndex}${fixtureRecord()}`, [fixturePage(fixtureRecord())])).some((error) => error.includes('index contains a direction record')));
  assert('validator rejects overlapping routes', (await fixtureErrors(`${fixtureIndex}- [Priorities 011–030](./backlog/directions-011-030.md)\n`, [fixturePage(fixtureRecord()), fixturePage('', 'directions-011-030.md')])).some((error) => error.includes('overlapping or unordered range')));
  assert('validator rejects invalid statuses', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord({ status: 'finished' }))])).some((error) => error.includes('invalid Status')));
  assert('validator rejects duplicate IDs', (await fixtureErrors(fixtureIndex, [fixturePage(`${fixtureRecord()}\n${fixtureRecord({ priority: 2 })}`)])).some((error) => error.includes('duplicate ID')));
  assert('validator rejects duplicate priorities', (await fixtureErrors(fixtureIndex, [fixturePage(`${fixtureRecord()}\n${fixtureRecord({ id: 'SRF-001' })}`)])).some((error) => error.includes('duplicate Priority')));
  assert('validator rejects score arithmetic errors', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord({ score: 7 }))])).some((error) => error.includes('does not equal')));
  assert('validator rejects out-of-range ratings', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord({ importance: 6, score: 12 }))])).some((error) => error.includes('Importance must be 1-5')));
  assert('validator rejects misplaced records', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord({ priority: 21 }))])).some((error) => error.includes('outside 1-20')));
  assert('validator rejects over-capacity pages', (await fixtureErrors(fixtureIndex, [fixturePage(Array.from({ length: 21 }, (_, index) => fixtureRecord({ id: `SER-${String(index + 1).padStart(3, '0')}`, priority: index + 1 })).join('\n'))])).some((error) => error.includes('exceeds 20 records')));
  assert('validator rejects incomplete fields', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord().replace('- Risk: 3\n', ''))])).some((error) => error.includes('Risk field')));
  assert('validator continues after one malformed record and catches a later duplicate ID', (await fixtureErrors(fixtureIndex, [fixturePage(`${fixtureRecord().replace('- Risk: 3\n', '')}\n${fixtureRecord({ priority: 2 })}\n${fixtureRecord({ priority: 3 })}`)])).some((error) => error.includes('duplicate ID')));
  assert('validator rejects malformed direction headings instead of silently dropping them', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord().replace('## SER-001 —', '## SER-001 -'))])).some((error) => error.includes('malformed direction heading')));
  assert('validator rejects broken local origin links', (await fixtureErrors(fixtureIndex, [fixturePage(fixtureRecord({ originTarget: '../missing-report.md' }))])).some((error) => error.includes('broken Origin report')));
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
  header("this repo's own project skills");

  const { skills, problems } = await scanSkills(REPO_ROOT);
  console.log(`  skills   : ${JSON.stringify(skills.map((s) => s.name))}`);
  console.log(`  problems : ${JSON.stringify(problems)}`);

  assert('commit-message skill is discovered', skills.some((s) => s.name === 'commit-message'));
  const localProblems = problems.filter((problem) => problem.directory.startsWith(`${REPO_ROOT}${path.sep}`));
  assert('project skills have no duplicate-name problems after Trellis moved to .agents',
    localProblems.every((problem) => !problem.reason.includes('duplicate skill name')));
  assert(
    'commit-message remains under .darwin/skills/',
    skillDirectory(requireSkill(skills, 'commit-message')).includes(path.join('.darwin', SKILLS_DIRNAME)),
  );
  assert(
    'Trellis skills are discovered from .agents/skills/',
    skillDirectory(requireSkill(skills, 'trellis-check')).includes(path.join('.agents', SKILLS_DIRNAME)),
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
