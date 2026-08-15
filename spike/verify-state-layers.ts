/** Fast acceptance for global/project path, policy, resource, MCP and session layering. */
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadAgentDefinitions } from '../src/agents/loader.js';
import { loadCustomCommands } from '../src/commands/custom-commands.js';
import {
  appendAllowRule,
  ConfigError,
  configPath,
  loadConfig,
  loadProjectPolicy,
  permissionRulesPath,
  saveThinkingEffort,
} from '../src/config.js';
import { loadMcpClients } from '../src/mcp/registry.js';
import { projectKey, userDarwinDir } from '../src/paths.js';
import { resolveSession, sessionPaths } from '../src/agent/session.js';
import { scanSkills } from '../src/skills/loader.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-state-layers';
const A = path.join(ROOT, 'a-b');
const B = path.join(ROOT, 'a', 'b');

// This suite writes and deletes whole trees under ~/.darwin, so it must never run
// against the real home: HOME is repointed at an owned temp dir *before* any
// user-global path is derived, and the assertion below refuses to continue if
// something resolved a home earlier than this line.
const ORIGINAL_HOME = process.env['HOME'];
const OWNED_HOME = mkdtempSync(path.join(os.tmpdir(), 'darwin-state-layers-home-'));
process.env['HOME'] = OWNED_HOME;
const globalDir = userDarwinDir();

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function pathsAndConfig(): Promise<void> {
  header('state layers — global config and project identity');
  assert('user-global state resolves inside the suite\'s own HOME',
    globalDir.startsWith(`${OWNED_HOME}${path.sep}`) && configPath().startsWith(`${OWNED_HOME}${path.sep}`));
  assert('project-keyed user state resolves inside the suite\'s own HOME',
    permissionRulesPath(A).startsWith(`${OWNED_HOME}${path.sep}`));
  await Promise.all([mkdir(A, { recursive: true }), mkdir(B, { recursive: true })]);
  assert('collision-prone paths have distinct keys', projectKey(A) !== projectKey(B));
  assert('project keys stay below one filesystem component limit', projectKey(`${ROOT}/${'界'.repeat(300)}`).length <= 246);
  const alias = path.join(ROOT, 'alias-a');
  await symlink(A, alias);
  assert('symlink aliases share a canonical key', projectKey(alias) === projectKey(A));

  await write(configPath(), JSON.stringify({ model: 'global.anthropic.claude-opus-5', future: true }));
  await write(path.join(A, '.darwin', 'config.json'), JSON.stringify({ model: 'project.must.not.win' }));
  assert('global application config controls startup', (await loadConfig(A)).model === 'global.anthropic.claude-opus-5');
  await saveThinkingEffort(A, 'low');
  const persisted = JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
  assert('runtime persistence writes global config', persisted['thinkingEffort'] === 'low');
  assert('unknown global keys survive persistence', persisted['future'] === true);
  assert('project application config remains untouched', (await readFile(path.join(A, '.darwin', 'config.json'), 'utf8')).includes('project.must.not.win'));

  // Rules in the global file would silently apply to nothing: they are read from
  // project-keyed user state only, so the refusal has to name that file.
  await write(configPath(), JSON.stringify({ ...persisted, permissionRules: { allow: ['bash:global *'] } }));
  const rejected = await loadConfig(A).then(() => undefined, (error: unknown) => error);
  assert('global permission rules are refused with the project-scoped path',
    rejected instanceof ConfigError && rejected.message.includes(permissionRulesPath(A)));
  await write(configPath(), JSON.stringify(persisted));
}

async function policy(): Promise<void> {
  header('state layers — scoped rules and layered hooks');
  await write(path.join(A, '.darwin', 'config.json'), JSON.stringify({
    permissionRules: { allow: ['bash:legacy *'] },
  }));
  assert('legacy project rules load as fallback', (await loadProjectPolicy(A)).allowRules[0] === 'bash:legacy *');
  await appendAllowRule(A, 'bash:pnpm *');
  assert('accepted rules persist in project-keyed user state', permissionRulesPath(A).includes(projectKey(A)));
  assert('legacy and new rules are promoted together',
    JSON.stringify((await loadProjectPolicy(A)).allowRules) === '["bash:legacy *","bash:pnpm *"]');
  assert('another project receives no rules', (await loadProjectPolicy(B)).allowRules.length === 0);

  await write(path.join(globalDir, 'hooks.json'), JSON.stringify({
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'global-pre' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'global-post' }] }],
  }));
  await write(path.join(A, '.darwin', 'hooks.json'), JSON.stringify({
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'project-pre' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'project-post' }] }],
  }));
  const hooks = (await loadProjectPolicy(A)).hooks;
  assert('Pre hooks are global then project', hooks?.PreToolUse?.map((g) => g.hooks[0]?.command).join(',') === 'global-pre,project-pre');
  assert('Post hooks are project then global', hooks?.PostToolUse?.map((g) => g.hooks[0]?.command).join(',') === 'project-post,global-post');
}

