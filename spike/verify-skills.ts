/**
 * Unit checks for the skill loader and slash-command expansion.
 *
 * No model calls: everything here is filesystem and string handling, so it runs
 * in milliseconds and covers the error paths a live run would not reach.
 *
 * Run: pnpm tsx spike/verify-skills.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { darwinDir } from '../src/paths.js';
import {
  BUILTIN_SKILLS_DIR,
  REQUIRED_BUILTIN_SKILLS,
  SKILLS_DIRNAME,
  formatSkillForModel,
  loadSkill,
  renderAvailableSkills,
  scanSkills,
  type Skill,
} from '../src/skills/loader.js';
import { SkillsPlugin, expandSkillCommand } from '../src/skills/plugin.js';
import { assert, header, report } from './shared.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TMP_ROOT = '/tmp/darwin-skills-test';

/** Where the scanner looks: `<root>/.darwin/skills`. */
const SKILLS_ROOT = path.join(darwinDir(TMP_ROOT), SKILLS_DIRNAME);

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
  assert('ignored a directory without SKILL.md silently', !problemDirs.includes('not-a-skill'));
  assert('one bad skill did not prevent loading the good ones', names.includes('pdf-forms'));
  assert('every required built-in is merged into project skills', REQUIRED_BUILTIN_SKILLS.every((name) => names.includes(name)));
  assert('skills are sorted by name', names.join(',') === [...names].sort().join(','));
}

async function missingDirectory(): Promise<void> {
  header('scanSkills — absent .darwin/skills/ directory');

  const { skills, problems } = await scanSkills('/tmp/darwin-skills-does-not-exist');

  assert('all required built-ins remain without a project directory', skills.length === REQUIRED_BUILTIN_SKILLS.length && REQUIRED_BUILTIN_SKILLS.every((name) => skills.some((skill) => skill.name === name)));
  assert('no problems reported (project absence is normal, not an error)', problems.length === 0);
  assert('the built-ins resolve beside the loader module', REQUIRED_BUILTIN_SKILLS.every((name) => requireSkill(skills, name).directory === path.join(BUILTIN_SKILLS_DIR, name)));

  const plugin = await SkillsPlugin.load('/tmp/darwin-skills-does-not-exist');
  const expanded = await expandSkillCommand(plugin, '/developer fix the defect');
  assert('/developer expands without any project skills', expanded?.message.includes('# Developer supervisor') === true);
  const developer = plugin.find('developer');
  const loaded = developer === undefined ? undefined : await loadSkill(developer);
  assert('load_skill can load the built-in developer', loaded?.content.includes('# Developer supervisor') === true);
  const workflow = loaded?.content ?? '';
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
  const researchLoaded = research === undefined ? undefined : await loadSkill(research);
  assert('load_skill can load self-evolution-research', researchLoaded?.content.includes('# Self-evolution research') === true);
  const researchWorkflow = researchLoaded?.content ?? '';
  assert('research inspects the backlog before any product source', researchWorkflow.includes('Before using any product-research source, read `docs/research/backlog_index.md`'));
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
    legacyScan.skills.length === REQUIRED_BUILTIN_SKILLS.length && REQUIRED_BUILTIN_SKILLS.every((name) => legacyScan.skills.some((skill) => skill.name === name)),
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

async function promptFragment(): Promise<void> {
  header('renderAvailableSkills / loadSkill — progressive disclosure');

  const { skills } = await scanSkills(TMP_ROOT);
  const fragment = renderAvailableSkills(skills);
  const pdfSkill = requireSkill(skills, 'pdf-forms');
  const loaded = await loadSkill(pdfSkill);

  console.log(`  fragment:\n${fragment}`);

  assert('fragment produced', fragment !== undefined);
  assert('lists the skill name', fragment?.includes('pdf-forms') === true);
  assert('lists the description', fragment?.includes('Fill in PDF form fields.') === true);
  assert('names the load_skill tool so the model knows how to fetch more', fragment?.includes('load_skill') === true);
  assert(
    'does NOT include the skill body (the point of progressive disclosure)',
    fragment?.includes('Run scripts/fill.py') === false,
  );
  assert('empty skill list yields no fragment', renderAvailableSkills([]) === undefined);

  console.log(`  resources: ${JSON.stringify(loaded.resources)}`);
  assert('loadSkill returns the full body', loaded.content.includes('Run scripts/fill.py'));
  assert('loadSkill lists scripts/', loaded.resources.includes(path.join('scripts', 'fill.py')));
  assert('loadSkill lists references/', loaded.resources.includes(path.join('references', 'spec.md')));

  const formatted = formatSkillForModel(loaded, pdfSkill);
  assert('formatted output mentions the resource files', formatted.includes('scripts/fill.py'));
  assert('formatted output carries the skill directory', formatted.includes(TMP_ROOT));
}

async function slashCommands(): Promise<void> {
  header('expandSkillCommand — slash-command expansion');

  const plugin = await SkillsPlugin.load(TMP_ROOT);

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
  header('SkillsPlugin — tool registration and prompt injection');

  const plugin = await SkillsPlugin.load(TMP_ROOT);
  const tools = plugin.getTools();

  console.log(`  tools: ${JSON.stringify(tools.map((t) => t.name))}`);

  assert('exposes exactly the load_skill tool', tools.length === 1 && tools[0]?.name === 'load_skill');
  assert('tool description enumerates the skills', tools[0]?.description.includes('pdf-forms') === true);

  // Minimal stand-in for LocalAgent: initAgent only touches systemPrompt.
  const fakeAgent = { systemPrompt: 'BASE PROMPT' } as Parameters<SkillsPlugin['initAgent']>[0];
  plugin.initAgent(fakeAgent);
  const injected = fakeAgent.systemPrompt;

  assert('base prompt is preserved', typeof injected === 'string' && injected.includes('BASE PROMPT'));
  assert('skills section is appended', typeof injected === 'string' && injected.includes('<available-skills>'));

  const builtinOnlyPlugin = await SkillsPlugin.load('/tmp/darwin-skills-does-not-exist');
  const builtinPrompt = { systemPrompt: 'BASE' } as Parameters<SkillsPlugin['initAgent']>[0];
  builtinOnlyPlugin.initAgent(builtinPrompt);

  const builtinText = typeof builtinPrompt.systemPrompt === 'string' ? builtinPrompt.systemPrompt : '';
  assert('built-in-only discovery still registers load_skill', builtinOnlyPlugin.getTools().length === 1);
  assert('built-in-only discovery advertises every required skill', REQUIRED_BUILTIN_SKILLS.every((name) => builtinText.includes(`<skill name="${name}">`)));
  assert('progressive disclosure omits built-in bodies', !builtinText.includes('# Developer supervisor') && !builtinText.includes('# Self-evolution research'));
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
  assert('no problems in the real skills directory', problems.length === 0);
  assert(
    'it is found under .darwin/skills/',
    requireSkill(skills, 'commit-message').directory.includes(path.join('.darwin', SKILLS_DIRNAME)),
  );

  const loaded = await loadSkill(requireSkill(skills, 'commit-message'));
  console.log(`  resources: ${JSON.stringify(loaded.resources)}`);
  assert('its reference file is listed', loaded.resources.includes(path.join('references', 'types.md')));
}

async function main(): Promise<void> {
  await scanning();
  await missingDirectory();
  await builtinCollision();
  await promptFragment();
  await slashCommands();
  await pluginShape();
  await researchDocs();
  await realProjectSkill();
  report();
}

await main();
