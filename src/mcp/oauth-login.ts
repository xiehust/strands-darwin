/**
 * `darwin mcp login` engine (SER-107): a bounded authorization-code + PKCE login for one remote
 * MCP server, run entirely by the MCP SDK's `auth()` over darwin's guarded fetch and provider.
 *
 * The only listener is a loopback callback: bound to `127.0.0.1`, one path, one accepted
 * callback, a Host-header check against DNS rebinding, a `state` check (a request with the wrong
 * state is answered `400` and ignored, so a stray local page can neither complete nor abort the
 * login), a request cap, and a hard deadline. It answers with a fixed static page and reflects
 * nothing it received. The deadline, `AbortSignal` and the listener's teardown are the whole
 * lifecycle: nothing outlives this call.
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';

import { createGuardedFetch, validateOAuthUrl } from './oauth-net.js';
import { DarwinOAuthProvider, type OAuthServerSettings } from './oauth-provider.js';
import { writeOAuthRecord } from './oauth-store.js';

export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_CALLBACK_REQUESTS = 25;
const MAX_CALLBACK_PARAM = 4096;

export class OAuthLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthLoginError';
  }
}

const CALLBACK_PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;margin:3em"><h1>${title}</h1><p>${body}</p></body>`;

export interface LoopbackCallback {
  /** `http://127.0.0.1:<port>/callback` — the redirect URI to register. */
  readonly redirectUrl: string;
  /** Resolves with the first callback whose `state` matches; rejects on deadline, abort or flooding. */
  wait(expectedState: () => string | undefined): Promise<URLSearchParams>;
  close(): Promise<void>;
}

/** Binds the loopback listener (port 0 = ephemeral) and starts counting its deadline in `wait`. */
export async function startLoopbackCallback(options: {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LoopbackCallback> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  let requests = 0;
  let settle: { resolve: (params: URLSearchParams) => void; reject: (error: Error) => void } | undefined;
  let expected: () => string | undefined = () => undefined;
  let done = false;

  const server = http.createServer((request, response) => {
    const reply = (status: number, title: string, body: string) => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        Connection: 'close',
      });
      response.end(CALLBACK_PAGE(title, body));
    };
    requests += 1;
    if (requests > MAX_CALLBACK_REQUESTS) {
      reply(429, 'Too many requests', 'The login was cancelled.');
      settle?.reject(new OAuthLoginError('too many requests reached the loopback callback; login cancelled'));
      return;
    }
    const port = (server.address() as AddressInfo | null)?.port;
    const host = request.headers.host;
    if (done || host === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      reply(403, 'Forbidden', 'Unexpected host.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      reply(400, 'Bad request', 'Malformed request.');
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      reply(404, 'Not found', 'Nothing here.');
      return;
    }
    const want = expected();
    const got = url.searchParams.get('state') ?? '';
    const stateOk =
      want !== undefined && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!stateOk) {
      reply(400, 'Bad request', 'This request does not belong to the login in progress.');
      return;
    }
    for (const value of url.searchParams.values()) {
      if (value.length > MAX_CALLBACK_PARAM) {
        reply(400, 'Bad request', 'A parameter is too long.');
        return;
      }
    }
    done = true;
    reply(200, 'darwin login', 'You can close this tab and return to the terminal.');
    settle?.resolve(url.searchParams);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    throw new OAuthLoginError(
      error.code === 'EADDRINUSE'
        ? `loopback callback port ${options.port} is already in use`
        : `could not open the loopback callback listener (${error.code ?? 'error'})`,
    );
  });
  const port = (server.address() as AddressInfo).port;

  const close = async (): Promise<void> => {
    done = true;
    settle?.reject(new OAuthLoginError('login closed'));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    close,
    wait(expectedState) {
      expected = expectedState;
      return new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new OAuthLoginError(`no callback within ${Math.round(timeoutMs / 1000)} s; login timed out`)),
          timeoutMs,
        );
        const onAbort = () => reject(new OAuthLoginError('login cancelled'));
        const clear = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        };
        settle = {
          resolve: (params) => {
            clear();
            resolve(params);
          },
          reject: (error) => {
            clear();
            reject(error);
          },
        };
        if (options.signal?.aborted === true) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Best-effort default-browser launch: argv only (no shell), detached, output ignored. */
