/** SER-115: real source CLI + real Bash; offline, owned HOME/cwd, no runtime startup.
 * Checklist: local argv/preflight contract, byte-zero isolation, parser vocabulary drift,
 * every grammar state/operand, literal shell input, builtins only, no path fallback.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { bashCompletion, COMPLETION_GRAMMAR } from '../src/cli-completion.js';
import { CLI_USAGE, HELP_FLAGS, VERSION_FLAGS, usageErrorText } from '../src/cli-usage.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('cli-completion');
const ROOT = path.resolve(import.meta.dirname, '..');
const cwd = path.join(HOME, 'project');
mkdirSync(cwd);
const sources = new Map<string, string>();
const source = (file: string): string => {
  if (!sources.has(file)) sources.set(file, readFileSync(path.join(ROOT, file), 'utf8'));
  return sources.get(file)!;
};
const keys = (state: string): string[] => Object.keys(COMPLETION_GRAMMAR[state]!.words ?? {});
const same = (a: readonly string[], b: readonly string[]): boolean => isDeepStrictEqual([...a].sort(), [...b].sort());

header('local CLI protocol and byte-zero isolation');
function put(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
for (const root of [HOME, cwd]) {
  put(path.join(root, '.darwin/config.json'), '{ invalid config');
  put(path.join(root, '.darwin/hooks.json'), JSON.stringify({ TurnComplete: [{ command: 'touch MUST_NOT_RUN' }] }));
  put(path.join(root, '.agents/hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch MUST_NOT_RUN' }] }] } }));
  put(path.join(root, '.darwin/mcp.json'), JSON.stringify({ mcpServers: { sentinel: { command: 'touch', args: ['MUST_NOT_RUN'] } } }));
}
function snapshot(directory: string): unknown {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [
    entry.name, entry.isDirectory() ? snapshot(path.join(directory, entry.name)) : readFileSync(path.join(directory, entry.name)).toString('base64'),
  ]);
}
const before = snapshot(HOME);
function cli(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'src/cli.ts'), ...args], {
    cwd, env: { ...process.env, HOME }, encoding: 'utf8', timeout: 15_000,
  });
}
const generated = cli(['completion', 'bash']);
assert('generation exits 0 with only deterministic Bash stdout', generated.status === 0 && generated.stderr === '' && generated.stdout === bashCompletion());
const separated = cli(['--', 'completion', 'bash']);
assert('one leading separator generates byte-identical source', separated.status === 0 && separated.stderr === '' && separated.stdout === generated.stdout);
for (const args of [[], ['fish'], ['zsh'], ['BASH'], ['bash', 'extra'], ['--', 'bash'], ['$(touch MUST_NOT_RUN)']]) {
  const result = cli(['completion', ...args]);
  assert(`malformed completion ${JSON.stringify(args)} is local exit 2`, result.status === 2 && result.stdout === '' && result.stderr === usageErrorText('usage: darwin completion bash'));
}
const malformedSeparated = cli(['--', 'completion']);
assert('separated malformed call uses the same exit-2 protocol', malformedSeparated.status === 2 && malformedSeparated.stdout === '' && malformedSeparated.stderr === usageErrorText('usage: darwin completion bash'));
for (const flag of [...HELP_FLAGS, ...VERSION_FLAGS]) {
  const result = cli(['--', 'completion', 'fish', 'extra', flag]);
  const expected = HELP_FLAGS.includes(flag as '--help') ? CLI_USAGE : `darwin ${JSON.parse(source('package.json')).version}\n`;
  assert(`${flag} wins over invalid completion operands`, result.status === 0 && result.stdout === expected && result.stderr === '');
}
const helpWins = cli(['completion', '--version', '--help']);
assert('help retains precedence over version', helpWins.status === 0 && helpWins.stdout === CLI_USAGE && helpWins.stderr === '');
assert('all successful and malformed calls leave HOME/cwd byte-identical; no sentinel work', isDeepStrictEqual(snapshot(HOME), before));

// The entire local import closure is tiny and explicit; changing it must be reviewed.
for (const [file, allowed] of [
  ['src/cli-completion.ts', ['./cli-usage.js']], ['src/cli-usage.ts', ['./version.js']],
  ['src/version.ts', ['node:fs', 'node:path']], ['src/cli.ts', ['node:process', './sdk-patch-preflight.js']],
] as const) {
  const text = source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]!);
  assert(`${file} static graph stays local`, same(imports, allowed));
  if (file !== 'src/cli.ts') assert(`${file} has no dynamic loading escape`, !/import\s*\(|require\s*\(/.test(text));
}
const bootstrap = source('src/cli.ts');
assert('completion dispatch is inside successful SDK preflight, before runtime import',
  bootstrap.indexOf("const refusal = sdkPatchPreflight()") < bootstrap.indexOf("args[0] === 'completion'")
  && bootstrap.indexOf("args[0] === 'completion'") < bootstrap.indexOf("await import('./cli-main.js')"));

// Actual unpatched install: copy only the production bootstrap/preflight/identity.
// The completion and runtime modules are deliberately absent: neither may be loaded.
const unpatched = path.join(HOME, 'unpatched');
put(path.join(unpatched, 'package.json'), JSON.stringify({ type: 'module', name: 'strands-darwin', version: '0.0.0' }));
for (const file of ['cli.ts', 'sdk-patch-preflight.ts', 'version.ts']) put(path.join(unpatched, file), source(`src/${file}`));
put(path.join(unpatched, 'node_modules/@strands-agents/sdk/package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
put(path.join(unpatched, 'node_modules/@strands-agents/sdk/index.js'), 'throw new Error("SDK MUST NOT LOAD");');
for (const args of [['completion', 'bash'], ['completion', '--help'], ['completion', '--version']]) {
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(unpatched, 'cli.ts'), ...args], {
    cwd, env: { ...process.env, HOME }, encoding: 'utf8', timeout: 15_000,
  });
  assert(`SDK marker refusal precedes ${args.join(' ')}`, result.status === 1 && result.stdout === '' && result.stderr.startsWith('error: the installed @strands-agents/sdk is not patched') && result.stderr.trimEnd().split('\n').length === 5);
}

header('real Bash completion: every state and literal operands');
const completionFile = path.join(HOME, 'completion.bash');
put(completionFile, generated.stdout);
put(path.join(cwd, 'path-fallback-must-not-appear'), 'fixture');
const shellBefore = snapshot(HOME);
const bashDriver = [
  'source "$1"', 'shift', 'COMP_CWORD=$1', 'shift', 'COMP_WORDS=("$@")',
  'PATH=/no-external-commands', 'COMPREPLY=(STALE)', '_darwin_completion',
  'if (( ${#COMPREPLY[@]} )); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
].join('\n');
function replies(words: string[], cword = words.length): string[] {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', bashDriver, 'completion-test', completionFile, String(cword), 'darwin', ...words], {
    cwd, env: { ...process.env, HOME, BASH_ENV: '/dev/null', ENV: '/dev/null' }, encoding: 'utf8', timeout: 5_000,
  });
  if (result.status !== 0 || result.stderr !== '') throw new Error(`Bash failed: ${result.status}: ${result.stderr}`);
  return result.stdout === '' ? [] : result.stdout.slice(0, -1).split('\0');
}
function expect(words: string[], expected: string[], label = words.join(' ')): void {
  const actual = replies(words);
  assert(`${label}: ${JSON.stringify(actual)}`, same(actual, expected));
}
// Shortest prefixes visit every supported state, including every kind of free operand.
const prefixes = new Map<string, string[]>([['root', []]]);
for (const [state, prefix] of prefixes) {
  const grammar = COMPLETION_GRAMMAR[state]!;
  for (const [word, next] of Object.entries(grammar.words ?? {})) {
    if (!prefixes.has(next)) prefixes.set(next, [...prefix, word]);
  }
  if (grammar.operand && !prefixes.has(grammar.operand)) prefixes.set(grammar.operand, [...prefix, 'trajectory']);
}
assert('all declared grammar states are reachable', prefixes.size === Object.keys(COMPLETION_GRAMMAR).length);
for (const [state, prefix] of prefixes) {
  const used = new Set(prefix.map(word => word === '--print' ? '-p' : word));
  const expected = keys(state).filter(word => !word.startsWith('-') || !used.has(word === '--print' ? '-p' : word));
  expect([...prefix, ''], COMPLETION_GRAMMAR[state]!.optionalOperand ? [] : expected, `state ${state}`);
  // Test a nonempty prefix too: literal starts-with matching, not glob expansion.
  if (expected.length) {
    const start = expected[0]!.slice(0, 1);
    expect([...prefix, start], expected.filter(word => word.startsWith(start)), `prefix in ${state}`);
  }
}
const argsAfterPrompt = keys('args').filter(word => !['-p', '--print'].includes(word));
expect(['-p', 'trajectory', ''], argsAfterPrompt, 'command-named prompt never becomes a subcommand');
expect(['--print', 'mcp', '--output-format', 's'], ['stream-json']);
expect(['--permission-mode', 'a'], ['auto']);
expect(['--output-format', 'j'], ['json']);
expect(['--', 'completion', 'b'], ['bash']);
expect(['--resume', '--permission-mode', 'p'], ['plan']);
expect(['--resume', 'trajectory', '--s'], [], 'optional resume id consumed, conflicting session not offered');
expect(['--session', 'mcp', '--p'], ['--print', '--permission-mode']);
expect(['--max-model-calls', '2', '-p', 'collaborate', '--o'], ['--output-format']);
expect(['trajectory', 'search', 'mcp', '--type', 'permissions', '--l'], ['--limit']);
expect(['trajectory', 'replay', 'trajectory', '--turn', '2', ''], ['--json']);
expect(['collaborate', 'confirm', 'trajectory', '--p'], ['--persist']);
expect(['collaborate', 'hub', 'enroll', 'trajectory', 'mcp', '--n'], ['--name']);
expect(['collaborate', 'hub', 'publish', 'o'], ['on', 'off']);
expect(['cloud-memory', 'list', 'episodes', 'a'], ['after']);
expect(['cloud-memory', 'pending', 'accepted', 'a'], ['after']);
expect(['import', '--apply', '--from', 'c'], ['claude-code']);
assert('cursor uses COMP_CWORD, not the final word', same(replies(['trajectory', 'r', 'ignored-tail'], 2), ['replay']));
for (const words of [
  ['unknown', ''], ['--', '--', ''], ['--yolo', 'trajectory', ''],
  ['completion', 'fish', ''], ['completion', 'bash', ''], ['sessions', ''],
  ['doctor', '--'], ['list-agents', ''], ['mcp', 'login', ''], ['mcp', 'logout', 'server', '--'],
  ['mcp', 'login', 'server', '--no-browser', ''], ['mcp', 'unknown', ''],
  ['-p', ''], ['--session', ''], ['--max-model-calls', ''], ['--resume', ''],
  ['--permission-mode', 'bad', ''], ['--output-format', 'bad', ''], ['--unknown', ''],
  ['-p', 'one', '--print', 'two', ''], ['--session', 'one', '--resume', 'two', ''],
  ['permissions', 'test', ''], ['permissions', 'test', 'mcp', ''],
  ['trajectory', 'fork', 'mcp', ''], ['trajectory', 'list', '--'],
  ['cloud-memory', 'send', ''], ['cloud-memory', 'list', 'after', ''],
  ['cloud-memory', 'pending', 'after', 'token', ''], ['collaborate', 'send', 'id', 'mcp', ''],
  ['collaborate', 'hub', 'enroll', 'url', 'token', '--name', 'trajectory', ''],
  ['-p', 'path-'], ['path-'], ['--help', ''], ['--version', ''],
]) expect(words, [], `unsupported/free/terminal ${JSON.stringify(words)}`);
for (const literal of ['$(printf injected >MUST_NOT_RUN)', '`printf injected >MUST_NOT_RUN`', '; printf injected >MUST_NOT_RUN', 'a[0]=$(printf injected >MUST_NOT_RUN)', '*', '?', '[', '"', "'", 'two words\ntrajectory']) {
  expect([literal], [], 'metacharacter prefix is literal');
  expect(['-p', literal, '--o'], ['--output-format'], 'metacharacter operand is literal');
  expect(['trajectory', 'search', literal, '--l'], ['--limit'], 'metacharacter query is literal');
}
const registration = spawnSync('bash', ['--noprofile', '--norc', '-c', 'source "$1"; complete -p darwin', 'test', completionFile], {
  cwd, encoding: 'utf8', env: { ...process.env, HOME, BASH_ENV: '/dev/null' },
});
assert('registration has only the function, no default/bashdefault/filenames fallback', registration.status === 0 && registration.stderr === '' && registration.stdout === 'complete -F _darwin_completion darwin\n');
assert('generated source has no substitutions, eval, discovery or external-command constructs', !/\$\(|`|\beval\b|\bcompgen\b|\bfind\b|\bls\b/.test(generated.stdout.split('\n').filter(line => !line.startsWith('#')).join('\n')));
assert('all completion exercises leave HOME/cwd byte-identical, including metacharacters', isDeepStrictEqual(snapshot(HOME), shellBefore));

header('drift: authoritative usage and parser vocabulary');
const quoted = (text: string): string[] => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]!);
const capture = (file: string, pattern: RegExp): string => {
  const match = pattern.exec(source(file));
  if (!match) throw new Error(`Parser shape changed: ${file}: ${pattern}`);
  return match[1]!;
};
const rootCommands = [...new Set([...CLI_USAGE.matchAll(/^\s*darwin ([a-z][a-z-]*)/gm)].map(m => m[1]!))];
assert('root commands exactly match CLI_USAGE', same(keys('root').filter(word => !word.startsWith('-')), rootCommands));
const flags = [...source('src/cli-args.ts').matchAll(/case '([^']+)':/g)].map(m => m[1]!);
assert('all root flags, including aliases, match parseCliArgs and local answers', same(keys('args'), [...flags, ...HELP_FLAGS, ...VERSION_FLAGS]));
assert('permission enum matches the gate constant', same(keys('permission'), quoted(capture('src/agent/permission.ts', /APPROVAL_MODES = (\[[^\]]+\])/))));
assert('output enum matches parseCliArgs constant', same(keys('output'), quoted(capture('src/cli-args.ts', /HEADLESS_OUTPUT_FORMATS = (\[[^\]]+\])/))));
assert('completion shell matches the local parser', same(keys('completion'), [capture('src/cli-completion.ts', /argv\[0\] !== '([^']+)'/)]));
const trajectoryParser = capture('src/cli-trajectory.ts', /export function parseTrajectoryArgs([\s\S]*?)\n}/);
assert('trajectory verbs match its switch', same(keys('trajectory'), [...trajectoryParser.matchAll(/case '([^']+)':/g)].map(m => m[1]!)));
const trajectoryFlags = [...source('src/cli-trajectory.ts').matchAll(/parseFlags\(rest\.slice\(1\), (\[[^\]]+\])(?:, (\[[^\]]+\]))?\)/g)];
assert('trajectory search options match its valued flags', same(keys('searchOptions'), quoted(trajectoryFlags[0]![1]!).map(word => `--${word}`)));
assert('trajectory replay options match its valued/boolean flags', same(keys('replayOptions'), quoted(trajectoryFlags[1]![1]! + trajectoryFlags[1]![2]!).map(word => `--${word}`)));
const mcpParser = source('src/cli-mcp.ts');
assert('MCP verbs match its parser', same(keys('mcp'), [...mcpParser.matchAll(/verb !== '([^']+)'/g)].map(m => m[1]!)));
assert('MCP login option matches its parser; logout has none', same(keys('loginOptions'), [capture('src/cli-mcp.ts', /flags\[0\] === '([^']+)'/)]) && COMPLETION_GRAMMAR.serverLogout!.operand === 'end');
assert('permissions verb matches its parser', same(keys('permissions'), [capture('src/cli-permissions.ts', /argv\[0\] !== '([^']+)'/)]));
assert('import source and options match its parser',
  same(keys('importFrom'), [capture('src/cli-import.ts', /args\[1\] !== '([^']+)'/)])
  && same(keys('import'), [capture('src/cli-import.ts', /args\[0\] !== '([^']+)'/), capture('src/cli-import.ts', /argv.includes\('([^']+)'\)/)]));
const collaboration = source('src/collaboration/command.ts');
const collabVerbs = [...collaboration.matchAll(/verb === '([^']+)'/g)].map(m => m[1]!);
const collabSimple = quoted(capture('src/collaboration/command.ts', /args.length === 1 && (\[[^\]]+\])/));
assert('collaboration verbs match its preflight', same(keys('collaborate'), [...collabVerbs, ...collabSimple]));
assert('confirmation option matches its preflight', same(keys('confirmOptions'), [capture('src/collaboration/command.ts', /flag === '([^']+)'/)]));
const hub = capture('src/collaboration/hub-command.ts', /export function parseHubArgs([\s\S]*?)\n}/);
assert('hub verbs match parseHubArgs', same(keys('hub'), [...hub.matchAll(/verb === '([^']+)'/g)].map(m => m[1]!)));
assert('hub publish values match parseHubArgs', same(keys('publish'), [...new Set([...hub.matchAll(/a === '([^']+)'/g)].map(m => m[1]!))]));
assert('hub enrollment option matches parseHubArgs', same(keys('enrollOptions'), [capture('src/collaboration/hub-command.ts', /c === '([^']+)'/)]));
const cloudUsage = capture('src/agentcore/controller.ts', /CLOUD_READ_USAGE = '([^']+)'/);
const cloudVerbs = cloudUsage.slice(cloudUsage.indexOf('[') + 1, -1).replace(/\[[^\]]*\]/g, '').split('|').map(part => part.trim().split(' ')[0]!);
assert('cloud CLI only offers read verbs from CLOUD_READ_USAGE', same(keys('cloud'), cloudVerbs));
const cloudKinds = capture('src/agentcore/controller.ts', /LIST_ARGUMENTS = .*?\(\?: \(\?:([^)]*)\)/).split('|');
assert('cloud list kinds and after match its parser', same(keys('cloudList'), [...cloudKinds, 'after']));
assert('cloud pending options match its parser', source('src/agentcore/controller.ts').includes('^pending(?: accepted)?(?: after [a-f0-9]{64})?$') && same(keys('cloudPending'), ['accepted', 'after']));

// Exercise actual pure parsers too, not just the spelling checks above. No command runs.
const { parseCliArgs } = await import('../src/cli-args.js');
const { parseTrajectoryArgs } = await import('../src/cli-trajectory.js');
for (const mode of keys('permission')) assert(`parser accepts permission ${mode}`, parseCliArgs(['--permission-mode', mode]).permissionModeOverride === mode);
for (const format of keys('output')) assert(`parser accepts output ${format}`, parseCliArgs(['-p', 'trajectory', '--output-format', format]).outputFormat === format);
assert('parser agrees a command-named prompt remains a prompt', parseCliArgs(['-p', 'trajectory']).prompt === 'trajectory');
assert('parser accepts completed search option shape', parseTrajectoryArgs(['search', 'mcp', '--session', 'fixture', '--type', 'free-type', '--limit', '2']).verb === 'search');
assert('parser accepts completed replay option shape', parseTrajectoryArgs(['replay', 'fixture', '--turn', '2', '--json']).verb === 'replay');
for (const file of ['docs/user-guide/reference.md', 'docs/user-guide/reference.zh-CN.md']) {
  assert(`${file} quotes the current CLI_USAGE verbatim`, source(file).includes(CLI_USAGE));
}
assert('new suite is registered in the fast gate', source('spike/run-tests.ts').includes("'verify-cli-completion.ts'"));

report();
