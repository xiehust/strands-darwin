/**
 * MCP OAuth for remote servers (SER-107): the SDK `OAuthClientProvider` darwin hands to
 * `McpClientConfig.authProvider`, and the per-server settings that opt a server into it.
 *
 * The flow itself — discovery, dynamic registration, PKCE, code exchange, refresh — is the MCP
 * SDK's own `auth()`; this file only supplies what the SDK asks a provider for, and draws the
 * boundary around it. The provider runs in two modes that share one class so they cannot drift:
 *
 * - `login` (`darwin mcp login`): interactive, in memory until the login completes, every request
 *   through the guarded fetch, the authorization URL handed to a callback (the browser).
 * - `runtime` (a normal session): non-interactive, backed by the stored record. It has no way to
 *   open a browser or register a client; when a 401 needs a fresh login it raises
 *   {@link McpLoginRequiredError} (or no-ops the redirect, which the transport turns into an
 *   `UnauthorizedError`), records `loginRequired`, and the `/mcp` report says which command to run.
 *   With no stored login it does not even start discovery — a session that has never logged in
 *   makes no request to any authorization server.
 *
 * Endpoints are checked where they enter (`saveDiscoveryState`, `redirectToAuthorization`) and
 * where they are used (`addClientAuthentication`, before every token request), so a discovery
 * document cannot steer darwin to a private address or a different origin. Tokens flow only
 * between the SDK, this class and the store; nothing here logs them.
 */
import { randomBytes } from 'node:crypto';

import type {
  AddClientAuthentication,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  StoredOAuthClientInformation as OAuthClientInformationMixed,
  StoredOAuthTokens as OAuthTokens,
} from '@modelcontextprotocol/client';

import { ConfigError } from '../config.js';
import {
  OAuthPolicyError,
  assertHostResolvesPublic,
  isPrivateLiteralHost,
  validateOAuthUrl,
} from './oauth-net.js';
import {
  deleteOAuthRecord,
  newLoginId,
  readOAuthRecord,
  writeOAuthRecord,
  type OAuthRecord,
  type OAuthStoredDiscovery,
} from './oauth-store.js';

/** Longest access/refresh token darwin will hold or store. */
const MAX_TOKEN_LENGTH = 16 * 1024;

/** Raised inside a session when a server needs `darwin mcp login`; the message is the guidance. */
export class McpLoginRequiredError extends Error {
  constructor(server: string, detail?: string) {
    super(`MCP server "${server}" requires authentication${detail === undefined ? '' : ` (${detail})`}: run \`darwin mcp login ${server}\``);
    this.name = 'McpLoginRequiredError';
  }
}

/** The `oauth` key of one server entry, validated. */
export interface OAuthServerSettings {
  readonly name: string;
  /** The interpolated MCP endpoint. */
  readonly serverUrl: URL;
  readonly scope?: string;
  /** A pre-registered public client id; without one the login uses dynamic client registration. */
  readonly clientId?: string;
  /** Fixed loopback callback port (needed by pre-registered redirect URIs); default an ephemeral one. */
  readonly callbackPort?: number;
  /** A local/private MCP server, or the user's explicit `allowPrivateNetwork`: private OAuth endpoints allowed. */
  readonly allowPrivate: boolean;
}

const OAUTH_KEYS = new Set(['scope', 'clientId', 'callbackPort', 'allowPrivateNetwork']);

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    const resolved = process.env[key];
    if (resolved === undefined) throw new Error(`environment variable "${key}" is not set`);
    return resolved;
  });
}

/**
 * Reads the `oauth` key of a server entry: `undefined` when the server has none (or `false`), the
 * settings when it has a valid one, {@link ConfigError} when the entry asks for OAuth but cannot
 * have it. A typo in a credential setting should stop startup rather than hide a server.
 */
