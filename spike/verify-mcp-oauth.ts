/**
 * SER-107 — interactive OAuth login for remote MCP servers.
 *
 * Free suite: no model call, no external network, no real credentials. Everything talks to a fake
 * OAuth authorization server + MCP server bound to 127.0.0.1 in this process (and a second one to
 * prove origin confusion is refused), under a private HOME. Real files, real loopback sockets, real
 * `McpClient` connections through the SDK's own `authProvider` slot, and real `darwin` processes for
 * the CLI and the restart case.
 *
 * Requirement → check (each section header below):
 *   login callback / store / authenticated connect  ·  persistence across process restart  ·
 *   refresh (and its failure)  ·  never-logged-in session makes no OAuth request + 401 guidance  ·
 *   held project layer: no login / network / token access before trust  ·  SSRF + origin refusals
 *   (unit table and end-to-end)  ·  callback hardening (Host, state, iss, error, flood)  ·
 *   timeout / cancel / port-in-use  ·  token secrecy  ·  CLI grammar, trust and logout  ·
 *   static `auth` client-credentials pass-through  ·  config validation.
 *
 * Run: pnpm tsx spike/verify-mcp-oauth.ts
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { writeTrustDecision } from '../src/agent/workspace-trust.js';
import { mcpCommand } from '../src/cli-mcp.js';
import { CLI_USAGE } from '../src/cli-usage.js';
import { describeLoginFailure, runOAuthLogin, startLoopbackCallback } from '../src/mcp/oauth-login.js';
import {
  OAuthPolicyError,
  assertHostResolvesPublic,
  createGuardedFetch,
  isNonPublicAddress,
  validateOAuthUrl,
} from '../src/mcp/oauth-net.js';
import { resolveOAuthSettings, validateDiscoveryState, type OAuthServerSettings } from '../src/mcp/oauth-provider.js';
import { oauthRecordPath, oauthStoreDir, readOAuthRecord } from '../src/mcp/oauth-store.js';
import { disconnectAll, loadMcpClients, mcpServerStatuses } from '../src/mcp/registry.js';
import { formatMcpReport } from '../src/tui/mcp-format.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('mcp-oauth');
/** Absolute, because a child started in a scratch project directory cannot resolve `tsx` from there. */
const TSX = import.meta.resolve('tsx');
const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------------------------
// The fake authorization server + MCP server.
// ---------------------------------------------------------------------------------------------

interface FakeOptions {
  /** Where `resource_metadata` in the 401 challenge points (default: this server). */
  challengeMetadataUrl?: () => string;
  /** Overrides for the authorization-server metadata document. */
  metadata?: (base: string) => Record<string, unknown>;
  /** `resource` in the protected-resource metadata. */
  resource?: (base: string) => string;
  /** Extra query parameters the /authorize redirect carries back (e.g. `iss`). */
  callbackExtras?: (base: string) => Record<string, string>;
  /** Make /authorize answer with an OAuth error instead of a code. */
  denyAuthorize?: boolean;
  /** `token_type` the token endpoint reports. */
  tokenType?: string;
  /** Serve the MCP endpoint without authentication. */
  open?: boolean;
}

interface Fake {
  base: string;
  url: string;
  requests: string[];
  authHeaders: string[];
  grants: string[];
  /** Access tokens currently accepted by the MCP endpoint. */
  valid: Set<string>;
  /** Refresh tokens currently accepted by the token endpoint. */
  refreshValid: Set<string>;
  issued: { access: string[]; refresh: string[] };
  close(): Promise<void>;
}

async function startFake(options: FakeOptions = {}): Promise<Fake> {
  const requests: string[] = [];
  const authHeaders: string[] = [];
  const grants: string[] = [];
  const valid = new Set<string>();
  const refreshValid = new Set<string>();
  const issued = { access: [] as string[], refresh: [] as string[] };
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let counter = 0;
  let base = '';

  const readBody = (request: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  const json = (response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  const issue = (): { access_token: string; refresh_token: string; token_type: string; expires_in: number } => {
    counter += 1;
    const access = `access-${counter}`;
    const refresh = `refresh-${counter}`;
    valid.add(access);
    refreshValid.add(refresh);
    issued.access.push(access);
    issued.refresh.push(refresh);
    return { access_token: access, refresh_token: refresh, token_type: options.tokenType ?? 'Bearer', expires_in: 3600 };
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base);
    requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname === '/mcp') {
        const header = request.headers.authorization;
        if (header !== undefined) authHeaders.push(header);
        const token = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined;
        if (options.open !== true && (token === undefined || !valid.has(token))) {
          const metadataUrl = options.challengeMetadataUrl?.() ?? `${base}/.well-known/oauth-protected-resource`;
          response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`, 'content-type': 'text/plain' });
          response.end('unauthorized');
          return;
        }
        const body = request.method === 'POST' ? JSON.parse(await readBody(request)) : undefined;
        const mcp = new McpServer({ name: 'fake-oauth', version: '0.0.1' });
        mcp.registerTool('whoami', {}, () => ({ content: [{ type: 'text', text: 'authenticated' }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
        await mcp.connect(transport as never);
        await transport.handleRequest(request, response, body);
        return;
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(response, 200, { resource: options.resource?.(base) ?? `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(response, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
          ...options.metadata?.(base),
        });
      }
      if (url.pathname === '/register') {
        const body = JSON.parse(await readBody(request)) as { redirect_uris: string[] };
        return json(response, 201, { client_id: 'fake-client', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
      }
      if (url.pathname === '/authorize') {
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const target = new URL(redirect);
        if (options.denyAuthorize === true) {
          target.searchParams.set('error', 'access_denied');
        } else {
          const code = `code-${randomBytes(6).toString('hex')}`;
          codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect });
          target.searchParams.set('code', code);
          for (const [key, value] of Object.entries(options.callbackExtras?.(base) ?? {})) target.searchParams.set(key, value);
        }
        target.searchParams.set('state', state);
        response.writeHead(302, { location: target.href });
        response.end();
        return;
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(request));
        const grant = form.get('grant_type') ?? '';
        grants.push(grant);
        if (grant === 'authorization_code') {
          const record = codes.get(form.get('code') ?? '');
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
          if (record === undefined || record.challenge !== challenge || form.get('redirect_uri') !== record.redirect) {
            return json(response, 400, { error: 'invalid_grant' });
          }
          codes.delete(form.get('code') ?? '');
          return json(response, 200, issue());
        }
        if (grant === 'refresh_token') {
          const refresh = form.get('refresh_token') ?? '';
          if (!refreshValid.has(refresh)) return json(response, 400, { error: 'invalid_grant' });
          refreshValid.delete(refresh);
          return json(response, 200, issue());
        }
        if (grant === 'client_credentials') {
          const basic = request.headers.authorization ?? '';
          const ok = basic === `Basic ${Buffer.from('cc-client:cc-secret').toString('base64')}` || (form.get('client_id') === 'cc-client' && form.get('client_secret') === 'cc-secret');
          if (!ok) return json(response, 401, { error: 'invalid_client' });
          const { access_token, token_type, expires_in } = issue();
          return json(response, 200, { access_token, token_type, expires_in });
        }
        return json(response, 400, { error: 'unsupported_grant_type' });
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    url: `${base}/mcp`,
    requests,
    authHeaders,
    grants,
    valid,
    refreshValid,
    issued,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The "browser": follows the authorization URL; the fake redirects it to the loopback callback. */
async function browse(url: string): Promise<{ status: number; finalUrl: string }> {
  const response = await fetch(url, { redirect: 'follow' });
  await response.text();
  return { status: response.status, finalUrl: response.url };
}

function settingsFor(name: string, url: string, oauth: unknown = true, entry: Record<string, unknown> = {}): OAuthServerSettings {
  const settings = resolveOAuthSettings(name, { url, oauth, ...entry });
  if (settings === undefined) throw new Error('settings expected');
  return settings;
}

function freshProject(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `darwin-mcp-oauth-${label}-`));
}