export async function openInBrowser(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [parsed.href]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', parsed.href]]
        : ['xdg-open', [parsed.href]];
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** A short single-line description of a failure, safe to print: no control characters, bounded. */
export function describeLoginFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error);
  // An SDK error can quote a raw server response; never let one carry a credential into the terminal.
  return text
    .replace(/("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|code)"?\s*[:=]\s*)("[^"]*"|[^\s,&}]+)/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface RunLoginOptions {
  readonly settings: OAuthServerSettings;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Progress lines (never a secret). */
  readonly log: (line: string) => void;
  /** Launch the browser; `false` skips it (the URL is always printed). Default: {@link openInBrowser}. */
  readonly open?: ((url: string) => Promise<boolean>) | false;
}

/**
 * Logs in to one server: probe → discovery → registration → browser → callback → code exchange →
 * store. Resolves when the token record is written; rejects with {@link OAuthLoginError} or an
 * SDK/policy error whose message {@link describeLoginFailure} makes printable.
 */
export async function runOAuthLogin(options: RunLoginOptions): Promise<void> {
  const { settings, log } = options;
  const fetchFn = createGuardedFetch({
    allowPrivate: settings.allowPrivate,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const callback = await startLoopbackCallback({
    ...(settings.callbackPort === undefined ? {} : { port: settings.callbackPort }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    // One unauthenticated probe: the 401's WWW-Authenticate names the resource metadata document.
    const probe = await fetchFn(settings.serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'darwin', version: '0' } },
      }),
    });
    if (probe.status >= 200 && probe.status < 300) {
      throw new OAuthLoginError('the server accepted a request without authentication; there is nothing to log in to');
    }
    const challenge = extractWWWAuthenticateParams(probe);
    let resourceMetadataUrl: URL | undefined;
    if (challenge.resourceMetadataUrl !== undefined) {
      const candidate = validateOAuthUrl(challenge.resourceMetadataUrl, 'resource metadata URL', { allowPrivate: settings.allowPrivate });
      if (candidate.origin !== settings.serverUrl.origin) {
        throw new OAuthLoginError('the server pointed its resource metadata at a different origin; refusing to follow it');
      }
      resourceMetadataUrl = candidate;
    }
    const scope = settings.scope ?? challenge.scope;

    const provider = new DarwinOAuthProvider({
      settings,
      mode: 'login',
      redirectUrl: callback.redirectUrl,
      onAuthorizationUrl: async (url) => {
        log(`Open this URL to authorize darwin:\n  ${url.href}`);
        if (options.open === false) return;
        const opened = await (options.open ?? openInBrowser)(url.href);
        log(opened ? 'Opened your browser; waiting for the callback…' : 'Could not open a browser; open the URL above yourself. Waiting for the callback…');
      },
    });
    // Listening for the callback (and its deadline) starts before the browser can possibly call back.
    const pending = callback.wait(() => provider.expectedState);
    pending.catch(() => undefined);
    const authOptions = {
      serverUrl: settings.serverUrl,
      fetchFn,
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
      ...(scope === undefined ? {} : { scope }),
    };
    const first = await auth(provider, authOptions);
    if (first !== 'REDIRECT') throw new OAuthLoginError('the authorization server did not request an interactive authorization');

    const params = await pending;
    const issuer = params.get('iss');
    if (issuer !== null) {
      const metadataIssuer = provider.discoveryState()?.authorizationServerMetadata?.issuer;
      if (metadataIssuer !== undefined && metadataIssuer !== issuer) {
        throw new OAuthLoginError('the callback\'s iss parameter does not match the authorization server; refused');
      }
    }
    const denied = params.get('error');
    if (denied !== null) {
      throw new OAuthLoginError(`the authorization server refused the login (${denied.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'error'})`);
    }
    const code = params.get('code');
    if (code === null || code === '') throw new OAuthLoginError('the callback carried no authorization code');

    const second = await auth(provider, { ...authOptions, authorizationCode: code });
    if (second !== 'AUTHORIZED') throw new OAuthLoginError('the code exchange did not authorize');
    await writeOAuthRecord(provider.buildRecord());
    log(`Logged in to ${settings.name}.`);
  } finally {
    await callback.close();
  }
}
