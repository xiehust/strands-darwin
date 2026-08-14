/**
 * Unit checks for the skill loader and slash-command expansion.
 *
 * No model calls: everything here is filesystem and string handling, so it runs
 * in milliseconds and covers the error paths a live run would not reach.
 *
 * Run: pnpm tsx spike/verify-skills.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { darwinDir } from '../src/paths.js';
import {
  BUILTIN_SKILLS_DIR,
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
  assert('the built-in developer is merged into project skills', names.includes('developer'));
  assert('skills are sorted by name', names.join(',') === [...names].sort().join(','));
}

async function missingDirectory(): Promise<void> {
  header('scanSkills — absent .darwin/skills/ directory');

  const { skills, problems } = await scanSkills('/tmp/darwin-skills-does-not-exist');

  assert('the built-in developer remains without a project directory', skills.length === 1 && skills[0]?.name === 'developer');
  assert('no problems reported (project absence is normal, not an error)', problems.length === 0);
  assert('the built-in resolves beside the loader module', skills[0]?.directory === path.join(BUILTIN_SKILLS_DIR, 'developer'));

  const plugin = await SkillsPlugin.load('/tmp/darwin-skills-does-not-exist');
  const expanded = await expandSkillCommand(plugin, '/developer fix the defect');
  assert('/developer expands without any project skills', expanded?.message.includes('# Developer supervisor') === true);
  const developer = plugin.find('developer');
  const loaded = developer === undefined ? undefined : await loadSkill(developer);
  assert('load_skill can load the built-in developer', loaded?.content.includes('# Developer supervisor') === true);
  const workflow = loaded?.content ?? '';
  assert('developer frames requirement, acceptance, repository, and authorization', ['exact requirement', 'acceptance checks', 'absolute target repository root', 'authorized mutation'].every((term) => workflow.includes(term)));
  assert('developer requires managed launch and lifecycle/output monitoring', workflow.includes('`start` mode') && workflow.includes('bash status') && workflow.includes('bash output'));
  assert('developer forbids recursive delegation and target-root drift', workflow.includes('must not load the `developer` skill') && workflow.includes('Do not substitute the Host\'s source repository'));
  assert('developer marks planning turns for hook-enforced read-only behavior', workflow.includes('DARWIN_PLANNING_ONLY=1'));
  assert('developer separates task and conversation ids', workflow.includes('not the `bg-*` task id') && workflow.includes('^session: ([a-z0-9_-]+)$'));
  assert('developer requires explicit same-session continuation', workflow.includes('`--session <captured-id>`') && workflow.includes('Never use `--continue` or `--resume`'));
  assert('developer preserves product and permission authority', workflow.includes('ask the user') && workflow.includes('Headless children cannot receive interactive permission prompts'));
  assert('developer requires independent acceptance and no hidden Host patch', workflow.includes('independently inspect') && workflow.includes('Do not patch the implementation yourself'));

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
    legacyScan.skills.length === 1 && legacyScan.skills[0]?.name === 'developer',
  );
}

async function builtinCollision(): Promise<void> {
  header('scanSkills — built-in name reservation');
  const root = '/tmp/darwin-skills-collision';
  const directory = path.join(darwinDir(root), SKILLS_DIRNAME, 'shadow');
  await rm(root, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: DEVELOPER\ndescription: Shadow the built-in.\n---\n\nshadow\n',
  );

  const { skills, problems } = await scanSkills(root);
  assert('the built-in wins a case-insensitive collision', skills.filter((skill) => skill.name.toLowerCase() === 'developer').length === 1);
  assert('the colliding project skill is surfaced', problems.some((problem) => problem.directory === directory && problem.reason.includes('reserved by built-in skill developer')));
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

  assert('built-in-only discovery still registers load_skill', builtinOnlyPlugin.getTools().length === 1);
  assert('built-in-only discovery advertises developer', typeof builtinPrompt.systemPrompt === 'string' && builtinPrompt.systemPrompt.includes('<skill name="developer">'));
  assert('progressive disclosure omits the developer body', typeof builtinPrompt.systemPrompt === 'string' && !builtinPrompt.systemPrompt.includes('# Developer supervisor'));
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
  await realProjectSkill();
  report();
}

await main();
