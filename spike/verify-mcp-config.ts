/**
 * Config resolution and error paths in MCP loading: which of the two accepted
 * files wins, and what a malformed one does. No servers are started and no model
 * is called, so this covers what verify-mcp.ts (which needs a real server) cannot.
 *
 * Run: pnpm tsx spike/verify-mcp-config.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '../src/config.js';
import { MCP_CONFIG_FILENAME, ROOT_MCP_CONFIG_FILENAME, loadMcpClients } from '../src/mcp/registry.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-mcp-config-errors';

const ONE_SERVER = '{ "mcpServers": { "noop": { "command": "true", "args": [] } } }';
const TWO_SERVERS =
  '{ "mcpServers": { "a": { "command": "true", "args": [] }, "b": { "command": "true", "args": [] } } }';

function caseDir(): string {
  return path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
}

/** Writes the project-root fallback, i.e. a file Claude Code would have written. */
async function withRootMcpJson(contents: string): Promise<string> {
  const dir = caseDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ROOT_MCP_CONFIG_FILENAME), contents, 'utf8');
  return dir;
}

/** Writes darwin's own `.darwin/mcp.json`. */
async function withDarwinMcpJson(dir: string, contents: string): Promise<string> {
  await mkdir(darwinDir(dir), { recursive: true });
  await writeFile(path.join(darwinDir(dir), MCP_CONFIG_FILENAME), contents, 'utf8');
  return dir;
}

async function expectConfigError(what: string, dir: string): Promise<string> {
  try {
    await loadMcpClients(dir);
    assert(what, false);
    return '';
  } catch (error) {
    assert(what, error instanceof ConfigError);
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Two files are accepted and exactly one is read. Asserted here rather than in
 * verify-mcp.ts because precedence is a filesystem decision: it must hold whether
 * or not the servers it names can actually start.
 */
async function configPrecedence(): Promise<void> {
  header('MCP config — .darwin/mcp.json wins, root .mcp.json is the fallback');

  const fallbackOnly = await withRootMcpJson(ONE_SERVER);
  const fallback = await loadMcpClients(fallbackOnly);
  console.log(`  fallback : ${fallback.configPath}`);
  assert('a root .mcp.json alone is used', fallback.configPath?.endsWith(ROOT_MCP_CONFIG_FILENAME) === true);
  assert('its servers are loaded', fallback.clients.length === 1);
  assert('nothing is reported as ignored', fallback.ignoredConfigPath === undefined);

  const preferredOnly = await withDarwinMcpJson(caseDir(), ONE_SERVER);
  const preferred = await loadMcpClients(preferredOnly);
  console.log(`  preferred: ${preferred.configPath}`);
  assert(
    '.darwin/mcp.json alone is used',
    preferred.configPath === path.join(darwinDir(preferredOnly), MCP_CONFIG_FILENAME),
  );
  assert('its servers are loaded', preferred.clients.length === 1);
  assert('nothing is reported as ignored', preferred.ignoredConfigPath === undefined);

  // Both present: the server count proves which file was actually read, not just
  // which path was reported.
  const both = await withDarwinMcpJson(await withRootMcpJson(TWO_SERVERS), ONE_SERVER);
  const resolved = await loadMcpClients(both);
  console.log(`  both     : read ${resolved.configPath}, ignored ${resolved.ignoredConfigPath}`);
  assert(
    'with both present .darwin/mcp.json is read',
    resolved.configPath === path.join(darwinDir(both), MCP_CONFIG_FILENAME),
  );
  assert('the root file is reported as ignored', resolved.ignoredConfigPath === path.join(both, ROOT_MCP_CONFIG_FILENAME));
  assert('only the winning file contributed servers', resolved.clients.length === 1);

  // Precedence has to hold when the preferred file is broken, too. Falling back
  // would start servers the user did not ask for and bury the typo they need to
  // see — the file that was chosen is the file whose errors get reported.
  const brokenPreferred = await withDarwinMcpJson(await withRootMcpJson(ONE_SERVER), '{ "mcpServers": ');
  const message = await expectConfigError(
    'a malformed .darwin/mcp.json is an error rather than a silent fall back to the root file',
    brokenPreferred,
  );
  assert(
    'the error names the file that took precedence',
    message.includes(path.join(darwinDir(brokenPreferred), MCP_CONFIG_FILENAME)),
  );
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await configPrecedence();

  header('MCP config — malformed input is reported, not crashed on');

  const missing = await loadMcpClients(path.join(ROOT, 'no-such-project'));
  assert('no MCP config at all is not an error', missing.clients.length === 0);
  assert('no config path is reported when there is no file', missing.configPath === undefined);

  const badJson = await expectConfigError(
    'malformed JSON is a ConfigError',
    await withRootMcpJson('{ "mcpServers": '),
  );
  console.log(`  bad JSON  : ${badJson.split('\n')[0]}`);
  assert('the error names the file', badJson.includes('.mcp.json'));
  assert('the error shows the expected shape', badJson.includes('mcpServers'));

  const notObject = await expectConfigError(
    'a non-object config is a ConfigError',
    await withRootMcpJson('["everything"]'),
  );
  console.log(`  not object: ${notObject.split('\n')[0]}`);

  // A per-server problem is not a config-file problem. `continueOnError` means an
  // unset ${VAR} makes the SDK log and drop that one server; startup continues
  // with the rest. Recorded here because the drop is quiet — the SDK's log line is
  // written before Ink takes the screen, so the user mostly notices it as a lower
  // server count in the header.
  const unsetVarDir = await withRootMcpJson(
    '{ "mcpServers": { "remote": { "url": "https://example.com", ' +
      '"headers": { "Authorization": "Bearer ${DARWIN_DEFINITELY_UNSET}" } } } }',
  );
  const unsetVar = await loadMcpClients(unsetVarDir);
  assert('an unset ${VAR} does not abort startup', true);
  assert('the affected server is dropped', unsetVar.clients.length === 0);
  assert('the config path is still reported', unsetVar.configPath !== undefined);

  // A well-formed file must still load lazily, without connecting anything.
  const ok = await loadMcpClients(
    await withRootMcpJson('{ "mcpServers": { "noop": { "command": "true", "args": [] } } }'),
  );
  assert('a valid config yields a client', ok.clients.length === 1);
  assert('the config path is reported', ok.configPath?.endsWith('.mcp.json') === true);

  report();
}

await main();
