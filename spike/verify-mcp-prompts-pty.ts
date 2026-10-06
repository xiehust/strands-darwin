/**
 * SER-114 — MCP prompt commands through the real CLI in a pty. Free: no provider,
 * no network. The composer fixture model (`spike/fixtures/composer-yank-cli.ts`)
 * appends every model request's last user text to `model-calls`; the real stdio MCP
 * fixture (`spike/fixtures/prompts-mcp.mjs`) appends every message it receives to
 * its own log. Servers come from the owned HOME's `~/.darwin/mcp.json` (user layer,
 * so no trust modal), beside a prompt-less and a failing server.
 *
 * Proves: completion lists every built-in first and MCP prompts after every existing
 * entry (a custom command named `mcp__…` precedes them), with argument hint and an
 * escaped description; an explicit submission expands once and the exact text reaches
 * the model once; a usage error is a local notice with no server and no model call,
 * the draft returned; the omission notice; Ctrl+C cancels an in-flight fetch; a
 * busy-queued invocation expands at drain time; `/mcp` shows per-server prompt counts
 * without a request.
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-mcp-prompts-pty-'));
const cwd = path.join(root, 'project');
const home = path.join(root, 'home');
const logs = path.join(root, 'logs');
const fixture = path.join(REPO_ROOT, 'spike/fixtures/prompts-mcp.mjs');
await mkdir(path.join(cwd, '.darwin/commands'), { recursive: true });
await mkdir(path.join(home, '.darwin'), { recursive: true });
await mkdir(logs);
await writeFile(path.join(cwd, '.darwin/commands/mcp__prompts__collide.md'), 'CUSTOM COLLIDE BODY\n');
await writeFile(path.join(home, '.darwin/config.json'), '{}');
const server = (mode: string, log: string) => ({ command: process.execPath, args: [fixture, '--mode', mode, '--log', path.join(logs, log)] });
await writeFile(path.join(home, '.darwin/mcp.json'), JSON.stringify({
  mcpServers: { prompts: server('prompts', 'prompts.log'), plain: server('no-prompts', 'plain.log'), dead: server('fail', 'dead.log') },
}));

async function requests(log: string): Promise<{ method: string; params?: Record<string, unknown> }[]> {
  const file = path.join(logs, log);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const gets = async (name?: string) => (await requests('prompts.log')).filter((entry) => entry.method === 'prompts/get' && (name === undefined || entry.params?.['name'] === name)).length;
async function modelCalls(): Promise<string[]> {
  const file = path.join(cwd, 'model-calls');
  return existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const tui = startTui({
  cwd, cols: 220, rows: 60,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const settled = (predicate: () => boolean, label: string, timeoutMs = 20_000) => tui.waitUntil(predicate, { timeoutMs, settleMs: 100, label });
const promptRow = () => tui.frame.replaceAll('\r', '').split('\n').find((line) => line.startsWith('you>')) ?? '';
const clearDraft = async () => { tui.send('\u0015'); await settled(() => promptRow().trim() === 'you>', 'draft cleared'); };

header('SER-114 — MCP prompt commands in the real CLI');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
  assert('startup states the skipped prompts in the header', tui.frame.includes('conflicts with custom command /mcp__prompts__collide') && tui.frame.includes('conflicts with mcp prompt "name.with spaces"'));
  check.equal((await requests('prompts.log')).filter((entry) => entry.method === 'prompts/list').length, 1);
  check.equal((await requests('plain.log')).filter((entry) => entry.method.startsWith('prompts/')).length, 0);
  check.equal((await requests('dead.log')).filter((entry) => entry.method.startsWith('prompts/')).length, 0);
  assert('one prompts/list to the prompt server; zero prompt requests to the prompt-less and failed ones', true);

  tui.send('/');
  await settled(() => tui.frame.includes('  /workflow') || tui.frame.includes('❯ /workflow'), 'full command menu');
  assert('every built-in stays visible with MCP prompts present', BUILTIN_COMMAND_NAMES.every((name) => tui.frame.includes(`/${name} — `)));
  tui.send('mcp__');
  await settled(() => tui.frame.includes('/mcp__prompts__greet'), 'mcp prompt rows');
  const rows = tui.frame.split('\n').filter((line) => /^\s*(❯ )?\/mcp__/.test(line)).map((line) => line.trim().replace(/^❯ /, ''));
  assert('the custom command named mcp__… precedes every MCP prompt (lowest precedence)', rows[0] === '/mcp__prompts__collide' && rows[1] === '/mcp__prompts__greet — Say hello with no arguments.');
  assert('prompts in listing order', JSON.stringify(rows.slice(1, 4).map((row) => row.split(' ')[0])) === JSON.stringify(['/mcp__prompts__greet', '/mcp__prompts__review', '/mcp__prompts__conversation']));
  assert('a prompt row carries the argument hint and the escaped, single-line description',
    rows.some((row) => row === '/mcp__prompts__review — <file> [focus] · Review one file. [31m with controls'));
  await clearDraft();

  header('invocation, usage error, omission notice');
  tui.send('/mcp__prompts__review src/a.ts security\r');
  await settled(() => tui.screen.includes('loaded MCP prompt "/mcp__prompts__review" from server "prompts"') && tui.screen.includes('local answer'), 'expanded turn');
  await settled(() => promptRow().trim() === 'you>', 'idle again');
  assert('the exact expanded text reached the model once', JSON.stringify(await modelCalls()) === JSON.stringify(['Review src/a.ts focusing on security.']));

  const getsBefore = await gets();
  tui.send('/mcp__prompts__review\r');
  await settled(() => tui.screen.includes('missing required argument file; usage: /mcp__prompts__review <file> [focus]'), 'usage notice');
  await settled(() => promptRow().includes('/mcp__prompts__review'), 'draft returned');
  assert('usage error: local notice, draft returned, no server call, no model call', await gets() === getsBefore && (await modelCalls()).length === 1);
  await clearDraft();

  tui.send('/mcp__prompts__conversation\r');
  await settled(() => tui.screen.includes('loaded MCP prompt "/mcp__prompts__conversation" from server "prompts" (not sent: 1 assistant message, 1 non-text block)'), 'omission notice');
  await settled(() => (tui.screen.match(/local answer/g) ?? []).length >= 2 && promptRow().trim() === 'you>', 'second answer');
  assert('the omission is counted in one visible notice; user text only reached the model', (await modelCalls()).at(-1) === 'First user part.\n\nSecond user part.');

  header('cancel an in-flight fetch; queue an invocation for drain time');
  tui.send('/mcp__prompts__slow\r');
  for (let tries = 0; tries < 300 && await gets('slow') === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await settled(() => tui.frame.includes('working'), 'busy while fetching');
  tui.send('\u0003');
  await settled(() => tui.screen.includes('cancelled before mcp server "prompts" answered'), 'cancel notice');
  await settled(() => promptRow().includes('/mcp__prompts__slow'), 'cancelled draft returned');
  assert('Ctrl+C cancels the fetch, returns the draft, sends nothing', (await modelCalls()).length === 2);
  await clearDraft();

  tui.send('permission\r');
  await tui.waitFor('permission preparing', { timeoutMs: 30_000 });
  tui.send('/mcp__prompts__greet\r');
  await settled(() => tui.frame.includes('/mcp__prompts__greet') && promptRow().trim() === 'you>', 'queued while busy');
  assert('a busy submission queues without fetching', await gets('greet') === 0);
  await writeFile(path.join(cwd, 'release-permission'), '');
  await settled(() => tui.frame.includes('allow? y n'), 'permission prompt');
  tui.send('n');
  await settled(() => tui.screen.includes('loaded MCP prompt "/mcp__prompts__greet"'), 'drained expansion');
  await settled(() => (tui.screen.match(/local answer/g) ?? []).length >= 4 && promptRow().trim() === 'you>', 'drained turn');
  assert('the queued invocation expanded at drain time and was sent once', await gets('greet') === 1 &&
    (await modelCalls()).filter((text) => text === 'Say hello to the SER-114 fixture.').length === 1);

  header('/mcp — per-server prompt counts from the cache');
  const before = JSON.stringify(await Promise.all(['prompts.log', 'plain.log', 'dead.log'].map(requests)));
  tui.send('/mcp\r');
  await settled(() => tui.screen.includes('mcp servers (3)'), 'mcp report');
  assert('/mcp names the prompt count, skipped count and bounded names', tui.screen.includes('· 8 prompts (2 skipped): /mcp__prompts__greet, /mcp__prompts__review'));
  assert('/mcp sends no request to any server', JSON.stringify(await Promise.all(['prompts.log', 'plain.log', 'dead.log'].map(requests))) === before);

  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
  assert('clean exit', true);
} catch (error) {
  await writeFile(path.join(root, 'pty.raw'), tui.raw);
  console.error(`SER-114 pty artifacts: ${root}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}

report();
