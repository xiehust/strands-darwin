/**
 * `darwin doctor` — the offline, read-only diagnostics report.
 *
 * No terminal, no model, no MCP process: the report's whole logic lives in
 * `src/cli-doctor.ts`, driven here both in-process (the `DoctorIo` seam, against an
 * owned HOME whose config is rewritten between runs) and as the real verb (a child
 * `tsx src/cli.ts doctor` against a pristine HOME and a fixture project). The
 * properties with no single assertion are defended deliberately:
 *
 * - **A broken config is a report line, never a crash.** Unknown key and invalid JSON
 *   both produce one `! config:` line naming the file, and exit 1.
 * - **Nothing is spawned.** The MCP fixture's stdio command is a script that would
 *   write a marker file if it ever ran; the report says it was found on PATH and the
 *   marker never appears. A bogus command reads `not found`; an http server reads
 *   `not connected`.
 * - **Nothing is created.** HOME (with no `.darwin` at all) and the project are
 *   snapshotted recursively — path, kind, size, mtime — before and after the process
 *   run, and the two snapshots must be identical.
 * - **The module reaches no runtime, Ink or React module and constructs no Agent**,
 *   asserted over the transitive local import graph in the `verify-cli-args.ts` style.
 *
 * Run: pnpm tsx spike/verify-doctor-command.ts
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CliUsageError } from '../src/cli-args.js';
import {
  DOCTOR_COMMAND,
  DOCTOR_USAGE,
  isDoctorInvocation,
  lookupOnPath,
  MAX_DOCTOR_LINE_CHARS,
  parseDoctorArgs,
  PROBLEM_MARKER,
  runDoctorCommand,
} from '../src/cli-doctor.js';
import { CLI_HELP_HINT, CLI_USAGE } from '../src/cli-usage.js';
import { MAX_INSTRUCTIONS_BYTES } from '../src/agent/instructions.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Owned HOME before any path is derived: every in-process run below reads
// `~/.darwin/config.json` from here, never from the real home.
const HOME = ownPrivateHome('doctor-command');
const REPO = path.resolve(import.meta.dirname, '..');
const HINT_LINE = `${CLI_HELP_HINT}\n`;

/** A fresh fixture project directory outside HOME (so the two snapshots stay separate). */
function freshProject(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `darwin-doctor-${label}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function writeConfig(record: unknown): void {
  write(path.join(HOME, '.darwin', 'config.json'), typeof record === 'string' ? record : JSON.stringify(record, null, 2));
}

interface Run { code: number; out: string; err: string }

async function doctor(projectRoot: string): Promise<Run> {
  let out = '';
  let err = '';
  const code = await runDoctorCommand({ projectRoot, out: (text) => { out += text; }, err: (text) => { err += text; } });
  return { code, out, err };
}

function problemLines(out: string): string[] {
  return out.split('\n').filter((line) => line.trimStart().startsWith(PROBLEM_MARKER));
}

interface CliResult { status: number | null; stdout: string; stderr: string }

// Resolved from this repo, not from the child's cwd: the fixture project has no node_modules.
const TSX_LOADER = import.meta.resolve('tsx');

function cli(argv: readonly string[], options: { home: string; cwd: string; env?: NodeJS.ProcessEnv }): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, path.join(REPO, 'src/cli.ts'), ...argv],
    { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...options.env, HOME: options.home } },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every entry under `root`, recursively: relative path, kind, size and mtime. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = statSync(full, { throwIfNoEntry: true });
      entries[path.relative(root, full)] = `${entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file'} ${stat.size} ${stat.mtimeMs}`;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return entries;
}

function usageError(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof CliUsageError ? error.message : undefined;
  }
}

