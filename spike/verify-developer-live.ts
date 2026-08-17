/**
 * Opt-in live acceptance for the built-in `/developer` Host → headless child workflow.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, header, report } from './shared.js';
import { startTui, type TuiSession } from './tui-driver.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TURN_TIMEOUT = 12 * 60_000;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-developer-live-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  // The Host's managed shell resolves `darwin` exactly as an installed project would.
  await writeFile(
    path.join(root, 'node_modules', '.bin', 'darwin'),
    `#!/bin/sh\nexec ${JSON.stringify(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'))} ${JSON.stringify(path.join(REPO_ROOT, 'src', 'cli.ts'))} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(path.join(root, '.darwin', 'config.json'), JSON.stringify({
    provider: 'bedrock',
    model: process.env['SPIKE_MODEL_ID'] ?? 'us.anthropic.claude-sonnet-4-6',
    region: process.env['AWS_REGION'] ?? 'us-west-2',
    maxTokens: 8192,
    permissionMode: 'yolo',
    promptCache: false,
    thinkingEffort: 'low',
    hooks: {
      PreToolUse: [{
        matcher: 'fileEditor',
        hooks: [{
          type: 'command',
          command: "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);if(process.env.DARWIN_PLANNING_ONLY==='1'&&p.tool_input?.command!=='view'){console.error('planning turn forbids edits');process.exit(1)}})\"",
        }],
      }, {
        matcher: 'bash',
        hooks: [{
          type: 'command',
          command: "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);if(p.tool_input?.mode==='start')require('node:fs').appendFileSync('.darwin/developer-starts.jsonl',JSON.stringify(p.tool_input)+'\\n');if(process.env.DARWIN_PLANNING_ONLY==='1'&&p.tool_input?.mode!=='list'&&p.tool_input?.mode!=='status'&&p.tool_input?.mode!=='output'&&p.tool_input?.mode!=='restart'){console.error('planning turn forbids bash mutation');process.exit(1)}})\"",
        }],
      }],
    },
  }, null, 2));
  await writeFile(path.join(root, 'AGENTS.md'), [
    '# Developer workflow live fixture',
    '',
    '- This disposable repository explicitly authorizes `--yolo` for all work inside this root.',
    `- The absolute target repository root is ${root}. Stay inside it; do not cd elsewhere.`,
    '- The child executable is `./node_modules/.bin/darwin`; use it directly without inspecting darwin source or implementation.',
    '- The child is the direct implementation worker. Its prompts must forbid loading the developer skill, starting another darwin, or delegating again.',
    '- This fixture is a small task: use the small preset (planning soft/hard 10/20, implementation 40/80, correction 15/30).',
    '- For the first child turn, run `DARWIN_PLANNING_ONLY=1 ./node_modules/.bin/darwin -p <planning-prompt> --yolo --context-offload --max-model-calls 20`.',
    '- For implementation, run `./node_modules/.bin/darwin -p <follow-up> --session <captured-id> --yolo --context-offload --compact-before --max-model-calls 80`. Never omit these flags.',
    '- The only requested product change is the `sum.js` fix described by the user.',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'test.mjs'), [
    "import { sum } from './sum.js';",
    "if (sum(2, 3) !== 5) throw new Error('sum must add');",
    "console.log('PASS');",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'spike@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'darwin spike'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function isIdle(screen: string): boolean {
  return screen.lastIndexOf('you>') > screen.lastIndexOf('working…');
}

async function waitForIdle(tui: TuiSession, from: number): Promise<void> {
  await tui.waitFor('working…', { from, timeoutMs: 60_000 });
  await tui.waitUntil(isIdle, { from, timeoutMs: TURN_TIMEOUT, settleMs: 250 });
}

async function startedCommands(root: string): Promise<string[]> {
  const raw = await readFile(path.join(root, '.darwin', 'developer-starts.jsonl'), 'utf8');
  return raw.trim().split('\n').flatMap((line) => {
    const input = JSON.parse(line) as { command?: unknown };
    if (typeof input.command !== 'string') throw new Error(`background start has no command: ${line}`);
    // Hooks also reach child processes. Keep only the Host's direct invocations;
    // each has exactly one darwin executable while recursive starts have two.
    return input.command.match(/\.\/node_modules\/\.bin\/darwin/gu)?.length === 1 ? [input.command] : [];
  });
}

async function backgroundLogs(root: string): Promise<string[]> {
  const sessions = path.join(root, '.darwin', 'sessions');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.log')) files.push(target);
    }
  }
  await walk(sessions);
  return Promise.all(files.map((file) => readFile(file, 'utf8')));
}

async function main(): Promise<void> {
  header('developer live — Host supervises one persistent headless child');
  let root: string | undefined;
  let tui: TuiSession | undefined;
  try {
    const fixtureRoot = await fixture();
    root = fixtureRoot;
    tui = startTui({ cwd: fixtureRoot, cols: 150, rows: 60 });
    await tui.waitFor('you>', { timeoutMs: 60_000 });
    const turnStart = tui.mark();
    tui.submit(
      `/developer The absolute target repository is ${fixtureRoot}. Stay in that root and supervise a headless child to fix sum.js. ` +
      'Do not inspect darwin source: the verified child command is ./node_modules/.bin/darwin. ' +
      'The child must first return a planning-only reply without edits; review and approve it, then continue that exact ' +
      'session with --session, --yolo, context offload, phase compaction, and the developer budgets to implement. Use only bash start/status/output (never foreground execution or ' +
      'fixed sleeps) for child invocations. For every child task, call bash output at least once and, after terminal status, ' +
      'drain it through hasMore false before proceeding. Tell me /tasks is available. Independently inspect git diff and run node test.mjs.',
    );

    await tui.waitFor(/\.\/node_modules\/\.bin\/darwin -p/u, { from: turnStart, timeoutMs: 3 * 60_000 });
    // The command can appear while the start call is still streaming. Wait for its
    // result so `/tasks` cannot race the manager registration by a few milliseconds.
    await tui.waitFor(/"taskId":"bg-/u, { from: turnStart, timeoutMs: 60_000 });
    const tasksMark = tui.mark();
    tui.submit('/tasks');
    await tui.waitFor(/background tasks — this run \(\d+\)/u, { from: tasksMark, timeoutMs: 60_000 });
    await waitForIdle(tui, turnStart);

    const transcript = tui.screen.slice(turnStart);
    const commands = await startedCommands(fixtureRoot);
    const logFiles = await backgroundLogs(fixtureRoot);
    const planningCommand = commands.find((command) => command.includes('DARWIN_PLANNING_ONLY=1')) ?? '';
    const implementationCommand = commands.find((command) => /--session [a-z0-9_-]+/u.test(command)) ?? '';
    const selectedSession = /--session ([a-z0-9_-]+)/u.exec(implementationCommand)?.[1];
    const directLogs = selectedSession === undefined
      ? []
      : logFiles.filter((log) => log.startsWith(`session: ${selectedSession}\n`));
    const planningLog = directLogs.find(
      (log) => !/tool (?:fileEditor|bash) — (?:fileEditor (?:create|str_replace|insert):|bash:)[\s\S]*tool (?:fileEditor|bash) — ok/u.test(log),
    ) ?? '';

    assert('the built-in /developer workflow started a Host turn', /developer|supervis/iu.test(transcript));
    assert('/tasks observed a managed job during the Host turn', /background tasks — this run \(\d+\)[\s\S]*bg-/u.test(transcript));
    assert('the Host used managed planning and implementation starts', planningCommand !== '' && implementationCommand !== '' && logFiles.length >= 2);
    assert('the workflow did not recurse into a grandchild darwin', commands.every((command) => command.match(/\.\/node_modules\/\.bin\/darwin/gu)?.length === 1));
    assert('every child command stayed in the temporary target', commands.every((command) => command.includes(fixtureRoot) && !command.includes(REPO_ROOT)));
    assert('the Host monitored lifecycle status', transcript.includes('bash status:'));
    assert('the Host consumed incremental output', transcript.includes('bash output:'));
    assert('the first child emitted an exact session record', selectedSession !== undefined && directLogs.length >= 2);
    assert('the planning command is hook-enforced read-only', planningCommand.includes('DARWIN_PLANNING_ONLY=1') && /plan/iu.test(planningCommand));
    assert('the planning command carries its yolo/offload/budget controls', /(?:^|\s)--yolo(?:\s|$)/u.test(planningCommand) && planningCommand.includes('--context-offload') && planningCommand.includes('--max-model-calls 20') && /small preset/iu.test(transcript));
    assert('the implementation command explicitly selected the first session', selectedSession !== undefined);
    assert('the implementation command carries phase compaction, offload, and budget controls', /(?:^|\s)--yolo(?:\s|$)/u.test(implementationCommand) && implementationCommand.includes('--context-offload') && implementationCommand.includes('--compact-before') && implementationCommand.includes('--max-model-calls 80'));
    assert('the implementation command did not use pointer-based continuation', !/--continue|--resume/u.test(implementationCommand));
    assert('the same child session appeared in both direct child logs', directLogs.length >= 2);
    assert('the planning log contains no successful mutating tool call', planningLog !== '');
    assert('the implementation log is distinct from the planning log', directLogs.some((log) => log !== planningLog && /tool fileEditor — fileEditor (?:create|str_replace|insert):/u.test(log)));

    const source = await readFile(path.join(fixtureRoot, 'sum.js'), 'utf8');
    assert('the intended source now adds', /a\s*\+\s*b/u.test(source));
    const test = execFileSync('node', ['test.mjs'], { cwd: fixtureRoot, encoding: 'utf8' });
    assert('the repository test passes independently', test.includes('PASS'));
    const diff = execFileSync('git', ['diff', '--', 'sum.js'], { cwd: fixtureRoot, encoding: 'utf8' });
    assert('git diff contains the intended file change', diff.includes('sum.js') && diff.includes('a + b'));

    tui.submit('/exit');
    assert('the Host TUI exits within a deadline', await tui.exitedWithin(30_000) === 0);
  } finally {
    if (tui !== undefined) {
      // Ask the interactive CLI to take its ordinary explicit shutdown path, which
      // reaps managed process groups before exiting. Fall back to the pty signal only
      // after the same bounded grace period used by successful runs.
      tui.submit('/exit');
      try {
        await tui.exitedWithin(30_000);
      } catch {
        tui.kill();
        try {
          await tui.exitedWithin(5_000);
        } catch {
          // Preserve the owning assertion/timeout; this is the last-resort cleanup.
        }
      }
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
  report();
}

await main();