function writeGlobalMcp(servers: Record<string, unknown>): void {
  mkdirSync(path.join(HOME, '.darwin'), { recursive: true });
  writeFileSync(path.join(HOME, '.darwin', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function writeProjectMcp(project: string, servers: Record<string, unknown>): void {
  mkdirSync(path.join(project, '.darwin'), { recursive: true });
  writeFileSync(path.join(project, '.darwin', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}

async function loginWith(settings: OAuthServerSettings, lines: string[] = [], extra: Partial<Parameters<typeof runOAuthLogin>[0]> = {}): Promise<void> {
  await runOAuthLogin({
    settings,
    timeoutMs: 10_000,
    log: (line) => lines.push(line),
    open: async (url) => {
      void browse(url);
      return true;
    },
    ...extra,
  });
}

/** Async on purpose: the fake servers live in this process, so a blocking spawn would deadlock. */
function runProcess(args: readonly string[], cwd: string = ROOT, onStderr?: (chunk: string) => void): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd, env: { ...process.env, HOME } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      onStderr?.(chunk.toString());
    });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const allLines: string[] = [];
const secrets = new Set<string>();

const OAUTH_PATHS = /\/\.well-known\/|\/register|\/authorize|\/token/;

// ---------------------------------------------------------------------------------------------
header('a session that never logged in makes no OAuth request and names the fix');
const fake = await startFake();
const project = freshProject('main');
writeGlobalMcp({ fake: { url: fake.url, oauth: true } });
{
  const { clients } = await loadMcpClients(project);
  assert('an oauth-opted server loads through the SDK authProvider slot as a McpClient', clients.length === 1 && clients[0]!.clientName === 'fake');
  const tools = await clients[0]!.listTools();
  assert('without a stored login the server contributes no tools', tools.length === 0);
  assert('the connection is reported failed', clients[0]!.connectionState === 'failed');
  assert('only the MCP endpoint was contacted: no discovery, registration, authorization or token request',
    fake.requests.length > 0 && fake.requests.every((entry) => entry.endsWith(' /mcp')) && !fake.requests.some((entry) => OAUTH_PATHS.test(entry)));
  const statuses = mcpServerStatuses(clients);
  assert('/mcp status says a login is required', statuses[0]?.auth === 'login-required');
  const text = formatMcpReport(statuses, { configPaths: [], overriddenServerNames: [], ignoredConfigPath: undefined, candidatePaths: [] });
  assert('the report names the exact command to run', text.includes('darwin mcp login fake'));
  assert('no token store was created by a session that never logged in', !existsSync(oauthStoreDir()));
  await disconnectAll(clients);
}
fake.requests.length = 0;

// ---------------------------------------------------------------------------------------------
header('login: loopback callback → token store → authenticated connect');
{
  const lines: string[] = [];
  await loginWith(settingsFor('fake', fake.url), lines);
  allLines.push(...lines);
  assert('the authorization URL was printed', lines.some((line) => line.includes('/authorize?')));
  assert('PKCE S256 and a state were sent', lines.some((line) => line.includes('code_challenge_method=S256') && line.includes('state=')));
  assert('the fake exchanged exactly one authorization code', fake.grants.join(',') === 'authorization_code');
  const read = await readOAuthRecord('fake', fake.url);
  assert('a record was stored for the server', read.status === 'ok');
  if (read.status === 'ok') {
    secrets.add(read.record.tokens!.access_token);
    secrets.add(read.record.tokens!.refresh_token!);
    assert('the stored token is the one the server issued', read.record.tokens!.access_token === 'access-1');
    assert('the record is bound to the exact server URL', read.record.serverUrl === fake.url);
    assert('the registered redirect is a 127.0.0.1 loopback callback', /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(read.record.redirectUrl));
  }
  const file = oauthRecordPath('fake');
  assert('the store directory is private (0700)', (statSync(oauthStoreDir()).mode & 0o777) === 0o700);
  assert('the record file is private (0600)', (statSync(file).mode & 0o777) === 0o600);
  assert('only the record is in the store (no temp files left)', readdirSync(oauthStoreDir()).length === 1);
  assert('no log line carries a token', ![...secrets].some((secret) => lines.some((line) => line.includes(secret))));

  fake.requests.length = 0;
  const { clients } = await loadMcpClients(project);
  const tools = await clients[0]!.listTools();
  assert('the stored login authenticates the connection', tools.length === 1 && tools[0]!.name.endsWith('whoami'));
  assert('the server saw the stored bearer token', fake.authHeaders.includes('Bearer access-1'));
  assert('no OAuth endpoint was contacted to connect', !fake.requests.some((entry) => OAUTH_PATHS.test(entry)));
  const statuses = mcpServerStatuses(clients);
  assert('/mcp reports connected and logged in', statuses[0]?.state === 'connected' && statuses[0].auth === 'logged-in');
  const text = formatMcpReport(statuses, { configPaths: [], overriddenServerNames: [], ignoredConfigPath: undefined, candidatePaths: [] });
  assert('the /mcp report carries no token', ![...secrets].some((secret) => text.includes(secret)));
  await disconnectAll(clients);
}

// ---------------------------------------------------------------------------------------------
header('persistence: a new process reuses the stored login');
{
  const script = `
    import { loadMcpClients } from ${JSON.stringify(path.join(ROOT, 'src/mcp/registry.ts'))};
    const { clients } = await loadMcpClients(${JSON.stringify(project)});
    const tools = await clients[0].listTools();
    console.log('TOOLS=' + tools.map((tool) => tool.name).join(','));
    await clients[0].disconnect();
  `;
  fake.requests.length = 0;
  fake.grants.length = 0;
  const result = await runProcess(['--import', 'tsx', '--input-type=module', '-e', script]);
  assert('the second process lists the tools with the stored token', /TOOLS=.*whoami/.test(result.stdout));
  assert('it made no login, registration or token request', !fake.requests.some((entry) => OAUTH_PATHS.test(entry)) && fake.grants.length === 0);
  assert('the child process printed no token', ![...secrets].some((secret) => result.stdout.includes(secret) || result.stderr.includes(secret)));
}

// ---------------------------------------------------------------------------------------------
header('refresh: an expired access token is refreshed and the store is updated');
{
  fake.valid.delete('access-1');
  fake.grants.length = 0;
  const before = await readOAuthRecord('fake', fake.url);
  const { clients } = await loadMcpClients(project);
  const tools = await clients[0]!.listTools();
  assert('the 401 is answered with a refresh and the connection succeeds', tools.length === 1 && fake.grants.join(',') === 'refresh_token');
  const after = await readOAuthRecord('fake', fake.url);
  assert('the refreshed token was persisted', after.status === 'ok' && after.record.tokens?.access_token === 'access-2');
  assert('the rotated refresh token was persisted', after.status === 'ok' && after.record.tokens?.refresh_token === 'refresh-2');
  assert('the login id survives a refresh', before.status === 'ok' && after.status === 'ok' && before.record.loginId === after.record.loginId);
  assert('the file stays private after rewrite', (statSync(oauthRecordPath('fake')).mode & 0o777) === 0o600);
  assert('/mcp still reports logged in', mcpServerStatuses(clients)[0]?.auth === 'logged-in');
  await disconnectAll(clients);
}

header('refresh failure: a revoked login asks for `darwin mcp login`, without a browser or registration');
{
  fake.valid.clear();
  fake.refreshValid.clear();
  fake.requests.length = 0;
  fake.grants.length = 0;
  const { clients } = await loadMcpClients(project);
  const tools = await clients[0]!.listTools();
  assert('the server contributes no tools', tools.length === 0 && clients[0]!.connectionState === 'failed');
  assert('the refresh was attempted once, and nothing was registered or authorized',
    fake.grants.join(',') === 'refresh_token' && !fake.requests.some((entry) => /\/register|\/authorize/.test(entry)));
  const statuses = mcpServerStatuses(clients);
  assert('/mcp says a login is required', statuses[0]?.auth === 'login-required');
  const text = formatMcpReport(statuses, { configPaths: [], overriddenServerNames: [], ignoredConfigPath: undefined, candidatePaths: [] });
  assert('and names the command', text.includes('darwin mcp login fake'));
  const after = await readOAuthRecord('fake', fake.url);
  assert('the dead tokens were dropped from the store, the registration kept', after.status === 'ok' && after.record.tokens === undefined && after.record.clientInformation !== undefined);
  await disconnectAll(clients);
}
// ---------------------------------------------------------------------------------------------
header('/mcp projection stays read-only: reading status connects nothing');
{
  const probe = await startFake();
  writeGlobalMcp({ probe: { url: probe.url, oauth: true } });
  const { clients } = await loadMcpClients(project);
  const statuses = mcpServerStatuses(clients);
  assert('a freshly loaded client is disconnected and stays so', statuses[0]?.state === 'disconnected' && clients[0]!.connectionState === 'disconnected');
  assert('reading the report made no request at all', probe.requests.length === 0);
  await probe.close();
  await disconnectAll(clients);
}

// ---------------------------------------------------------------------------------------------
header('SSRF and origin policy: address table');
{
  const nonPublic = ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '[::1]', 'not-an-ip'];
  const publicAddresses = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  for (const address of nonPublic) assert(`${address} is non-public`, isNonPublicAddress(address));
  for (const address of publicAddresses) assert(`${address} is public`, !isNonPublicAddress(address));

  const remote = { allowPrivate: false };
  const local = { allowPrivate: true };
  const refused = (raw: string, context = remote): boolean => {
    try {
      validateOAuthUrl(raw, 'test', context);
      return false;
    } catch (error) {
      return error instanceof OAuthPolicyError;
    }
  };
  for (const raw of ['http://example.com/x', 'https://user:pw@example.com/', 'https://example.com/#frag', 'ftp://example.com/', 'file:///etc/passwd',
    'javascript:alert(1)', 'not a url', 'https://127.0.0.1/', 'https://localhost/', 'https://foo.localhost/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data',
    'https://192.168.0.1:8443/', 'https://[::ffff:10.0.0.1]/', 'https://10.0.0.5/', `https://example.com/${'a'.repeat(3000)}`]) {
    assert(`remote server: ${raw.slice(0, 48)} is refused`, refused(raw));
  }
  assert('remote server: a public https URL passes', !refused('https://auth.example.com/authorize?client_id=x'));
  assert('local server: loopback http passes', !refused('http://127.0.0.1:8080/x', local) && !refused('http://localhost:1/', local));
  assert('local server: plain http to a non-loopback host is still refused', refused('http://example.com/', local) && refused('http://10.0.0.5/', local));
  assert('local server: credentials and fragments are still refused', refused('http://user@127.0.0.1/', local) && refused('http://127.0.0.1/#x', local));

  const remoteSettings = resolveOAuthSettings('r', { url: 'https://mcp.example.com/mcp', oauth: true })!;
  const asUrl = 'https://auth.example.com';
  const okMetadata = { issuer: asUrl, authorization_endpoint: `${asUrl}/authorize`, token_endpoint: `${asUrl}/token`, registration_endpoint: `${asUrl}/register`, response_types_supported: ['code'] };
  const check = (state: Record<string, unknown>): string | undefined => {
    try {
      validateDiscoveryState({ authorizationServerUrl: asUrl, ...state } as never, remoteSettings);
      return undefined;
    } catch (error) {
      return error instanceof OAuthPolicyError ? error.message : `unexpected ${String(error)}`;
    }
  };
  assert('a well-formed public discovery document passes', check({ authorizationServerMetadata: okMetadata }) === undefined);
  assert('an authorization server on the metadata-service address is refused', check({ authorizationServerUrl: 'https://169.254.169.254/' }) !== undefined);
  assert('a private token endpoint is refused', check({ authorizationServerMetadata: { ...okMetadata, token_endpoint: 'https://10.0.0.5/token' } }) !== undefined);
  assert('a token endpoint on another origin is refused', /different origin/.test(check({ authorizationServerMetadata: { ...okMetadata, token_endpoint: 'https://evil.example/token' } }) ?? ''));
  assert('a registration endpoint on another origin is refused', /different origin/.test(check({ authorizationServerMetadata: { ...okMetadata, registration_endpoint: 'https://evil.example/register' } }) ?? ''));
  assert('an authorization endpoint on another origin is refused', /different origin/.test(check({ authorizationServerMetadata: { ...okMetadata, authorization_endpoint: 'https://evil.example/authorize' } }) ?? ''));
  assert('an authorization endpoint with a javascript: scheme is refused', check({ authorizationServerMetadata: { ...okMetadata, authorization_endpoint: 'javascript:alert(1)' } }) !== undefined);
  assert('an issuer that is not the authorization server is refused', /issuer/.test(check({ authorizationServerMetadata: { ...okMetadata, issuer: 'https://evil.example' } }) ?? ''));
  assert('protected-resource metadata for another origin is refused', /different origin/.test(check({ authorizationServerMetadata: okMetadata, resourceMetadata: { resource: 'https://other.example/mcp' } }) ?? ''));
  assert('a resource-metadata URL on another origin is refused', /different origin/.test(check({ authorizationServerMetadata: okMetadata, resourceMetadataUrl: 'https://evil.example/.well-known/x' }) ?? ''));
}

header('SSRF: the guarded fetch');
{
  const misc = http.createServer((request, response) => {
    if (request.url === '/ftp') { response.writeHead(302, { location: 'ftp://example.com/' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else if (request.url === '/post') { response.writeHead(302, { location: '/ok' }); response.end(); }
    else if (request.url === '/big') { response.writeHead(200); response.end(Buffer.alloc(2 * 1024 * 1024, 65)); }
    else if (request.url === '/slow') { /* never answers */ }
    else if (request.url === '/ok') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('fine'); }
    else if (request.url === '/empty') { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => misc.listen(0, '127.0.0.1', resolve));
  const miscBase = `http://127.0.0.1:${(misc.address() as AddressInfo).port}`;
  const rejects = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try { await promise; return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const local = createGuardedFetch({ allowPrivate: true, timeoutMs: 400, maxBytes: 1024 * 1024 });
  assert('a local server answers normally', await (await local(`${miscBase}/ok`)).text() === 'fine');
  assert('a 204 has no body and does not throw', (await local(`${miscBase}/empty`)).status === 204);
  assert('a redirect to another scheme is refused', /scheme/.test(await rejects(local(`${miscBase}/ftp`)) ?? ''));
  assert('a redirect loop stops at the hop cap', /redirected more than/.test(await rejects(local(`${miscBase}/loop`)) ?? ''));
  assert('a redirect answering a POST is refused', /non-GET/.test(await rejects(local(`${miscBase}/post`, { method: 'POST', body: 'a=b' })) ?? ''));
  assert('an oversized response is refused', /exceeds/.test(await rejects(local(`${miscBase}/big`)) ?? ''));
  assert('a silent server times out', /timed out/.test(await rejects(local(`${miscBase}/slow`)) ?? ''));
  const controller = new AbortController();
  const cancelled = rejects(createGuardedFetch({ allowPrivate: true, timeoutMs: 5000, signal: controller.signal })(`${miscBase}/slow`));
  setTimeout(() => controller.abort(), 50);
  assert('an abort cancels an in-flight request', /cancelled/.test(await cancelled ?? ''));
  const remote = createGuardedFetch({ allowPrivate: false, timeoutMs: 400 });
  const hits = { count: 0 };
  misc.on('request', () => (hits.count += 1));
  assert('a remote-server fetch of a loopback URL is refused before connecting', /loopback\/private|scheme|plain http/.test(await rejects(remote(`${miscBase}/ok`)) ?? '') && hits.count === 0);
  assert('a remote-server fetch of the metadata address is refused', (await rejects(remote('https://169.254.169.254/latest/meta-data/'))) !== undefined);

  // A public-looking name that resolves to a private address (or rebinds there) is refused at the socket.
  const realLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const done = typeof options === 'function' ? (options as (...args: unknown[]) => void) : callback;
    setImmediate(() => done(null, [{ address: '127.0.0.1', family: 4 }]));
  }) as typeof dns.lookup;
  const realPromiseLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  try {
    const message = await rejects(createGuardedFetch({ allowPrivate: false, timeoutMs: 400 })('https://rebind.example.test/x'));
    assert('a name resolving to loopback is refused by the socket lookup hook', /resolves to a loopback\/private/.test(message ?? ''));
    let preflight: string | undefined;
    try { await assertHostResolvesPublic('rebind.example.test', { allowPrivate: false }); } catch (error) { preflight = (error as Error).message; }
    assert('the refresh pre-flight refuses the same name', /resolves to a loopback\/private/.test(preflight ?? ''));
    await assertHostResolvesPublic('rebind.example.test', { allowPrivate: true });
    assert('a local MCP server may resolve privately', true);
  } finally {
    (dns as { lookup: unknown }).lookup = realLookup;
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
  }
  misc.closeAllConnections();
  misc.close();
}

// ---------------------------------------------------------------------------------------------
header('config: the `oauth` key is validated');
{
  const bad = (entry: unknown): string | undefined => {
    try {
      resolveOAuthSettings('s', entry);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const url = 'https://mcp.example.com/mcp';
  assert('no oauth key means no OAuth', resolveOAuthSettings('s', { url }) === undefined && resolveOAuthSettings('s', { url, oauth: false }) === undefined);
  assert('non-object entries are ignored', resolveOAuthSettings('s', 'x') === undefined && resolveOAuthSettings('s', null) === undefined);
  const good = resolveOAuthSettings('s', { url, oauth: { scope: 'read write', clientId: 'abc', callbackPort: 8765 } });
  assert('scope, clientId and callbackPort are read', good?.scope === 'read write' && good.clientId === 'abc' && good.callbackPort === 8765 && good.allowPrivate === false);
  assert('a loopback MCP server allows private OAuth endpoints', resolveOAuthSettings('s', { url: 'http://127.0.0.1:9/mcp', oauth: true })?.allowPrivate === true);
  assert('allowPrivateNetwork is the explicit opt-in for an internal host', resolveOAuthSettings('s', { url, oauth: { allowPrivateNetwork: true } })?.allowPrivate === true);
  for (const [label, entry, needle] of [
    ['a string value', { url, oauth: 'yes' }, 'must be true or an object'],
    ['an array value', { url, oauth: [] }, 'must be true or an object'],
    ['an unknown key', { url, oauth: { token: 'x' } }, 'unknown key "token"'],
    ['no url', { oauth: true }, 'needs a "url"'],
    ['a stdio command', { command: 'x', url, oauth: true }, 'stdio'],
    ['the sse transport', { url, transport: 'sse', oauth: true }, 'streamable-http'],
    ['static auth', { url, oauth: true, auth: { clientId: 'a', clientSecret: 'b' } }, '"auth"'],
    ['an Authorization header', { url, oauth: true, headers: { authorization: 'Bearer x' } }, 'Authorization header'],
    ['plain http to a remote host', { url: 'http://mcp.example.com/mcp', oauth: true }, 'plain http'],
    ['credentials in the url', { url: 'https://u:p@mcp.example.com/mcp', oauth: true }, 'credentials'],
    ['a privileged callback port', { url, oauth: { callbackPort: 80 } }, 'callbackPort'],
    ['a fractional callback port', { url, oauth: { callbackPort: 8000.5 } }, 'callbackPort'],
    ['a quoted scope', { url, oauth: { scope: 'a"b' } }, 'scope'],
    ['an empty clientId', { url, oauth: { clientId: '' } }, 'clientId'],
    ['a non-boolean allowPrivateNetwork', { url, oauth: { allowPrivateNetwork: 'yes' } }, 'allowPrivateNetwork'],
    ['an unset variable in the url', { url: 'https://${DARWIN_OAUTH_UNSET_VAR}/mcp', oauth: true }, 'DARWIN_OAUTH_UNSET_VAR'],
  ] as const) {
    assert(`${label} is refused with a message naming it`, (bad(entry) ?? '').includes(needle));
  }
  process.env['DARWIN_OAUTH_TEST_HOST'] = 'mcp.example.com';
  assert('${VAR} in the url is interpolated like the SDK does', resolveOAuthSettings('s', { url: 'https://${DARWIN_OAUTH_TEST_HOST}/mcp', oauth: true })?.serverUrl.host === 'mcp.example.com');
}
// ---------------------------------------------------------------------------------------------
header('login refusals: discovery and callback documents that point somewhere else');
const evil = await startFake(); // a second origin that must never be contacted
const rejectMessage = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try { await promise; return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
async function refusal(name: string, options: FakeOptions): Promise<{ message: string | undefined; requests: string[]; record: string; evilHits: number; opened: boolean }> {
  const target = await startFake(options);
  evil.requests.length = 0;
  let opened = false;
  const message = await rejectMessage(loginWith(settingsFor(name, target.url), allLines, {
    timeoutMs: 3000,
    open: async (url) => { opened = true; void browse(url); return true; },
  }));
  const record = (await readOAuthRecord(name, target.url)).status;
  const result = { message, requests: [...target.requests], record, evilHits: evil.requests.length, opened };
  await target.close();
  return result;
}
{
  const cases: Array<[string, string, FakeOptions, RegExp]> = [
    ['token endpoint on another origin', 'r-token', { metadata: () => ({ token_endpoint: `${evil.base}/token` }) }, /different origin/],
    ['registration endpoint on another origin', 'r-register', { metadata: () => ({ registration_endpoint: `${evil.base}/register` }) }, /different origin/],
    ['authorization endpoint on another origin', 'r-authorize', { metadata: () => ({ authorization_endpoint: `${evil.base}/authorize` }) }, /different origin/],
    ['authorization endpoint with a javascript: scheme', 'r-js', { metadata: () => ({ authorization_endpoint: 'javascript:alert(1)' }) }, /scheme|valid|different origin/],
    ['issuer that is not the authorization server', 'r-issuer', { metadata: () => ({ issuer: 'https://evil.example' }) }, /issuer/],
    ['protected resource for another origin', 'r-resource', { resource: () => 'https://other.example/mcp' }, /different origin|does not match/],
    ['resource-metadata pointer to another origin', 'r-pointer', { challengeMetadataUrl: () => `${evil.base}/.well-known/oauth-protected-resource` }, /different origin/],
  ];
  for (const [label, name, options, expected] of cases) {
    const result = await refusal(name, options);
    assert(`${label}: login is refused (${result.message?.slice(0, 60)})`, result.message !== undefined && expected.test(result.message));
    assert(`${label}: nothing was registered, no browser opened, no record stored`,
      !result.requests.some((entry) => /\/register|\/authorize|\/token/.test(entry)) && !result.opened && result.record === 'absent');
    assert(`${label}: the other origin was never contacted`, result.evilHits === 0);
  }
  const wrongType = await refusal('r-mac', { tokenType: 'mac' });
  assert('a non-Bearer token response is refused and nothing is stored', /Bearer/.test(wrongType.message ?? '') && wrongType.record === 'absent');
  const badIss = await refusal('r-iss', { callbackExtras: () => ({ iss: 'https://evil.example' }) });
  assert('a callback whose iss is not the issuer is refused and nothing is stored', /iss/.test(badIss.message ?? '') && badIss.record === 'absent' && !badIss.requests.includes('POST /token'));
  const denied = await refusal('r-denied', { denyAuthorize: true });
  assert('an OAuth error at the callback ends the login without tokens', /access_denied/.test(denied.message ?? '') && denied.record === 'absent' && !denied.requests.includes('POST /token'));
  const anonymous = await refusal('r-open', { open: true });
  assert('a server that needs no login is reported, not "logged in"', /nothing to log in to/.test(anonymous.message ?? '') && anonymous.record === 'absent');
}

// ---------------------------------------------------------------------------------------------
header('loopback callback: bound to 127.0.0.1, one purpose, no reflection');
function rawRequest(port: number, method: string, url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: url, ...(host === undefined ? {} : { headers: { host } }) }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}
const refused = (port: number, host = '127.0.0.1'): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
{
  const callback = await startLoopbackCallback({ timeoutMs: 5000 });
  const port = Number(new URL(callback.redirectUrl).port);
  assert('the redirect URI is http://127.0.0.1:<port>/callback', callback.redirectUrl === `http://127.0.0.1:${port}/callback`);
  let settled = false;
  const waiting = callback.wait(() => 'STATE-1234').then((params) => { settled = true; return params; });
  assert('a foreign Host header (DNS rebinding) is refused', (await rawRequest(port, 'GET', '/callback?state=STATE-1234&code=x', 'evil.example:80')).status === 403);
  assert('another method is not found', (await rawRequest(port, 'POST', '/callback')).status === 404);
  assert('another path is not found', (await rawRequest(port, 'GET', '/other')).status === 404);
  assert('a wrong state is answered 400', (await rawRequest(port, 'GET', '/callback?state=wrong&code=x')).status === 400);
  assert('a missing state is answered 400', (await rawRequest(port, 'GET', '/callback?code=x')).status === 400);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert('none of those completed or aborted the login', !settled);
  const good = await rawRequest(port, 'GET', '/callback?state=STATE-1234&code=%3Cscript%3Ealert(1)%3C/script%3E');
  const params = await waiting;
  assert('the matching state completes the login with the code', good.status === 200 && params.get('code') === '<script>alert(1)</script>');
  assert('the page reflects nothing it received', !/script|alert|STATE-1234/.test(good.body));
  assert('a second callback is refused', (await rawRequest(port, 'GET', '/callback?state=STATE-1234&code=y')).status === 403);
  const external = Object.values(os.networkInterfaces()).flat().find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
  await callback.close();
  assert('the listener is gone after close', await refused(port) === 'ECONNREFUSED');

  const listening = await startLoopbackCallback({ timeoutMs: 5000 });
  const listeningPort = Number(new URL(listening.redirectUrl).port);
  const pending = listening.wait(() => 'S');
  pending.catch(() => undefined);
  if (external !== undefined) assert(`the listener is not reachable on ${external.address} (loopback only)`, await refused(listeningPort, external.address) === 'ECONNREFUSED');
  else assert('no external interface on this host; loopback-only bind holds by construction', true);
  for (let index = 0; index < 26; index += 1) await rawRequest(listeningPort, 'GET', '/callback', 'evil.example').catch(() => undefined);
  assert('flooding the callback cancels the login', /too many requests/.test(await rejectMessage(pending) ?? ''));
  await listening.close();

  const shortLived = await startLoopbackCallback({ timeoutMs: 150 });
  assert('no callback within the deadline times out', /timed out/.test(await rejectMessage(shortLived.wait(() => 's')) ?? ''));
  await shortLived.close();
  const controller = new AbortController();
  const abortable = await startLoopbackCallback({ timeoutMs: 5000, signal: controller.signal });
  const aborted = rejectMessage(abortable.wait(() => 's'));
  setTimeout(() => controller.abort(), 30);
  assert('an abort cancels the wait', /cancelled/.test(await aborted ?? ''));
  await abortable.close();
}

header('login lifecycle: timeout, cancel, occupied port, closed browser');
{
  const lifecycle = await startFake();
  let redirectPort = 0;
  const portOf = (url: string) => Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
  const timedOut = await rejectMessage(loginWith(settingsFor('l-timeout', lifecycle.url), [], { timeoutMs: 300, open: async (url) => { redirectPort = portOf(url); return true; } }));
  assert('a login nobody completes times out', /timed out/.test(timedOut ?? ''));
  assert('its callback listener is closed afterwards', await refused(redirectPort) === 'ECONNREFUSED');
  assert('nothing was exchanged or stored', !lifecycle.grants.includes('authorization_code') && (await readOAuthRecord('l-timeout', lifecycle.url)).status === 'absent');

  const controller = new AbortController();
  const cancelled = await rejectMessage(loginWith(settingsFor('l-cancel', lifecycle.url), [], {
    signal: controller.signal, timeoutMs: 10_000, open: async (url) => { redirectPort = portOf(url); setTimeout(() => controller.abort(), 30); return true; },
  }));
  assert('an abort (Ctrl+C) cancels the login', /cancelled/.test(cancelled ?? ''));
  assert('the listener is closed after the cancel and nothing is stored', await refused(redirectPort) === 'ECONNREFUSED' && (await readOAuthRecord('l-cancel', lifecycle.url)).status === 'absent');

  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const busyPort = (occupied.address() as AddressInfo).port;
  const busy = await rejectMessage(loginWith(settingsFor('l-busy', lifecycle.url, { callbackPort: busyPort }), [], { timeoutMs: 2000 }));
  assert('a callback port already in use is reported', /already in use/.test(busy ?? ''));
  occupied.close();

  let badStatus = 0;
  await loginWith(settingsFor('l-badstate', lifecycle.url), allLines, {
    open: async (url) => {
      badStatus = (await rawRequest(portOf(url), 'GET', '/callback?state=bogus&code=zzz')).status;
      void browse(url);
      return true;
    },
  });
  assert('a stray callback with the wrong state is ignored and the real login still completes', badStatus === 400 && (await readOAuthRecord('l-badstate', lifecycle.url)).status === 'ok');

  const manualLines: string[] = [];
  await loginWith(settingsFor('l-manual', lifecycle.url), manualLines, {
    open: async () => false,
    log: (line) => {
      manualLines.push(line);
      const match = /(http:\/\/\S+\/authorize\?\S+)/.exec(line);
      if (match !== null) void browse(match[1]!);
    },
  });
  assert('when no browser can be opened the URL is still printed and a manual visit completes the login',
    manualLines.some((line) => /Could not open a browser/.test(line)) && (await readOAuthRecord('l-manual', lifecycle.url)).status === 'ok');
  const registrations = lifecycle.requests.filter((entry) => entry === 'POST /register').length;
  assert('each login registers a fresh public client (no reuse of a stale redirect)', registrations >= 3);
  await lifecycle.close();
}

// ---------------------------------------------------------------------------------------------
header('workspace trust: a held project layer triggers no login, network or token access');
const projectFake = await startFake();
const heldProject = freshProject('held');
writeGlobalMcp({ fake: { url: fake.url, oauth: true } });
writeProjectMcp(heldProject, { proj: { url: projectFake.url, oauth: true } });
{
  await loginWith(settingsFor('proj', projectFake.url), allLines); // a login made earlier, e.g. in a trusted session
  const seeded = await readOAuthRecord('proj', projectFake.url);
  projectFake.requests.length = 0;
  projectFake.authHeaders.length = 0;
  const held = await loadMcpClients(heldProject, { projectLayer: 'held' });
  assert('the held layer contributes no client (no provider, no store read, no connection)', held.clients.map((client) => client.clientName).join(',') === 'fake');
  assert('the project server received no request while held', projectFake.requests.length === 0);
  await disconnectAll(held.clients);

  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text), timeoutMs: 10_000, open: async (url: string) => { void browse(url); return true; } };
  const undecided = await mcpCommand(heldProject, ['login', 'proj'], io);
  assert('login for a project-declared server is refused while trust is undecided', undecided === 1 && /not trusted/.test(err.join('')));
  assert('the refusal says nothing was contacted and how to proceed', /Nothing was contacted/.test(err.join('')) && /trust the workspace/.test(err.join('')));
  await writeTrustDecision(heldProject, false);
  err.length = 0;
  assert('login is refused after an explicit "do not trust" too', (await mcpCommand(heldProject, ['login', 'proj'], io)) === 1 && /not trusted/.test(err.join('')));
  assert('neither refusal touched the server or the stored login',
    projectFake.requests.length === 0 && (await readOAuthRecord('proj', projectFake.url)).status === 'ok' &&
    JSON.stringify((await readOAuthRecord('proj', projectFake.url))) === JSON.stringify(seeded));

  await writeTrustDecision(heldProject, true);
  err.length = 0;
  const trusted = await mcpCommand(heldProject, ['login', 'proj'], io);
  assert('once the workspace is trusted the same command logs in', trusted === 0 && /logged in to proj/.test(out.join('')));
  assert('and contacted the server', projectFake.requests.includes('GET /authorize') || projectFake.requests.some((entry) => entry.endsWith('/authorize')));
  const armed = await loadMcpClients(heldProject);
  assert('an armed session loads the project server and connects with its login', armed.clients.length === 2 && (await armed.clients.find((client) => client.clientName === 'proj')!.listTools()).length === 1);
  await disconnectAll(armed.clients);
  await projectFake.close();
}

// ---------------------------------------------------------------------------------------------
header('CLI grammar, refusals and logout (in process)');
{
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text), timeoutMs: 2000 };
  const usageCases: string[][] = [[], ['login'], ['login', '--no-browser'], ['logout'], ['bogus', 'x'], ['login', 'a', '--bogus'], ['logout', 'a', '--no-browser'], ['login', 'a', 'b']];
  for (const argv of usageCases) {
    err.length = 0;
    const code = await mcpCommand(project, argv, io);
    assert(`darwin mcp ${argv.join(' ')}`.trim() + ' is a usage error (exit 2, shared hint)', code === 2 && /usage: darwin mcp login <name> \[--no-browser\] \| darwin mcp logout <name>/.test(err.join('')) && err.join('').includes('Run `darwin --help` for usage.'));
  }
  writeGlobalMcp({
    fake: { url: fake.url, oauth: true },
    plain: { url: fake.url },
    stdio: { command: 'node', oauth: true },
    weird: { url: fake.url, oauth: { bogus: 1 } },
  });
  const requestsBefore = fake.requests.length;
  const cases: Array<[string, string, RegExp]> = [
    ['nosuch', 'an unknown server', /no MCP server named "nosuch"/],
    ['plain', 'a server without an oauth entry', /has no "oauth" entry/],
    ['stdio', 'a stdio server', /stdio/],
    ['weird', 'a malformed oauth entry', /unknown key "bogus"/],
  ];
  for (const [name, label, expected] of cases) {
    err.length = 0;
    const code = await mcpCommand(project, ['login', name], io);
    assert(`${label} is refused (exit 1) with a one-line reason`, code === 1 && expected.test(err.join('')));
  }
  assert('none of those refusals contacted the server', fake.requests.length === requestsBefore);
  const badProject = freshProject('bad');
  writeFileSync(path.join(HOME, '.darwin', 'mcp.json'), '{ not json');
  err.length = 0;
  assert('a malformed global config is a one-line error, not a crash', (await mcpCommand(badProject, ['login', 'fake'], io)) === 1 && /could not be loaded/.test(err.join('')));
  writeGlobalMcp({ fake: { url: fake.url, oauth: true } });

  out.length = 0;
  assert('logout removes a stored login', (await mcpCommand(project, ['logout', 'l-manual'], io)) === 0 && /logged out of l-manual/.test(out.join('')) && (await readOAuthRecord('l-manual', fake.url)).status === 'absent');
  out.length = 0;
  assert('logout with nothing stored says so and succeeds', (await mcpCommand(project, ['logout', 'l-manual'], io)) === 0 && /no stored login for l-manual/.test(out.join('')));
}

header('CLI grammar and login (real darwin processes)');
{
  const cliPath = path.join(ROOT, 'src/cli.ts');
  const help = await runProcess(['--import', TSX, cliPath, 'mcp', '--help']);
  assert('`darwin mcp --help` prints the shared usage, which lists both verbs', help.status === 0 && help.stdout === CLI_USAGE && help.stdout.includes('darwin mcp login <name> [--no-browser]') && help.stdout.includes('darwin mcp logout <name>'));
  const bare = await runProcess(['--import', TSX, cliPath, 'mcp']);
  assert('`darwin mcp` alone is exit 2 with the usage hint', bare.status === 2 && bare.stderr.includes('usage: darwin mcp login'));

  const cliFake = await startFake();
  writeGlobalMcp({ cli: { url: cliFake.url, oauth: { scope: 'tools' } } });
  const cliProject = freshProject('cli');
  let browsed = false;
  const login = await runProcess(['--import', TSX, cliPath, 'mcp', 'login', 'cli', '--no-browser'], cliProject, (chunk) => {
    const match = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(chunk);
    if (match !== null && !browsed) {
      browsed = true;
      void browse(match[1]!);
    }
  });
  assert('the real process completes a login with --no-browser and exits 0', login.status === 0 && /logged in to cli/.test(login.stdout));
  assert('it printed the authorization URL, carrying the configured scope', login.stderr.includes('/authorize?') && login.stderr.includes('scope=tools'));
  assert('it printed no token', !/(access|refresh)-\d/.test(login.stdout + login.stderr));
  const read = await readOAuthRecord('cli', cliFake.url);
  assert('the login is stored for the server', read.status === 'ok');
  allLines.push(login.stdout, login.stderr);

  const logout = await runProcess(['--import', TSX, cliPath, 'mcp', 'logout', 'cli'], cliProject);
  assert('the real logout removes it', logout.status === 0 && /logged out of cli/.test(logout.stdout) && (await readOAuthRecord('cli', cliFake.url)).status === 'absent');
  await cliFake.close();
}

// ---------------------------------------------------------------------------------------------
header('token store: bound to the server URL, hostile files, concurrent logins');
{
  const first = await startFake();
  const second = await startFake();
  await loginWith(settingsFor('moved', first.url), allLines);
  writeGlobalMcp({ moved: { url: second.url, oauth: true } });
  assert('a record issued for one URL reads as a mismatch for another', (await readOAuthRecord('moved', second.url)).status === 'mismatch');
  const { clients } = await loadMcpClients(project);
  await clients[0]!.listTools();
  assert('a same-named server at a different URL never receives the old token', second.authHeaders.length === 0);
  assert('and it only saw the MCP endpoint, no OAuth request', second.requests.every((entry) => entry.endsWith(' /mcp')));
  assert('the session reports it needs a login', mcpServerStatuses(clients)[0]?.auth === 'login-required');
  await disconnectAll(clients);

  mkdirSync(oauthStoreDir(), { recursive: true });
  writeFileSync(oauthRecordPath('corrupt'), '{ nope');
  writeFileSync(oauthRecordPath('huge'), JSON.stringify({ pad: 'x'.repeat(70 * 1024) }));
  writeFileSync(oauthRecordPath('shape'), JSON.stringify({ version: 1, server: 'shape' }));
  symlinkSync('/etc/hostname', oauthRecordPath('linked'));
  for (const name of ['corrupt', 'huge', 'shape', 'linked']) {
    const result = await readOAuthRecord(name, second.url);
    assert(`a ${name} record file reads as invalid, never as a login`, result.status === 'invalid');
  }
  writeGlobalMcp(Object.fromEntries(['corrupt', 'huge', 'shape', 'linked'].map((name) => [name, { url: second.url, oauth: true }])));
  second.authHeaders.length = 0;
  const hostile = await loadMcpClients(project);
  for (const client of hostile.clients) await client.listTools();
  assert('sessions over hostile record files send no token and stay non-interactive',
    second.authHeaders.length === 0 && second.requests.every((entry) => entry.endsWith(' /mcp')) && hostile.clients.every((client) => client.connectionState === 'failed'));
  await disconnectAll(hostile.clients);

  // A record whose stored endpoints fail the policy is not adopted (a hand-edited or tampered file).
  const { writeOAuthRecord } = await import('../src/mcp/oauth-store.js');
  await writeOAuthRecord({
    version: 1, server: 'tamper', serverUrl: 'https://mcp.example.test/mcp', loginId: 'x', savedAt: new Date().toISOString(), redirectUrl: 'http://127.0.0.1:1/callback',
    tokens: { access_token: 'tamper-token', token_type: 'Bearer' },
    discovery: { authorizationServerUrl: 'https://auth.example.test', authorizationServerMetadata: { issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/a', token_endpoint: 'https://169.254.169.254/token', response_types_supported: ['code'] }, resourceIndicator: false },
  });
  writeGlobalMcp({ tamper: { url: 'https://mcp.example.test/mcp', oauth: true } });
  const tampered = await loadMcpClients(project);
  assert('a stored login whose token endpoint is the metadata address is not adopted', mcpServerStatuses(tampered.clients)[0]?.auth === 'not-logged-in');
  await disconnectAll(tampered.clients);

  // A refresh in an old session must not overwrite a login completed elsewhere since.
  const raceFake = await startFake();
  await loginWith(settingsFor('race', raceFake.url), allLines);
  const firstRecord = await readOAuthRecord('race', raceFake.url);
  writeGlobalMcp({ race: { url: raceFake.url, oauth: true } });
  const oldSession = await loadMcpClients(project);
  await loginWith(settingsFor('race', raceFake.url), allLines); // "another terminal"
  const newerRecord = await readOAuthRecord('race', raceFake.url);
  raceFake.valid.delete(firstRecord.status === 'ok' ? firstRecord.record.tokens!.access_token : '');
  const listed = await oldSession.clients[0]!.listTools();
  const afterRace = await readOAuthRecord('race', raceFake.url);
  assert('the old session still refreshed and connected', listed.length === 1);
  assert('but the newer login on disk was not overwritten',
    newerRecord.status === 'ok' && afterRace.status === 'ok' && afterRace.record.loginId === newerRecord.record.loginId && afterRace.record.tokens?.access_token === newerRecord.record.tokens?.access_token);
  await disconnectAll(oldSession.clients);
  await raceFake.close();
  assert('no temporary files were left in the store', !readdirSync(oauthStoreDir()).some((file) => file.endsWith('.tmp')));
  await first.close();
  await second.close();
}

// ---------------------------------------------------------------------------------------------
header('static `auth` client-credentials stays an SDK pass-through, next to OAuth servers');
{
  const staticFake = await startFake();
  const other = await startFake();
  writeGlobalMcp({
    a: { url: other.url, oauth: true },
    off: { url: other.url, oauth: true, disabled: true },
    b: { url: staticFake.url, auth: { clientId: 'cc-client', clientSecret: 'cc-secret', scopes: ['tools'] } },
    c: { url: other.url, oauth: true },
  });
  const { clients } = await loadMcpClients(project);
  assert('clients keep the declared order and a disabled OAuth entry is skipped', clients.map((client) => client.clientName).join(',') === 'a,b,c');
  const tools = await clients[1]!.listTools();
  assert('the static-auth server connects through the SDK client-credentials provider', tools.length === 1 && staticFake.grants.includes('client_credentials'));
  assert('it used the configured secret, not a darwin login', staticFake.authHeaders.some((value) => value.startsWith('Bearer access-')));
  const statuses = mcpServerStatuses(clients);
  assert('/mcp carries no OAuth login state for a static-auth server', statuses[1]?.auth === undefined && statuses[0]?.auth !== undefined);
  assert('no darwin token record was created for it', !existsSync(oauthRecordPath('b')));
  await disconnectAll(clients);
  await staticFake.close();
  await other.close();
}

// ---------------------------------------------------------------------------------------------
header('secrecy and scope: no token in output, no other state written, no logging in the modules');
{
  const redacted = describeLoginFailure(new Error('HTTP 400: Raw body: {"access_token":"access-99","refresh_token":"refresh-99","code":"c0de","note":"x"} Authorization: Bearer abc.def-123\nnext'));
  assert('printed failures redact credential-shaped fields and bearer values', !/access-99|refresh-99|c0de|abc\.def/.test(redacted) && redacted.includes('[redacted]') && !redacted.includes('\n'));
  assert('printed failures are bounded', describeLoginFailure(new Error('x'.repeat(5000))).length <= 300);
  const leaked = allLines.filter((line) => /(access|refresh)-\d+/.test(line));
  assert('no captured login/CLI output contains a token', leaked.length === 0);
  const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? tree(path.join(dir, entry.name)).map((child) => `${entry.name}/${child}`) : [entry.name]);
  const top = readdirSync(path.join(HOME, '.darwin'));
  assert('the only darwin state written is config, the token store and the trust decision', top.every((entry) => ['mcp.json', 'mcp-auth', 'projects'].includes(entry)));
  assert('no trajectory, session or memory file exists', !tree(path.join(HOME, '.darwin')).some((file) => /trajectory|session|memory|\.jsonl/.test(file)));
  const code = (file: string) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const engine = ['oauth-net.ts', 'oauth-store.ts', 'oauth-provider.ts', 'oauth-login.ts'].map((file) => code(`src/mcp/${file}`));
  assert('the OAuth engine never logs or writes streams (no console, logger, process.std*, trajectory, append)', engine.every((text) => !/console\.|logger|process\.std|trajectory|appendFile/.test(text)));
  assert('the CLI writes only through its injected streams and never logs or records', !/console\.|logger|trajectory|appendFile/.test(code('src/cli-mcp.ts')));
  const mcpFormat = readFileSync(path.join(ROOT, 'src/tui/mcp-format.ts'), 'utf8');
  assert('/mcp formatting has no token or store access', !/oauth-store|tokens|access_token/.test(mcpFormat));
}
await evil.close();
await fake.close();
report();