async function main(): Promise<void> {
  header('doctor — argument surface and grammar');
  {
    assert('darwin doctor routes as a subcommand', isDoctorInvocation([DOCTOR_COMMAND]));
    assert('an agent run does not route as doctor', !isDoctorInvocation(['--resume']) && !isDoctorInvocation([]));
    assert('doctor takes no arguments', usageError(() => parseDoctorArgs([])) === undefined);
    const message = usageError(() => parseDoctorArgs(['--fix']));
    assert('a stray argument is a usage error carrying the doctor usage',
      message?.startsWith('doctor takes no arguments.') === true && message.includes(DOCTOR_USAGE));
    assert('CLI_USAGE names the verb on its own line', CLI_USAGE.includes('\n       darwin doctor\n'));
    for (const doc of ['docs/user-guide/reference.md', 'docs/user-guide/reference.zh-CN.md']) {
      const text = readFileSync(path.join(REPO, doc), 'utf8');
      assert(`${doc} quotes the grammar with the doctor row and documents the verb`,
        text.includes(CLI_USAGE) && text.includes('darwin doctor'));
    }
  }

  header('doctor — (a) a valid config reports provider and model, exit 0');
  const project = freshProject('project');
  write(path.join(project, 'AGENTS.md'), '# Fixture\n\nRules.\n');
  {
    writeConfig({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', region: 'eu-west-1', thinkingEffort: 'low' });
    const run = await doctor(project);
    assert('exit 0 with nothing wrong', run.code === 0);
    assert('nothing on stderr', run.err === '');
    assert('names the provider and model', run.out.includes('provider bedrock   model us.anthropic.claude-sonnet-4-20250514-v1:0'));
    assert('names the configured region', run.out.includes('region eu-west-1'));
    assert('states effort, cache, offload and the session flags',
      run.out.includes('effort low') && run.out.includes('prompt cache on') && run.out.includes('context offload on')
        && run.out.includes('trajectory on   memory on   diagnostics off') && run.out.includes('permission mode default'));
    assert('states the project instructions size against the cap',
      run.out.includes(`${path.join(project, 'AGENTS.md')}   `) && run.out.includes(`(cap ${MAX_INSTRUCTIONS_BYTES.toLocaleString('en-US')})`));
    assert('states the system prompt source', run.out.includes('source built-in default'));
    assert('states the sessions store is absent', run.out.includes('absent (no sessions yet)'));
    assert('lists the required built-in skills', run.out.includes('required built-ins present: developer, self-evolution-research, self-reflection'));
    assert('names versions', /darwin \S+\n/.test(run.out) && run.out.includes(`node ${process.version}`) && run.out.includes(`platform ${os.platform()}`));
    assert('closes with the no-problem summary', run.out.trimEnd().endsWith('no problems found') && problemLines(run.out).length === 0);
  }

  header('doctor — api key values never reach the report');
  {
    const secret = 'sk-fixture-secret-value-0123456789';
    process.env['DOCTOR_FIXTURE_KEY'] = secret;
    writeConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKeyEnv: 'DOCTOR_FIXTURE_KEY', baseUrl: 'https://gateway.example.test' });
    const run = await doctor(project);
    delete process.env['DOCTOR_FIXTURE_KEY'];
    assert('anthropic config reports the base URL and that the key env is set',
      run.out.includes('base URL https://gateway.example.test') && run.out.includes('api key env DOCTOR_FIXTURE_KEY: set'));
    assert('the secret itself is absent from the report', !run.out.includes(secret));
    const unset = await doctor(project);
    assert('an unset key env is stated as not set, not as a problem',
      unset.out.includes('api key env DOCTOR_FIXTURE_KEY: not set') && unset.code === 0);
  }

  header('doctor — (b) an unknown config key is a named problem line, exit 1');
  {
    writeConfig({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', modle: 'x' });
    const run = await doctor(project);
    const problems = problemLines(run.out);
    assert('exit 1', run.code === 1);
    assert('exactly one problem line, from config', problems.length === 1 && problems[0]!.includes(`${PROBLEM_MARKER}config: `));
    assert('the line names the file and the key',
      problems[0]!.includes(path.join(HOME, '.darwin', 'config.json')) && problems[0]!.includes('"modle"'));
    assert('the rest of the report still ran', run.out.includes('\nskills\n') && run.out.includes('\nversions\n'));
    assert('the total names one problem', run.out.trimEnd().endsWith(`1 problem found (lines marked ${PROBLEM_MARKER.trim()})`));
  }

  header('doctor — (c) invalid JSON config is a named problem line, exit 1');
  {
    writeConfig('{ "provider": ');
    const run = await doctor(project);
    const problems = problemLines(run.out);
    assert('exit 1', run.code === 1);
    assert('the config problem names the file as not valid JSON',
      problems.some((line) => line.includes(`${PROBLEM_MARKER}config: ${path.join(HOME, '.darwin', 'config.json')} is not valid JSON`)));
    // The hook-layer loader reads the same global file for embedded legacy hooks, so it
    // refuses too: both refusals are reported, each naming the file — never a crash.
    assert('every problem line names the broken file, and the report still completes',
      problems.length === 2 && problems.every((line) => line.includes(path.join(HOME, '.darwin', 'config.json'))) && run.out.includes('\nversions\n'));
  }

  header('doctor — (d) MCP: PATH lookup only, never a spawn or a connection');
  {
    writeConfig({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0' });
    const bin = freshProject('bin');
    const marker = path.join(bin, 'MARKER');
    const script = path.join(bin, 'marker-writer');
    write(script, `#!/bin/sh\necho spawned > "${marker}"\n`);
    chmodSync(script, 0o755);
    write(path.join(project, '.darwin', 'mcp.json'), JSON.stringify({
      mcpServers: {
        marker: { command: 'marker-writer', args: ['--token', 'args-are-never-printed'] },
        bogus: { command: 'definitely-not-a-command-xyz' },
        remote: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer headers-are-never-printed' } },
        sse: { url: 'http://127.0.0.1:1/sse', transport: 'sse' },
        templated: { command: '${HOME}/tool' },
        off: { command: 'definitely-not-a-command-xyz', disabled: true },
      },
    }));
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const run = await doctor(project);
    process.env['PATH'] = previousPath;
    assert('the marker script was never executed', !existsSync(marker));
    assert('the found command is reported with its resolved path', run.out.includes(`server marker: stdio command "marker-writer" found at ${script}`));
    assert('the bogus command is one problem line', problemLines(run.out).some((line) => line.includes('server bogus: stdio command "definitely-not-a-command-xyz" not found on PATH')));
    assert('http servers state the URL and that doctor never connects',
      run.out.includes('server remote: streamable-http http://127.0.0.1:1/mcp — not connected (doctor never connects)')
        && run.out.includes('server sse: sse http://127.0.0.1:1/sse — not connected (doctor never connects)'));
    assert('a templated command is stated as not checked', run.out.includes('server templated: stdio ${HOME}/tool — not checked'));
    assert('a disabled server is stated as disabled, not looked up', run.out.includes('server off: disabled'));
    assert('args and headers never reach the report', !run.out.includes('never-printed'));
    assert('the project file is read and the others absent',
      run.out.includes(`project ${path.join(project, '.darwin', 'mcp.json')} — read`)
        && run.out.includes(`project fallback ${path.join(project, '.mcp.json')} — absent`)
        && run.out.includes(`global ${path.join(HOME, '.darwin', 'mcp.json')} — absent`));
    assert('exactly the one MCP problem', problemLines(run.out).length === 1 && run.code === 1);

    write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shadow: { command: 'x' } } }));
    const shadowed = await doctor(project);
    assert('a root .mcp.json beside .darwin/mcp.json is stated as ignored', shadowed.out.includes(`${path.join(project, '.mcp.json')} — ignored`));

    write(path.join(project, '.darwin', 'mcp.json'), '{ not json');
    const broken = await doctor(project);
    assert('a malformed MCP file is one problem line naming it, and the report continues',
      broken.code === 1 && problemLines(broken.out).some((line) => line.includes(`mcp: ${path.join(project, '.darwin', 'mcp.json')} could not be loaded`))
        && broken.out.includes('\nskills\n'));
    rmSync(path.join(project, '.darwin', 'mcp.json'));
    rmSync(path.join(project, '.mcp.json'));

    assert('lookupOnPath answers undefined for an unknown name', lookupOnPath('definitely-not-a-command-xyz', { PATH: bin }) === undefined);
    assert('lookupOnPath finds a script on the given PATH', lookupOnPath('marker-writer', { PATH: bin }) === script);
    assert('lookupOnPath checks a path with a separator directly', lookupOnPath(script, { PATH: '' }) === script);
    assert('lookupOnPath does not run anything', !existsSync(marker));
  }

  header('doctor — (e) skipped skills are stated with their reason');
  {
    write(path.join(project, '.darwin', 'skills', 'good', 'SKILL.md'), '---\nname: doctor-fixture-good\ndescription: A valid fixture skill.\n---\nBody.\n');
    write(path.join(project, '.darwin', 'skills', 'reserved', 'SKILL.md'), '---\nname: developer\ndescription: Tries to take a built-in name.\n---\nBody.\n');
    write(path.join(project, '.darwin', 'skills', 'nodesc', 'SKILL.md'), '---\nname: doctor-fixture-nodesc\n---\nBody.\n');
    const run = await doctor(project);
    const problems = problemLines(run.out);
    assert('the valid skill is counted for its layer', run.out.includes(`project .darwin ${path.join(project, '.darwin', 'skills')} — 1 skill`));
    assert('the reserved name is a skipped-skill problem with the loader\'s reason',
      problems.some((line) => line.includes(`skill skipped ${path.join(project, '.darwin', 'skills', 'reserved')}: skill name "developer" is reserved by built-in skill developer`)));
    assert('the missing description is a skipped-skill problem',
      problems.some((line) => line.includes(`skill skipped ${path.join(project, '.darwin', 'skills', 'nodesc')}: SKILL.md frontmatter is missing a "description" field`)));
    assert('two skill problems, exit 1, total stated', problems.length === 2 && run.code === 1 && run.out.trimEnd().endsWith(`2 problems found (lines marked ${PROBLEM_MARKER.trim()})`));
    rmSync(path.join(project, '.darwin', 'skills'), { recursive: true });
  }

  header('doctor — hooks: dialect stated, decode problem reported');
  {
    write(path.join(project, '.darwin', 'hooks', 'policy.json'), JSON.stringify({
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }],
    }));
    write(path.join(project, '.agents', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'true' }] }] },
    }));
    const run = await doctor(project);
    assert('the native file is listed with its dialect', run.out.includes(`${path.join(project, '.darwin', 'hooks', 'policy.json')} — native dialect`));
    assert('the portable file is listed as the Codex adapter', run.out.includes(`${path.join(project, '.agents', 'hooks.json')} — Codex adapter dialect`));
    assert('valid hooks are no problem', run.code === 0);

    write(path.join(project, '.agents', 'hooks.json'), JSON.stringify({ hooks: { NotAnEvent: [] } }));
    const broken = await doctor(project);
    assert('an undecodable hooks file is one hooks/policy problem line naming it',
      broken.code === 1 && problemLines(broken.out).some((line) => line.includes('hooks/policy: ') && line.includes(path.join(project, '.agents', 'hooks.json'))));
    assert('the permission-rules section says the count is unavailable rather than guessing', broken.out.includes('count unavailable (see the hooks/policy problem)'));
    rmSync(path.join(project, '.darwin', 'hooks'), { recursive: true });
    rmSync(path.join(project, '.agents'), { recursive: true });
  }

  header('doctor — over-cap AGENTS.md and a broken system-prompt override are problems');
  {
    write(path.join(project, 'AGENTS.md'), `# Big\n${'x'.repeat(MAX_INSTRUCTIONS_BYTES)}\n`);
    mkdirSync(path.join(project, '.darwin', 'system-prompt.md'));
    const run = await doctor(project);
    assert('truncation is a problem naming the cap',
      problemLines(run.out).some((line) => line.includes('AGENTS.md is over the cap') && line.includes(MAX_INSTRUCTIONS_BYTES.toLocaleString('en-US'))));
    assert('a directory where system-prompt.md should be is a skipped-override problem',
      problemLines(run.out).some((line) => line.includes('system prompt override skipped')));
    rmSync(path.join(project, '.darwin', 'system-prompt.md'), { recursive: true });
    write(path.join(project, 'AGENTS.md'), '# Fixture\n\nRules.\n');
  }

  header('doctor — every report line is bounded');
  {
    const longName = `n${'e'.repeat(MAX_DOCTOR_LINE_CHARS + 100)}`;
    write(path.join(project, '.darwin', 'mcp.json'), JSON.stringify({ mcpServers: { [longName]: { url: 'http://127.0.0.1:1/x' } } }));
    const run = await doctor(project);
    const lines = run.out.split('\n');
    assert('no line exceeds the cap in code points', lines.every((line) => [...line].length <= MAX_DOCTOR_LINE_CHARS + 4));
    assert('the cut line ends in an ellipsis', lines.some((line) => line.includes('server nee') && line.endsWith('…')));
    rmSync(path.join(project, '.darwin', 'mcp.json'));
  }

  header('doctor — (f) the real verb creates nothing: pristine HOME + project byte-identical');
  {
    const pristineHome = mkdtempSync(path.join(os.tmpdir(), 'darwin-doctor-pristine-home-'));
    process.on('exit', () => rmSync(pristineHome, { recursive: true, force: true }));
    const fixture = freshProject('snapshot');
    write(path.join(fixture, 'AGENTS.md'), '# Fixture\n');
    write(path.join(fixture, '.darwin', 'mcp.json'), JSON.stringify({ mcpServers: { remote: { url: 'http://127.0.0.1:1/mcp' } } }));
    write(path.join(fixture, '.darwin', 'skills', 'one', 'SKILL.md'), '---\nname: doctor-snapshot-skill\ndescription: Fixture.\n---\nBody.\n');
    const before = { home: snapshot(pristineHome), project: snapshot(fixture) };
    const result = cli([DOCTOR_COMMAND], { home: pristineHome, cwd: fixture });
    const after = { home: snapshot(pristineHome), project: snapshot(fixture) };
    assert('the process exits 0 with a complete report on stdout',
      result.status === 0 && result.stderr === '' && result.stdout.includes('no problems found') && result.stdout.includes('\nversions\n'));
    assert('an absent config is stated as defaults, not a problem', result.stdout.includes('absent, built-in defaults apply') && result.stdout.includes('provider bedrock'));
    assert('HOME snapshot is identical before and after (nothing created, nothing touched)', isDeepStrictEqual(before.home, after.home));
    assert('project snapshot is identical before and after', isDeepStrictEqual(before.project, after.project));
    assert('~/.darwin was never created', !existsSync(path.join(pristineHome, '.darwin')));
    assert('the snapshot really saw the fixture', Object.keys(before.project).length >= 4 && Object.keys(before.home).length === 0);
  }

  header('doctor — (g) a stray argument is a usage error, exit 2');
  {
    const result = cli([DOCTOR_COMMAND, 'extra'], { home: HOME, cwd: project });
    assert('exit 2, message line first, hint last, nothing on stdout',
      result.status === 2
        && result.stderr.startsWith('error: doctor takes no arguments.\n')
        && result.stderr.includes('Usage: darwin doctor')
        && result.stderr.endsWith(HINT_LINE)
        && result.stdout === '');
    const separated = cli(['--', DOCTOR_COMMAND, 'extra'], { home: HOME, cwd: project });
    assert('the separated form is identical', isDeepStrictEqual(separated, result));
  }

  header('doctor — (h) the module reaches no runtime, Ink or React module and constructs no Agent');
  {
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const closure = new Map<string, string>();
    const visit = (file: string): void => {
      if (closure.has(file)) return;
      const text = stripComments(readFileSync(path.join(REPO, file), 'utf8'));
      closure.set(file, text);
      for (const match of text.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'\s*\)/g)) {
        const specifier = match[1] ?? match[2]!;
        if (!specifier.startsWith('.')) continue;
        const resolved = path.normalize(path.join(path.dirname(file), specifier)).replace(/\.js$/, '.ts');
        const candidate = existsSync(path.join(REPO, resolved)) ? resolved : resolved.replace(/\.ts$/, '.tsx');
        visit(candidate);
      }
    };
    visit('src/cli-doctor.ts');
    const files = [...closure.keys()];
    assert('the scan saw the loaders it composes (so it really followed imports)',
      files.includes('src/config.ts') && files.includes('src/mcp/registry.ts') && files.includes('src/skills/loader.ts') && files.length > 8);
    const forbiddenFiles = files.filter((file) => /agent\/runtime\.ts|headless|^src\/tui\/|dev-repl|cli\.ts$/.test(file));
    assert(`no runtime, headless, TUI or entry module is in the closure${forbiddenFiles.length > 0 ? ` (offending: ${forbiddenFiles.join(', ')})` : ''}`,
      forbiddenFiles.length === 0);
    const namesInk = files.filter((file) => /'ink'|'react'|'ink\/|'react\//.test(closure.get(file)!));
    assert(`no module in the closure imports Ink or React${namesInk.length > 0 ? ` (offending: ${namesInk.join(', ')})` : ''}`, namesInk.length === 0);
    const constructsAgent = files.filter((file) => {
      const text = closure.get(file)!;
      if (/new\s+Agent\s*\(/.test(text)) return true;
      return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@strands-agents\/sdk'/g)]
        .some((match) => match[1]!.split(',').map((name) => name.trim().replace(/^type\s+/, '')).includes('Agent'));
    });
    assert(`no module in the closure imports or constructs the SDK Agent${constructsAgent.length > 0 ? ` (offending: ${constructsAgent.join(', ')})` : ''}`,
      constructsAgent.length === 0);
    const source = closure.get('src/cli-doctor.ts')!;
    assert('cli-doctor.ts uses no write, spawn or network API',
      !/writeFile|appendFile|createWriteStream|mkdir|unlink|rename|\btruncate(Sync)?\(|utimes|\brm\b|\bcp\(|spawn(Sync)?\(|exec(Sync|File|FileSync)?\(|fork\(|fetch\(|node:net|node:http|node:child_process/.test(source));
    assert('cli-doctor.ts reads MCP servers through the declarative reader, never the client loader',
      source.includes('readMcpServerConfigs') && !source.includes('loadMcpClients') && !source.includes('loadServers'));
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