export function resolveOAuthSettings(name: string, entry: unknown): OAuthServerSettings | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const option = record['oauth'];
  if (option === undefined || option === false) return undefined;
  const fail = (message: string): never => {
    throw new ConfigError(`MCP server "${name}": oauth ${message}`);
  };
  if (option !== true && (typeof option !== 'object' || option === null || Array.isArray(option))) {
    return fail('must be true or an object such as { "scope": "…" }');
  }
  const options = option === true ? {} : (option as Record<string, unknown>);
  for (const key of Object.keys(options)) if (!OAUTH_KEYS.has(key)) fail(`has an unknown key "${key}" (allowed: ${[...OAUTH_KEYS].join(', ')})`);
  if (typeof record['url'] !== 'string' || record['url'] === '') return fail('needs a "url" (remote streamable-http servers only)');
  if (record['command'] !== undefined) fail('cannot be combined with "command" (stdio servers have no OAuth)');
  if (record['transport'] !== undefined && record['transport'] !== 'streamable-http') fail('supports only the streamable-http transport');
  if (record['auth'] !== undefined) fail('cannot be combined with "auth" (static client credentials); pick one');
  const headers = record['headers'];
  if (typeof headers === 'object' && headers !== null && Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    fail('cannot be combined with an Authorization header; pick one');
  }
  const scope = options['scope'];
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > 256 || /[\u0000-\u001f\u007f"\\]/.test(scope))) {
    fail('"scope" must be a short plain string');
  }
  const clientId = options['clientId'];
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId === '' || clientId.length > 256 || /[\u0000-\u001f\u007f]/.test(clientId))) {
    fail('"clientId" must be a short plain string');
  }
  const callbackPort = options['callbackPort'];
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || (callbackPort as number) < 1024 || (callbackPort as number) > 65535)) {
    fail('"callbackPort" must be an integer from 1024 to 65535');
  }
  const allowPrivateNetwork = options['allowPrivateNetwork'];
  if (allowPrivateNetwork !== undefined && typeof allowPrivateNetwork !== 'boolean') fail('"allowPrivateNetwork" must be true or false');

  let serverUrl: URL;
  try {
    serverUrl = new URL(interpolateEnv(record['url']));
  } catch (error) {
    return fail(`server URL is unusable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const allowPrivate = allowPrivateNetwork === true || isPrivateLiteralHost(serverUrl.hostname);
  try {
    validateOAuthUrl(serverUrl, 'MCP server URL', { allowPrivate });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return {
    name,
    serverUrl,
    allowPrivate,
    ...(scope === undefined ? {} : { scope: scope as string }),
    ...(clientId === undefined ? {} : { clientId: clientId as string }),
    ...(callbackPort === undefined ? {} : { callbackPort: callbackPort as number }),
  };
}

/**
 * Vets a discovery document: the authorization server and each endpoint it names must pass the
 * URL policy and share the authorization server's origin, its `issuer` must be that origin, and
 * any protected-resource metadata must describe this MCP server's origin. Throws
 * {@link OAuthPolicyError}.
 */
export function validateDiscoveryState(state: OAuthDiscoveryState, settings: OAuthServerSettings): void {
  const context = { allowPrivate: settings.allowPrivate };
  const server = validateOAuthUrl(state.authorizationServerUrl, 'authorization server', context);
  const metadata = state.authorizationServerMetadata;
  if (metadata !== undefined) {
    if (typeof metadata.issuer === 'string' && new URL(metadata.issuer).origin !== server.origin) {
      throw new OAuthPolicyError('authorization server metadata: issuer does not match the authorization server origin');
    }
    const endpoints: Record<string, unknown> = {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      registration_endpoint: (metadata as { registration_endpoint?: unknown }).registration_endpoint,
    };
    for (const [key, value] of Object.entries(endpoints)) {
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new OAuthPolicyError(`authorization server metadata: ${key} is not a URL`);
      if (validateOAuthUrl(value, key, context).origin !== server.origin) {
        throw new OAuthPolicyError(`authorization server metadata: ${key} is on a different origin than the authorization server`);
      }
    }
  }
  const resource = state.resourceMetadata?.resource;
  if (resource !== undefined && validateOAuthUrl(resource, 'protected resource', context).origin !== settings.serverUrl.origin) {
    throw new OAuthPolicyError('protected resource metadata describes a different origin than the MCP server');
  }
  if (state.resourceMetadataUrl !== undefined && validateOAuthUrl(state.resourceMetadataUrl, 'resource metadata URL', context).origin !== settings.serverUrl.origin) {
    throw new OAuthPolicyError('resource metadata URL is on a different origin than the MCP server');
  }
}

function assertUsableTokens(tokens: OAuthTokens): void {
  if (tokens.token_type.toLowerCase() !== 'bearer') throw new OAuthPolicyError('token response: only Bearer tokens are supported');
  if (tokens.access_token.length > MAX_TOKEN_LENGTH || (tokens.refresh_token?.length ?? 0) > MAX_TOKEN_LENGTH) {
    throw new OAuthPolicyError('token response: token is unreasonably long');
  }
}

export type OAuthProviderMode = 'login' | 'runtime';

export interface OAuthProviderOptions {
  readonly settings: OAuthServerSettings;
  readonly mode: OAuthProviderMode;
  /** login: the loopback redirect URI the callback listener is bound to. */
  readonly redirectUrl?: string;
  /** login: receives the vetted authorization URL (the browser step). */
  readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** runtime: the record read at load, when one applied. */
  readonly record?: OAuthRecord;
  /** runtime: why no record applied. */
  readonly recordProblem?: 'absent' | 'mismatch' | 'invalid';
}

export class DarwinOAuthProvider implements OAuthClientProvider {
  readonly settings: OAuthServerSettings;
  readonly mode: OAuthProviderMode;
  /** Set when a session request needed a login this process cannot perform. */
  loginRequired = false;
  private readonly redirect: string | undefined;
  private readonly onAuthorizationUrl: ((url: URL) => void | Promise<void>) | undefined;
  private record: OAuthRecord | undefined;
  private readonly recordProblem: OAuthProviderOptions['recordProblem'];
  private client: OAuthClientInformationMixed | undefined;
  private tokenState: OAuthTokens | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private verifier: string | undefined;
  private stateValue: string | undefined;

  constructor(options: OAuthProviderOptions) {
    this.settings = options.settings;
    this.mode = options.mode;
    this.redirect = options.redirectUrl;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.record = options.record;
    this.recordProblem = options.recordProblem;
    if (options.record !== undefined) {
      this.client = options.record.clientInformation;
      this.tokenState = options.record.tokens;
    }
  }

  /** What `/mcp` may say: never a token, never a timestamp of one. */
  authStatus(): 'logged-in' | 'login-required' | 'not-logged-in' {
    if (this.loginRequired) return 'login-required';
    return this.tokenState === undefined ? 'not-logged-in' : 'logged-in';
  }

  get redirectUrl(): string {
    return this.redirect ?? this.record?.redirectUrl ?? 'http://127.0.0.1/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'darwin',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.settings.scope === undefined ? {} : { scope: this.settings.scope }),
    };
  }

  /** The `state` value of the authorization request this provider issued (login mode). */
  get expectedState(): string | undefined {
    return this.stateValue;
  }

  state(): string {
    this.stateValue = randomBytes(32).toString('base64url');
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const known = this.client ?? (this.settings.clientId === undefined ? undefined : { client_id: this.settings.clientId });
    if (known === undefined && this.mode === 'runtime') {
      // Registering a client is part of logging in, never something a session does on its own.
      this.loginRequired = true;
      throw new McpLoginRequiredError(this.settings.name);
    }
    return known;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    if (this.mode === 'runtime') return;
    this.client = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenState;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    assertUsableTokens(tokens);
    const merged: OAuthTokens = {
      ...tokens,
      ...(tokens.refresh_token === undefined && this.tokenState?.refresh_token !== undefined
        ? { refresh_token: this.tokenState.refresh_token }
        : {}),
    };
    this.tokenState = merged;
    this.loginRequired = false;
    if (this.mode === 'login' || this.record === undefined) return;
    // A session refresh must never clobber a login someone completed in another terminal since.
    const current = await readOAuthRecord(this.settings.name, this.settings.serverUrl.href);
    // Only the login that produced the record may rewrite it: a logout (absent), a newer login, a
    // record for another URL or a damaged file are all someone else's state.
    if (current.status !== 'ok' || current.record.loginId !== this.record.loginId) return;
    this.record = { ...this.record, tokens: merged, savedAt: new Date().toISOString() };
    await writeOAuthRecord(this.record);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.mode === 'runtime') {
      // The transport turns "auth() returned REDIRECT" into an UnauthorizedError. Nothing opens.
      this.loginRequired = true;
      return;
    }
    const context = { allowPrivate: this.settings.allowPrivate };
    const target = validateOAuthUrl(url, 'authorization URL', context);
    const expected = this.discovery?.authorizationServerMetadata?.authorization_endpoint ?? this.discovery?.authorizationServerUrl;
    if (expected !== undefined && new URL(expected).origin !== target.origin) {
      throw new OAuthPolicyError('authorization URL is on a different origin than the authorization server');
    }
    if (target.searchParams.get('redirect_uri') !== this.redirectUrl || !target.searchParams.has('client_id')) {
      throw new OAuthPolicyError('authorization URL does not carry darwin\'s client id and loopback redirect URI');
    }
    await this.onAuthorizationUrl?.(target);
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.mode === 'login') this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('no PKCE code verifier is saved for this login');
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    validateDiscoveryState(state, this.settings);
    // A session already holds the stored (and re-validated) state; only a login keeps a new one.
    if (this.mode === 'login') this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    if (this.mode === 'login') return this.discovery;
    if (this.record === undefined) {
      this.loginRequired = true;
      throw new McpLoginRequiredError(
        this.settings.name,
        this.recordProblem === 'mismatch' ? 'the stored login is for a different server URL' : this.recordProblem === 'invalid' ? 'the stored login is unreadable' : undefined,
      );
    }
    const stored = this.record.discovery;
    if (stored.resourceMetadata !== undefined || stored.resourceIndicator) return stored;
    // No protected-resource metadata at login: a stub keeps the SDK from fetching any at request time.
    const stub: OAuthProtectedResourceMetadata = { resource: this.settings.serverUrl.href };
    return { ...stored, resourceMetadata: stub };
  }

  async validateResourceURL(_defaultResource: string | URL, resource?: string): Promise<URL | undefined> {
    if (resource === undefined) return undefined;
    if (this.mode === 'runtime' && this.record?.discovery.resourceIndicator === false) return undefined;
    const url = validateOAuthUrl(resource, 'protected resource', { allowPrivate: this.settings.allowPrivate });
    if (url.origin !== this.settings.serverUrl.origin) {
      throw new OAuthPolicyError('protected resource is on a different origin than the MCP server');
    }
    return url;
  }

  /** Before every token request: re-vet the endpoint (and its DNS), then authenticate as the client. */
  readonly addClientAuthentication: AddClientAuthentication = async (headers, params, url, metadata) => {
    const context = { allowPrivate: this.settings.allowPrivate };
    const target = validateOAuthUrl(url, 'token endpoint', context);
    const base = this.discovery?.authorizationServerUrl ?? this.record?.discovery.authorizationServerUrl;
    if (base !== undefined && new URL(base).origin !== target.origin) {
      throw new OAuthPolicyError('token endpoint is on a different origin than the authorization server');
    }
    await assertHostResolvesPublic(target.hostname, context);
    const client = this.clientInformation();
    if (client === undefined) throw new Error('no OAuth client information for the token request');
    const secret = (client as { client_secret?: string }).client_secret;
    if (secret === undefined) {
      params.set('client_id', client.client_id);
      return;
    }
    const methods = metadata?.token_endpoint_auth_methods_supported ?? [];
    if (methods.includes('client_secret_post') && !methods.includes('client_secret_basic')) {
      params.set('client_id', client.client_id);
      params.set('client_secret', secret);
    } else {
      headers.set('Authorization', `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`);
    }
  };

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      this.tokenState = undefined;
      this.loginRequired = this.mode === 'runtime';
    }
    if (scope === 'client' || scope === 'all') this.client = undefined;
    if (this.mode !== 'runtime' || this.record === undefined) return;
    const current = await readOAuthRecord(this.settings.name, this.settings.serverUrl.href);
    if (current.status !== 'ok' || current.record.loginId !== this.record.loginId) return;
    if (scope === 'all') {
      await deleteOAuthRecord(this.settings.name);
      return;
    }
    const { tokens: _dropped, clientInformation: _client, ...rest } = this.record;
    this.record = {
      ...rest,
      ...(this.client === undefined ? {} : { clientInformation: this.client }),
      ...(this.tokenState === undefined ? {} : { tokens: this.tokenState }),
    };
    await writeOAuthRecord(this.record);
  }

  /** Login mode: the record the finished login stores. Throws if the login has no tokens yet. */
  buildRecord(): OAuthRecord {
    if (this.tokenState === undefined || this.discovery === undefined) throw new Error('login is not complete');
    const stored: OAuthStoredDiscovery = { ...this.discovery, resourceIndicator: this.discovery.resourceMetadata !== undefined };
    return {
      version: 1,
      server: this.settings.name,
      serverUrl: this.settings.serverUrl.href,
      loginId: newLoginId(),
      savedAt: new Date().toISOString(),
      redirectUrl: this.redirectUrl,
      ...(this.client === undefined ? {} : { clientInformation: this.client }),
      tokens: this.tokenState,
      discovery: stored,
    };
  }
}

/**
 * The provider a session attaches to an OAuth-configured server: reads the stored login once (the
 * only token-store read a session makes, and only for servers that are armed and opted in).
 */
export async function createRuntimeOAuthProvider(settings: OAuthServerSettings): Promise<DarwinOAuthProvider> {
  const read = await readOAuthRecord(settings.name, settings.serverUrl.href);
  if (read.status === 'ok') {
    try {
      validateDiscoveryState(read.record.discovery, settings);
      // The 2.x client isolates credentials by issuer. Reject a mismatched stored
      // stamp before transport auth can treat it as absent and attempt registration;
      // a runtime never registers clients. Legacy unstamped records keep working.
      const issuer = read.record.discovery.authorizationServerUrl.replace(/\/$/, '');
      for (const credential of [read.record.clientInformation, read.record.tokens]) {
        if (credential?.issuer !== undefined && credential.issuer.replace(/\/$/, '') !== issuer) {
          throw new OAuthPolicyError('stored credentials belong to a different authorization server');
        }
      }
      return new DarwinOAuthProvider({ settings, mode: 'runtime', record: read.record });
    } catch {
      return new DarwinOAuthProvider({ settings, mode: 'runtime', recordProblem: 'invalid' });
    }
  }
  return new DarwinOAuthProvider({ settings, mode: 'runtime', recordProblem: read.status });
}
