/**
 * Live check of the two skill trigger paths, through the real REPL.
 *
 * Runs in the repo root so this project's own `.darwin/skills/commit-message` is
 * the skill under test.
 *
 * (a) autonomous: asked for a commit message, the model should notice the skill
 *     advertised in its system prompt and call `load_skill` unprompted.
 * (b) manual: `/commit-message` should expand to the skill's full text before the
 *     turn starts.
 *
 * The conventions in that skill are deliberately specific (a `type(scope):`
 * subject) so its output is distinguishable from a generic commit message.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts
 */
import { REPO_ROOT, runRepl } from './repl-driver.js';
import { assert, header, report } from './shared.js';

/** Matches the skill's mandated `type(scope): subject` opening. */
const CONVENTIONAL_SUBJECT = /\b(feat|fix|docs|refactor|test|chore)\([a-z-]+\):/;

async function autonomousTrigger(): Promise<void> {
  header('skills (a) — model calls load_skill on its own');

  const run = await runRepl({
    cwd: REPO_ROOT,
    turns: [
      'Write only the one-line conventional-commit subject for a change that replaced the ' +
        'hand-built skills core with the official SDK plugin. Use the project commit-message ' +
        'skill, do not read or edit files, and do not run commands.',
      '/exit',
    ],
    permissionAnswer: 'n',
    timeoutMs: 240_000,
  });

  assert('REPL exited cleanly', run.exitCode === 0);
  assert('skills were advertised at startup', run.transcript.includes('commit-message') && run.transcript.includes('(use /<name> to load one)'));
  assert('load_skill was registered as a tool', run.transcript.includes('load_skill'));
  assert('model called load_skill without being told to', run.transcript.includes('calling load_skill'));
  assert('load_skill succeeded', run.transcript.includes('load_skill → ok'));
  assert(
    "output follows the skill's conventional-commit format",
    CONVENTIONAL_SUBJECT.test(run.transcript),
  );
}

async function slashCommandTrigger(): Promise<void> {
  header('skills (b) — /commit-message expands manually');

  const run = await runRepl({
    cwd: REPO_ROOT,
    turns: [
      '/commit-message Write a message for a change that removed the devEngines field ' +
        'from package.json because it broke npx-spawned MCP servers. ' +
        'Do not read files or run commands.',
      '/exit',
    ],
    permissionAnswer: 'n',
    timeoutMs: 240_000,
  });

  assert('REPL exited cleanly', run.exitCode === 0);
  assert('slash command was recognised and expanded', run.transcript.includes('loaded skill "commit-message"'));
  assert(
    'expansion did not need the load_skill tool (text was already inlined)',
    !run.transcript.includes('calling load_skill'),
  );
  assert(
    "output follows the skill's conventional-commit format",
    CONVENTIONAL_SUBJECT.test(run.transcript),
  );
}

async function main(): Promise<void> {
  const scenario = process.argv[2];
  if (scenario === undefined || scenario === 'autonomous') await autonomousTrigger();
  if (scenario === undefined || scenario === 'slash') await slashCommandTrigger();
  if (scenario !== undefined && scenario !== 'autonomous' && scenario !== 'slash') {
    throw new Error(`unknown skills-live scenario ${JSON.stringify(scenario)} (expected autonomous or slash)`);
  }
  report();
}

await main();
