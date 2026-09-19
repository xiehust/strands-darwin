/** SER-099: real CLI/files in private HOME/project only. No model/network calls or mocked I/O.
 * Checklist: grammar, byte-zero scan, provenance/bounds, prompt-only loader discovery,
 * restrictions/collisions, AGENTS append/repeat/cap, resources/symlinks/races, exact snippets,
 * sensitive omissions, no policy/trust/session execution, failed/partial apply, docs/SDK-free graph.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpClient } from '@strands-agents/sdk';
import { scanClaudeImport, applyClaudeImport, formatImportPlan } from '../src/import-claude.js';
import { IMPORT_LIMITS, ImportReader, writeImport } from '../src/import-claude-files.js';
import { manualMcp, manualSettings } from '../src/import-claude-snippets.js';
import { loadAgentDefinitions } from '../src/agents/loader.js';
import { scanSkills } from '../src/skills/loader.js';
import { loadProjectInstructions } from '../src/agent/instructions.js';
import { loadProjectPolicy } from '../src/config.js';
import { inventoryWorkspace } from '../src/agent/workspace-trust.js';
import { userProjectDir } from '../src/paths.js';
import { CLI_USAGE } from '../src/cli-usage.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('import-command');
const REPO = path.resolve(import.meta.dirname, '..');
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'darwin-import-project-'));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));
const put = (file: string, data: string | Buffer): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
const doc = (name: string, extra = '', body = 'Follow the project conventions.\n'): string => `---\nname: ${name}\ndescription: A fixture prompt\n${extra}---\n${body}`;
function digest(root: string): string {
  const values: string[] = [];
  function walk(file: string): void {
    const stat = lstatSync(file);
    if (stat.isDirectory()) { values.push(file); for (const name of readdirSync(file).sort()) walk(path.join(file, name)); }
    else if (stat.isFile()) values.push(file, readFileSync(file).toString('base64'), String(stat.mode));
    else values.push(file, 'special');
  }
  walk(root);
  return createHash('sha256').update(values.join('\n')).digest('hex');
}
function cli(args: string[], root = ROOT) {
  const result = spawnSync(process.execPath, ['--import', path.join(REPO, 'node_modules/tsx/dist/loader.mjs'), path.join(REPO, 'src/cli.ts'), 'import', ...args], {
    cwd: root, env: { ...process.env, HOME }, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
const command = ['--from', 'claude-code'];

header('SER-099 grammar and private fixture scan/apply');
put(path.join(ROOT, '.claude/skills/review/SKILL.md'), doc('review'));
put(path.join(ROOT, '.claude/skills/review/scripts/check.sh'), '#!/bin/sh\ntouch MUST_NOT_RUN\n');
put(path.join(ROOT, '.claude/agents/writer.md'), doc('writer'));
put(path.join(ROOT, '.claude/agents/quiet.md'), doc('quiet', 'tools: []\n'));
put(path.join(HOME, '.claude/skills/global-skill/SKILL.md'), doc('global-skill'));
put(path.join(HOME, '.claude/agents/global-agent.md'), doc('global-agent'));
put(path.join(HOME, '.claude/CLAUDE.md'), 'GLOBAL_INSTRUCTIONS_NOT_PROJECT\n');
put(path.join(ROOT, 'CLAUDE.md'), 'Project instructions\n@do-not-read.env\n');
put(path.join(ROOT, '.claude/CLAUDE.md'), 'Extra instructions\n');
put(path.join(ROOT, 'AGENTS.md'), Buffer.from('KEEP\r\nexisting bytes without final newline'));
put(path.join(ROOT, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch MUST_NOT_RUN' }] }] }, permissions: { allow: ['Bash(pnpm test)', 'Read', 'Bash(echo SUPER_SECRET)'], deny: ['Bash(git diff)'], ask: ['Bash'] } }));
put(path.join(HOME, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }));
put(path.join(ROOT, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
put(path.join(ROOT, '.mcp.json'), JSON.stringify({ mcpServers: {
  public: { type: 'http', url: 'https://example.com/mcp' },
  runner: { command: 'npx', args: ['-y', '@example/mcp-server'] },
  secret: { command: 'sh', args: ['-c', 'touch MUST_NOT_RUN'], env: { TOKEN: 'SUPER_SECRET' } },
} }));
put(path.join(HOME, '.claude.json'), 'NEVER_SCAN_CREDENTIAL_STORE');
put(path.join(HOME, '.claude/projects/private/history.jsonl'), 'NEVER_SCAN_HISTORY');
put(path.join(HOME, '.darwin/config.json'), 'deliberately invalid runtime config');
for (const args of [[], ['--from'], ['--from', 'other'], [...command, '--apply', '--apply'], [...command, '--yolo'], [...command, 'extra'], ['--from=claude-code'], [...command, '--session', 'x'], ['--from', '--apply', 'claude-code']]) {
  const result = cli(args);
  assert(`strict usage ${JSON.stringify(args)}`, result.status === 2 && result.stdout === '' && result.stderr.includes('usage: darwin import --from claude-code [--apply]'));
}
assert('local help precedence', cli(['--apply', '--bad', '--help']).stdout === CLI_USAGE);
assert('local version precedence', cli(['--bad', '--version']).stdout.startsWith('darwin '));
const before = digest(ROOT) + digest(HOME);
const trustBefore = JSON.stringify(await inventoryWorkspace(ROOT));
const scan = cli(command);
assert('default scan succeeds despite broken runtime config', scan.status === 0 && scan.stderr === '');
assert('default scan is byte-zero, creates no state', before === digest(ROOT) + digest(HOME));
assert('plan names exact project/global provenance and targets', scan.stdout.includes(JSON.stringify(path.join(ROOT, '.claude/skills/review'))) && scan.stdout.includes(JSON.stringify(path.join(HOME, '.darwin/skills/global-skill'))));
assert('plan states fallback, literal @ imports, omissions and manual global instruction scope', scan.stdout.includes('fallback remains') && scan.stdout.includes('@ imports stay literal') && scan.stdout.includes('no equivalent global instruction layer') && scan.stdout.includes('~/.claude.json'));
assert('default output has no prompt/script/credential/history values', !/SUPER_SECRET|NEVER_SCAN|MUST_NOT_RUN|GLOBAL_INSTRUCTIONS_NOT_PROJECT/.test(scan.stdout));
const sources = digest(path.join(ROOT, '.claude')) + digest(path.join(HOME, '.claude'));
const originalAgents = readFileSync(path.join(ROOT, 'AGENTS.md'));
const applied = cli([...command, '--apply']);
assert('apply copies accepted prompts', applied.status === 0 && applied.stdout.includes('Applied 7 prompt/resource file write(s)'));
assert('source trees unchanged', sources === digest(path.join(ROOT, '.claude')) + digest(path.join(HOME, '.claude')));
const installed = readFileSync(path.join(ROOT, 'AGENTS.md'));
assert('AGENTS existing bytes retained and both marked sections appended within cap', installed.subarray(0, originalAgents.length).equals(originalAgents) && installed.includes('claude-code:CLAUDE.md') && installed.includes('claude-code:.claude/CLAUDE.md') && installed.length <= 32768);
assert('scripts copied literally, not run, not executable', readFileSync(path.join(ROOT, '.darwin/skills/review/scripts/check.sh'), 'utf8').includes('MUST_NOT_RUN') && (lstatSync(path.join(ROOT, '.darwin/skills/review/scripts/check.sh')).mode & 0o111) === 0 && !existsSync(path.join(ROOT, 'MUST_NOT_RUN')));
const agents = await loadAgentDefinitions(ROOT, ['bash', 'fileEditor']);
assert('actual agent loader discovers global and project imports', ['writer', 'quiet', 'global-agent'].every(name => agents.definitions.some(a => a.name === name)));
assert('explicit no-tools remains empty; absent-tools inherits unchanged', agents.definitions.find(a => a.name === 'quiet')?.tools?.length === 0 && agents.definitions.find(a => a.name === 'writer')?.tools === undefined);
const skills = await scanSkills(ROOT);
assert('actual official skill loader discovers both layers', ['review', 'global-skill'].every(name => skills.skills.some(s => s.name === name)));
const instructions = await loadProjectInstructions(ROOT);
assert('actual instructions loader discovers imported body without @ expansion', instructions.instructions?.filename === 'AGENTS.md' && instructions.instructions.fragment.includes('@do-not-read.env') && !instructions.instructions.truncated);
assert('trust inventory unchanged; import adds no executable project config', trustBefore === JSON.stringify(await inventoryWorkspace(ROOT)));
assert('no policy, trust, hook or session state created', !existsSync(path.join(userProjectDir(ROOT), 'trust.json')) && !existsSync(path.join(userProjectDir(ROOT), 'permission-rules.json')) && !existsSync(path.join(HOME, '.darwin/sessions')) && !existsSync(path.join(ROOT, '.darwin/mcp.json')) && !existsSync(path.join(ROOT, '.darwin/hooks.json')));
const after = digest(ROOT) + digest(HOME);
const repeat = cli(['--apply', ...command]);
assert('repeat apply is byte-identical and has no duplicate instructions/resources', repeat.status === 0 && repeat.stdout.includes('Applied 0') && after === digest(ROOT) + digest(HOME));

header('restrictions, unsupported semantics and collisions');
for (const [name, extra, body] of [
  ['restricted', 'tools: Read, Grep\n', 'body'], ['unknown', 'tools: [fake]\n', 'body'],
  ['model', 'model: sonnet\n', 'body'], ['hooks', 'hooks: {}\n', 'body'],
  ['permissions', 'permissionMode: plan\n', 'body'], ['omit', 'omitClaudeMd: true\n', 'body'],
  ['dynamic', '', '!`touch MUST_NOT_RUN`'], ['arguments', '', '$ARGUMENTS'],
  ['traversal', '', 'body'],
]) put(path.join(ROOT, `.claude/agents/${name}.md`), doc(name === 'traversal' ? '../escape' : name!, extra!, body!));
for (const [name, extra] of [['allowed', 'allowed-tools: Read\n'], ['context', 'context: fork\n'], ['disable', 'disable-model-invocation: true\n'], ['license', 'license: MIT\n']]) put(path.join(ROOT, `.claude/skills/${name}/SKILL.md`), doc(name!, extra!));
put(path.join(ROOT, '.claude/skills/developer/SKILL.md'), doc('developer'));
put(path.join(ROOT, '.claude/agents/general.md'), doc('general'));
put(path.join(ROOT, '.claude/agents/code.md'), '---javascript\n(() => { throw new Error("MUST_NOT_RUN") })()\n---\nbody');
put(path.join(ROOT, '.claude/agents/nested/deep.md'), doc('deep'));
put(path.join(ROOT, '.agents/agents/old.md'), doc('occupied', 'tools: [bash]\n'));
put(path.join(ROOT, '.claude/agents/new.md'), doc('occupied'));
put(path.join(ROOT, '.claude/skills/review/scripts/check.sh'), 'CHANGED_SOURCE_RESOURCE');
const collisionBefore = readFileSync(path.join(ROOT, '.darwin/skills/review/scripts/check.sh'));
const restricted = cli([...command, '--apply']);
assert('unsupported restrictions explicitly manual, not silently dropped', restricted.stdout.includes('restrictions NOT removed') && restricted.stdout.includes('unsupported frontmatter') && !existsSync(path.join(ROOT, '.darwin/agents/restricted.md')) && !existsSync(path.join(ROOT, '.darwin/skills/allowed')));
assert('all unsafe agent forms stay absent', ['unknown', 'model', 'hooks', 'permissions', 'omit', 'dynamic', 'arguments', 'traversal', 'code', 'general', 'new'].every(name => !existsSync(path.join(ROOT, `.darwin/agents/${name}.md`))));
assert('built-in names and portable-layer declared names remain reserved', restricted.stdout.includes('name collision/reservation') && !existsSync(path.join(ROOT, '.darwin/skills/developer')));
assert('nested agents and dynamic substitutions stated', restricted.stdout.includes('nested definitions omitted') && restricted.stdout.includes('substitution is unsupported'));
assert('resource collision never overwrites destination', collisionBefore.equals(readFileSync(path.join(ROOT, '.darwin/skills/review/scripts/check.sh'))));
put(path.join(ROOT, 'CLAUDE.md'), 'changed instruction body');
const conflict = cli([...command, '--apply']);
assert('changed source instruction section requires manual merge, no duplicate', conflict.stdout.includes('existing import section differs') && readFileSync(path.join(ROOT, 'AGENTS.md')).equals(installed));

function fixture(name: string): string { const root = path.join(ROOT, 'cases', name); mkdirSync(root, { recursive: true }); return root; }
const capRoot = fixture('instruction-cap');
put(path.join(capRoot, 'AGENTS.md'), Buffer.alloc(32760, 'x'));
put(path.join(capRoot, 'CLAUDE.md'), 'large enough');
const capBefore = digest(capRoot);
assert('instruction cap refuses append and retains all bytes', cli([...command, '--apply'], capRoot).stdout.includes('32768-byte instruction cap') && digest(capRoot) === capBefore);
const fallbackRoot = fixture('fallback');
put(path.join(fallbackRoot, 'CLAUDE.md'), 'fallback literal @missing.md');
assert('pre-existing CLAUDE fallback unchanged before migration', (await loadProjectInstructions(fallbackRoot)).instructions?.filename === 'CLAUDE.md');
const fallbackApply = cli([...command, '--apply'], fallbackRoot);
assert('new AGENTS creation is loaded normally', fallbackApply.status === 0 && (await loadProjectInstructions(fallbackRoot)).instructions?.filename === 'AGENTS.md');
const sameBodyRoot = fixture('same-body');
put(path.join(sameBodyRoot, 'CLAUDE.md'), 'already present body');
put(path.join(sameBodyRoot, 'AGENTS.md'), 'already present body');
const sameBodyBefore = digest(sameBodyRoot);
assert('already-present literal instructions are not duplicated', cli([...command, '--apply'], sameBodyRoot).stdout.includes('literal body; no section added') && digest(sameBodyRoot) === sameBodyBefore);


header('bounded resources, safe paths and changed-since-scan refusal');
const unsafeRoot = fixture('unsafe');
const outside = fixture('outside');
put(path.join(outside, 'SKILL.md'), doc('escaped'));
mkdirSync(path.join(unsafeRoot, '.claude/skills'), { recursive: true });
symlinkSync(outside, path.join(unsafeRoot, '.claude/skills/escape'));
put(path.join(unsafeRoot, '.claude/skills/resource/SKILL.md'), doc('resource'));
symlinkSync(path.join(outside, 'SKILL.md'), path.join(unsafeRoot, '.claude/skills/resource/link.md'));
put(path.join(unsafeRoot, '.claude/skills/hidden/SKILL.md'), doc('hidden'));
put(path.join(unsafeRoot, '.claude/skills/hidden/.env'), 'NEVER_PRINT_SECRET');
mkdirSync(path.join(unsafeRoot, '.claude/agents'), { recursive: true });
assert('FIFO fixture created', spawnSync('mkfifo', [path.join(unsafeRoot, '.claude/agents/fifo.md')]).status === 0);
linkSync(path.join(outside, 'SKILL.md'), path.join(unsafeRoot, '.claude/agents/hard.md'));
put(path.join(unsafeRoot, 'CLAUDE.md'), 'unsafe target');
symlinkSync(path.join(outside, 'AGENTS.md'), path.join(unsafeRoot, 'AGENTS.md'));
const outsideBefore = digest(outside);
const unsafe = cli([...command, '--apply'], unsafeRoot);
assert('source symlinks, resources, hard links, FIFO and target symlink refused without outside writes', unsafe.status === 0 && unsafe.stdout.includes('MANUAL') && digest(outside) === outsideBefore && !existsSync(path.join(unsafeRoot, '.darwin')));
assert('sensitive resource is not opened or copied', !scanClaudeImport(unsafeRoot).reader.files.has(path.join(unsafeRoot, '.claude/skills/hidden/.env')) && !unsafe.stdout.includes('NEVER_PRINT_SECRET'));
const ancestor = fixture('ancestor');
put(path.join(ancestor, 'CLAUDE.md'), 'test');
symlinkSync(outside, path.join(ancestor, '.darwin'));
put(path.join(ancestor, '.claude/agents/x.md'), doc('x'));
assert('target ancestor symlink cannot escape', cli([...command, '--apply'], ancestor).stdout.includes('MANUAL') && digest(outside) === outsideBefore);
const huge = fixture('huge');
put(path.join(huge, 'CLAUDE.md'), Buffer.alloc(IMPORT_LIMITS.fileBytes + 1, 'x'));
assert('oversized file is omitted before read', cli(command, huge).stdout.includes('file byte cap'));
const entries = fixture('entries');
for (let i = 0; i <= IMPORT_LIMITS.entries; i++) put(path.join(entries, '.claude/agents', `${i}.md`), doc(`agent${i}`));
const entryPlan = scanClaudeImport(entries);
assert('entry cap is explicit and bounded', formatImportPlan(entryPlan).includes('entry cap (400)') && entryPlan.reader.entries <= 406);
const total = fixture('total');
for (let i = 0; i < 17; i++) put(path.join(total, '.claude/skills/big', `r${i}.txt`), Buffer.alloc(IMPORT_LIMITS.fileBytes, 'x'));
put(path.join(total, '.claude/skills/big/SKILL.md'), doc('big'));
const totalPlan = scanClaudeImport(total);
assert('total bytes capped before reading next file', totalPlan.reader.bytes <= IMPORT_LIMITS.totalBytes && formatImportPlan(totalPlan).includes('total byte cap'));
const depth = fixture('depth');
put(path.join(depth, '.claude/skills/deep/SKILL.md'), doc('deep'));
put(path.join(depth, '.claude/skills/deep/a/b/c/d/e/f/g/file'), 'x');
assert('depth cap refuses whole skill', cli(command, depth).stdout.includes('depth cap'));
const count = fixture('resource-count');
put(path.join(count, '.claude/skills/many/SKILL.md'), doc('many'));
for (let i = 0; i < 101; i++) put(path.join(count, '.claude/skills/many', `${i}.txt`), 'x');
assert('resource file cap refuses whole skill', cli(command, count).stdout.includes('resource file cap'));
const output = fixture('output');
for (let i = 0; i < 150; i++) put(path.join(output, '.claude/agents', `${i}-${'x'.repeat(80)}.md`), doc(`long${i}`));
const outputBefore = digest(output);
const bounded = cli([...command, '--apply'], output);
assert('output cap never cuts JSON and refuses hidden apply operations', bounded.stdout.includes('OUTPUT CAP:') && Buffer.byteLength(bounded.stdout) <= IMPORT_LIMITS.outputBytes && bounded.status === 1 && digest(output) === outputBefore);
const race = fixture('race');
put(path.join(race, 'CLAUDE.md'), 'before');
const racePlan = scanClaudeImport(race);
put(path.join(race, 'CLAUDE.md'), 'after');
assert('changed source refuses all writes before apply', applyClaudeImport(racePlan).failed && !existsSync(path.join(race, 'AGENTS.md')));
const destPlan = scanClaudeImport(race);
put(path.join(race, 'AGENTS.md'), 'competing writer');
assert('new competing destination refuses all writes', applyClaudeImport(destPlan).failed && readFileSync(path.join(race, 'AGENTS.md'), 'utf8') === 'competing writer');
const swap = fixture('swap');
put(path.join(swap, '.claude/agents/swap.md'), doc('swap'));
const swapPlan = scanClaudeImport(swap);
renameSync(path.join(swap, '.claude'), path.join(swap, 'original'));
symlinkSync(path.join(outside, 'unrelated'), path.join(swap, '.claude'));
assert('source ancestor swap fails closed', applyClaudeImport(swapPlan).failed && !existsSync(path.join(swap, '.darwin')));
let refusedTraversal = false;
try { new ImportReader().read(`${race}/../outside/SKILL.md`); } catch { refusedTraversal = true; }
assert('unnormalized traversal is rejected', refusedTraversal);
let refusedOverwrite = false;
try { writeImport({ source: 'fixture', target: path.join(race, 'AGENTS.md'), data: Buffer.from('overwrite') }); } catch { refusedOverwrite = true; }
assert('exclusive writer refuses existing destination', refusedOverwrite && readFileSync(path.join(race, 'AGENTS.md'), 'utf8') === 'competing writer');
const appendRace = fixture('append-race');
put(path.join(appendRace, 'CLAUDE.md'), 'new instructions');
put(path.join(appendRace, 'AGENTS.md'), 'before');
const appendPlan = scanClaudeImport(appendRace);
put(path.join(appendRace, 'AGENTS.md'), 'edited during scan');
assert('existing AGENTS changed since scan is never appended', applyClaudeImport(appendPlan).failed && readFileSync(path.join(appendRace, 'AGENTS.md'), 'utf8') === 'edited during scan');
const listRace = fixture('list-race');
put(path.join(listRace, '.claude/agents/a.md'), doc('list-a'));
const listPlan = scanClaudeImport(listRace);
put(path.join(listRace, '.claude/agents/b.md'), doc('list-b'));
assert('changed source directory refuses apply', applyClaudeImport(listPlan).failed && !existsSync(path.join(listRace, '.darwin')));
const hostileName = fixture('hostile-name');
put(path.join(hostileName, '.claude/agents/bad\u001b[31m.md'), doc('bad'));
assert('terminal-control source entry is omitted, never printed', !cli(command, hostileName).stdout.includes('\u001b'));
const hiddenAgent = fixture('hidden-agent');
put(path.join(hiddenAgent, '.claude/agents/credentials.md'), 'PRIVATE_BYTES');
assert('credential-shaped direct source is not opened', !scanClaudeImport(hiddenAgent).reader.files.has(path.join(hiddenAgent, '.claude/agents/credentials.md')));
const partial = fixture('partial');
put(path.join(partial, '.claude/agents/a.md'), doc('a'));
put(path.join(partial, '.claude/agents/z.md'), doc('z'));
const partialPlan = scanClaudeImport(partial);
// A real failing write target inserted at the public plan seam exercises partial failure;
// production plans are private to runImportCli, never accepted from a caller/JSON file.
partialPlan.writes.push({ source: 'fixture', target: path.join(partial, 'missing.md'), before: Buffer.from('missing'), data: Buffer.from('append') });
const failed = applyClaudeImport(partialPlan);
assert('I/O failure reports completed writes and no rollback claim', failed.failed && failed.text.includes('after 2 completed file write(s)') && failed.text.includes('No rollback') && existsSync(path.join(partial, '.darwin/agents/a.md')));


header('manual snippets, loader validation and SDK-free entry graph');
const permissionLines = manualSettings(JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'], deny: ['Bash(git diff)'] } }));
const permissionJson = permissionLines.find(value => value.includes('REVIEW JSON'))!.split('\n').slice(1).join('\n');
const policyRoot = fixture('snippet-policy');
put(path.join(userProjectDir(policyRoot), 'permission-rules.json'), permissionJson);
put(path.join(HOME, '.darwin/config.json'), '{}'); // the real loader, unlike import, must read valid config
const policy = await loadProjectPolicy(policyRoot);
assert('exact candidate permission JSON is accepted by installed policy loader', policy.allowRules[0] === 'bash:pnpm test' && policy.denyRules[0] === 'bash:git diff');
for (const type of ['http', 'streamable-http', 'sse']) {
  const lines = manualMcp(JSON.stringify({ mcpServers: { public: { type, url: 'https://example.com/mcp' } } }));
  const converted = JSON.parse(lines[0]!.split('\n').slice(1).join('\n'));
  assert(`${type} converts to exact SDK transport`, converted.mcpServers.public.transport === (type === 'sse' ? 'sse' : 'streamable-http') && !('type' in converted.mcpServers.public));
  const clients = await McpClient.loadServers(converted.mcpServers);
  assert(`${type} accepted by installed SDK without connecting`, clients.length === 1 && clients[0]!.connectionState === 'disconnected');
}
for (const value of [
  { command: 'node', args: ['SUPER_SECRET'] }, { command: 'node', env: { PUBLIC: 'SUPER_SECRET' } },
  { type: 'http', url: 'https://example.com/mcp?access=SUPER_SECRET' },
  { type: 'http', url: 'https://user:SUPER_SECRET@example.com/mcp' },
  { type: 'http', url: 'https://example.com/SUPER_SECRET' },
  { type: 'http', url: 'https://example.com/mcp', headers: { X: 'SUPER_SECRET' } },
  { type: 'http', url: 'https://${HOST}/mcp' }, { type: 'http', url: 'https://example.com/../mcp' },
  { command: 'node', disabled: true }, { command: '${TOOL}' }, { type: 'ws', url: 'wss://example.com/mcp' },
]) {
  const lines = manualMcp(JSON.stringify({ mcpServers: { server: value } })).join('\n');
  assert(`unsupported/sensitive MCP shape ${JSON.stringify(Object.keys(value))}`, lines.includes('omitted') && !lines.includes('SUPER_SECRET') && !lines.includes('REVIEW JSON'));
}
assert('malformed JSON diagnostics omit contents', (() => { try { manualMcp('SUPER_SECRET'); return false; } catch (e) { return !String(e).includes('SUPER_SECRET'); } })());
const stdioJson = JSON.parse(manualMcp(JSON.stringify({ mcpServers: { runner: { command: 'npx', args: ['-y', '@example/mcp-server'] } } }))[0]!.split('\n').slice(1).join('\n'));
assert('stdio snippet accepted by SDK without spawning', (await McpClient.loadServers(stdioJson.mcpServers))[0]!.connectionState === 'disconnected');
assert('MCP JSON entry cap stated', manualMcp(JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, { command: 'node' }])) })).at(-1)!.includes('cap (100)'));
assert('permission rule array cap stated', manualSettings(JSON.stringify({ permissions: { allow: Array(101).fill('Bash') } })).some(value => value.includes('cap (100)')));
const noName = fixture('default-skill-name');
put(path.join(noName, '.claude/skills/folder/SKILL.md'), '---\ndescription: fallback name\n---\nbody');
assert('missing skill name maps to folder and actual loader discovers it', !applyClaudeImport(scanClaudeImport(noName)).failed && (await scanSkills(noName)).skills.some(skill => skill.name === 'folder'));
const both = fixture('project-global-name');
put(path.join(both, '.claude/skills/scope/SKILL.md'), doc('scope'));
put(path.join(HOME, '.claude/skills/scope/SKILL.md'), doc('scope'));
const bothPlan = scanClaudeImport(both);
assert('same source name across layers keeps project winner and states global conflict', bothPlan.writes.some(w => w.target === path.join(both, '.darwin/skills/scope/SKILL.md')) && !bothPlan.writes.some(w => w.target === path.join(HOME, '.darwin/skills/scope/SKILL.md')) && formatImportPlan(bothPlan).includes('no precedence override'));
const binary = fixture('binary');
put(path.join(binary, 'CLAUDE.md'), Buffer.from([0xff, 0xfe]));
assert('invalid UTF-8 instructions are manual, not lossy replacement', formatImportPlan(scanClaudeImport(binary)).includes('invalid UTF-8'));
const markerRoot = fixture('marker');
put(path.join(markerRoot, 'CLAUDE.md'), '<!-- darwin import claude-code:CLAUDE.md -->');
assert('source cannot forge import markers', formatImportPlan(scanClaudeImport(markerRoot)).includes('reserved import marker'));
const source = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');
for (const file of ['README.md', 'README.zh-CN.md', ...['getting-started', 'extensions', 'permissions', 'reference'].flatMap(name => [`docs/user-guide/${name}.md`, `docs/user-guide/${name}.zh-CN.md`])]) {
  assert(`${file} documents the exact CLI`, source(file).includes('darwin import --from claude-code'));
}
const visited = new Set<string>();
function graph(file: string): void {
  if (visited.has(file)) return;
  visited.add(file);
  const code = source(file);
  assert(`${file} has no runtime/SDK/model/process/network startup import`, !/from ['"](?:@strands|.*(?:runtime|config|workspace-trust)|node:(?:child_process|https?|net))/.test(code) && !/import\s*\(/.test(code));
  for (const match of code.matchAll(/from ['"](\.[^'"]+)['"]/g)) graph(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]!.replace(/\.js$/, '.ts'))));
}
graph('src/cli-import.ts');
assert('bootstrap routes import before cli-main', source('src/cli.ts').indexOf("args[0] === 'import'") < source('src/cli.ts').indexOf("await import('./cli-main.js')"));
assert('main grammar contains exact new CLI and no TUI route', CLI_USAGE.includes('darwin import --from claude-code [--apply]') && !source('src/tui/App.tsx').includes('runImportCli'));


report();
