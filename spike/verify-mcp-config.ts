/**
 * Error paths in `.mcp.json` loading. No servers are started and no model is
 * called, so this covers what verify-mcp.ts (which needs a real server) cannot.
 *
 * Run: pnpm tsx spike/verify-mcp-config.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '../src/config.js';
import { loadMcpClients } from '../src/mcp/registry.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-mcp-config-errors';

async function withMcpJson(contents: string): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.mcp.json'), contents, 'utf8');
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

async function main(): Promise<void> {
  header('.mcp.json — malformed input is reported, not crashed on');
  await rm(ROOT, { recursive: true, force: true });

  const missing = await loadMcpClients(path.join(ROOT, 'no-such-project'));
  assert('a missing .mcp.json is not an error', missing.clients.length === 0);
  assert('no config path is reported when there is no file', missing.configPath === undefined);

  const badJson = await expectConfigError(
    'malformed JSON is a ConfigError',
    await withMcpJson('{ "mcpServers": '),
  );
  console.log(`  bad JSON  : ${badJson.split('\n')[0]}`);
  assert('the error names the file', badJson.includes('.mcp.json'));
  assert('the error shows the expected shape', badJson.includes('mcpServers'));

  const notObject = await expectConfigError(
    'a non-object config is a ConfigError',
    await withMcpJson('["everything"]'),
  );
  console.log(`  not object: ${notObject.split('\n')[0]}`);

  // A per-server problem is not a config-file problem. `continueOnError` means an
  // unset ${VAR} makes the SDK log and drop that one server; startup continues
  // with the rest. Recorded here because the drop is quiet — the SDK's log line is
  // written before Ink takes the screen, so the user mostly notices it as a lower
  // server count in the header.
  const unsetVarDir = await withMcpJson(
    '{ "mcpServers": { "remote": { "url": "https://example.com", ' +
      '"headers": { "Authorization": "Bearer ${DARWIN_DEFINITELY_UNSET}" } } } }',
  );
  const unsetVar = await loadMcpClients(unsetVarDir);
  assert('an unset ${VAR} does not abort startup', true);
  assert('the affected server is dropped', unsetVar.clients.length === 0);
  assert('the config path is still reported', unsetVar.configPath !== undefined);

  // A well-formed file must still load lazily, without connecting anything.
  const ok = await loadMcpClients(
    await withMcpJson('{ "mcpServers": { "noop": { "command": "true", "args": [] } } }'),
  );
  assert('a valid config yields a client', ok.clients.length === 1);
  assert('the config path is reported', ok.configPath?.endsWith('.mcp.json') === true);

  report();
}

await main();