async function resources(): Promise<void> {
  header('state layers — project resources override global resources');
  await write(path.join(globalDir, 'skills', 'layered', 'SKILL.md'), '---\nname: layered\ndescription: global\n---\nglobal\n');
  await write(path.join(A, '.darwin', 'skills', 'layered', 'SKILL.md'), '---\nname: layered\ndescription: project\n---\nproject\n');
  const skills = await scanSkills(A);
  assert('project skill overrides global name', skills.skills.find((s) => s.name === 'layered')?.description === 'project');
  assert('global skill is available in another project', (await scanSkills(B)).skills.some((s) => s.name === 'layered'));

  await write(path.join(globalDir, 'commands', 'layered.md'), 'global command');
  await write(path.join(A, '.darwin', 'commands', 'layered.md'), 'project command');
  assert('project command overrides global name', (await loadCustomCommands(A, [])).commands.find((c) => c.name === 'layered')?.content === 'project command');
  assert('global command is available in another project', (await loadCustomCommands(B, [])).commands.some((c) => c.name === 'layered'));

  const agent = (body: string) => `---\nname: layered\ndescription: ${body}\ntools: []\n---\n${body}\n`;
  await write(path.join(globalDir, 'agents', 'layered.md'), agent('global'));
  await write(path.join(A, '.darwin', 'agents', 'layered.md'), agent('project'));
  assert('project agent overrides global name', (await loadAgentDefinitions(A, [])).definitions.find((a) => a.name === 'layered')?.description === 'project');
  assert('global agent is available in another project', (await loadAgentDefinitions(B, [])).definitions.some((a) => a.name === 'layered'));
}

async function mcpAndSessions(): Promise<void> {
  header('state layers — MCP union and global sessions');
  const server = (command: string) => ({ command, args: [] });
  await write(path.join(globalDir, 'mcp.json'), JSON.stringify({ mcpServers: { global: server('true'), shared: server('false') } }));
  await write(path.join(A, '.darwin', 'mcp.json'), JSON.stringify({ mcpServers: { project: server('true'), shared: server('true') } }));
  const mcp = await loadMcpClients(A);
  assert('global and project MCP maps are unioned with collision replacement', mcp.clients.length === 3);
  await Promise.all(mcp.clients.map((client) => client.disconnect()));

  const paths = sessionPaths(A);
  assert('session state is global and project-keyed', paths.stateDir.startsWith(path.join(globalDir, 'sessions', projectKey(A))));
  const legacySnapshot = path.join(A, '.darwin', 'sessions', 'session', 'legacy', 'scopes', 'agent', 'darwin', 'snapshots', 'snapshot_latest.json');
  await write(legacySnapshot, '{}');
  const resolved = await resolveSession(A, { kind: 'id', sessionId: 'legacy' }, 'darwin');
  assert('explicit legacy session migrates copy-only', resolved.restoreRequested && resolved.sessionId === 'legacy');
  assert('legacy snapshot remains after migration', (await readFile(legacySnapshot, 'utf8')) === '{}');
  const copied = path.join(paths.sessionsDir, 'session', 'legacy', 'scopes', 'agent', 'darwin', 'snapshots', 'snapshot_latest.json');
  assert('legacy snapshot is copied into global storage', (await readFile(copied, 'utf8')) === '{}');
}

try {
  await rm(ROOT, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
  await pathsAndConfig();
  await policy();
  await resources();
  await mcpAndSessions();
} finally {
  // Only what this suite created: ROOT and the owned HOME. The original HOME is
  // restored even on failure, so a later import in the same process cannot be
  // pointed at a deleted directory.
  await rm(ROOT, { recursive: true, force: true });
  await rm(OWNED_HOME, { recursive: true, force: true });
  if (ORIGINAL_HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = ORIGINAL_HOME;
}
report();
