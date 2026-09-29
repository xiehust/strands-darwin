/**
 * Network policy for MCP OAuth (SER-107): which URLs an OAuth exchange may touch, and the one
 * fetch every interactive-login request goes through.
 *
 * An MCP server — and, through its metadata, whatever authorization server it names — is
 * attacker-influenced input the moment a checkout or a third party controls it. So every URL that
 * comes out of discovery (protected-resource metadata, authorization-server metadata, the
 * authorization, token and registration endpoints, redirects) is checked here before darwin
 * requests it or sends a user's browser to it: `https` only (plain `http` only for a loopback
 * host, and only when the MCP server itself is local), no credentials or fragments in the URL,
 * and no loopback / private / link-local / metadata-service address unless the configured MCP
 * server is itself on such an address (or the user set `allowPrivateNetwork`). Names are checked
 * again where the socket is opened — a `lookup` hook that sees the addresses actually connected
 * to — so a hostname that resolves to a private address, or rebinds between check and use, is
 * refused too.
 *
 * Nothing here logs, and nothing here knows a token: it moves bytes that the caller owns.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** A refusal by the OAuth network policy. The message is safe to show: it never carries a secret. */
export class OAuthPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthPolicyError';
  }
}

/** Longest URL accepted from any metadata document. */
export const MAX_OAUTH_URL_LENGTH = 2048;
/** Largest response body any OAuth request may return. */
export const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;
/** Per-request ceiling, connect through last byte. */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const v4 = ipv4Bytes(dotted[1]!);
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, -dotted[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/**
 * Whether an address is anything but a globally routable unicast one: loopback, private,
 * link-local (cloud metadata lives at 169.254.169.254), CGNAT, multicast, reserved,
 * unspecified — and IPv4-mapped / NAT64 IPv6 forms of those. Unparseable text counts as
 * non-public: the safe direction.
 */
export function isNonPublicAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (net.isIPv4(bare)) {
    const [a = 0, b = 0, c = 0] = ipv4Bytes(bare)!;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(bare)) {
    const bytes = ipv6Bytes(bare);
    if (bytes === undefined) return true;
    const allZeroUntil = (end: number) => bytes.slice(0, end).every((byte) => byte === 0);
    if (allZeroUntil(15) && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: and ::1
    const embedded = (): string => bytes.slice(12).join('.');
    if (allZeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) return isNonPublicAddress(embedded()); // ::ffff:v4
    if (allZeroUntil(12)) return true; // deprecated IPv4-compatible
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) {
      return isNonPublicAddress(embedded()); // NAT64 64:ff9b::/96
    }
    return (
      (bytes[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
      (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
      bytes[0] === 0xff || // multicast
      (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) // documentation
    );
  }
  return true;
}

/** `localhost`, `*.localhost`, or a loopback literal. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIPv4(host)) return ipv4Bytes(host)![0] === 127;
  if (net.isIPv6(host)) {
    const bytes = ipv6Bytes(host);
    if (bytes === undefined) return false;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
    return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff && bytes[12] === 127;
  }
  return false;
}

/** A host that is `localhost` or an IP literal in a non-public range: a local/private MCP server. */
export function isPrivateLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isLoopbackHost(host)) return true;
  return net.isIP(host) !== 0 && isNonPublicAddress(host);
}

export interface OAuthUrlContext {
  /** Whether loopback / private destinations are acceptable (a local MCP server, or user opt-in). */
  readonly allowPrivate: boolean;
}

/**
 * Parses and vets one URL that discovery, configuration or a redirect produced. Returns the parsed
 * URL, or throws {@link OAuthPolicyError} naming `what` and the rule — never the URL's query.
 */
export function validateOAuthUrl(raw: string | URL, what: string, context: OAuthUrlContext): URL {
  const text = raw instanceof URL ? raw.href : raw;
  if (text.length > MAX_OAUTH_URL_LENGTH) throw new OAuthPolicyError(`${what}: URL is longer than ${MAX_OAUTH_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OAuthPolicyError(`${what}: not a valid absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OAuthPolicyError(`${what}: scheme ${url.protocol.replace(':', '')} is not allowed (https only)`);
  }
  if (url.username !== '' || url.password !== '') throw new OAuthPolicyError(`${what}: URL must not carry credentials`);
  if (url.hash !== '') throw new OAuthPolicyError(`${what}: URL must not carry a fragment`);
  if (url.hostname === '') throw new OAuthPolicyError(`${what}: URL has no host`);
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && !(loopback && context.allowPrivate)) {
    throw new OAuthPolicyError(`${what}: plain http is only allowed for a loopback host when the MCP server is local`);
  }
  if (!context.allowPrivate && isPrivateLiteralHost(url.hostname)) {
    throw new OAuthPolicyError(`${what}: ${url.hostname} is a loopback/private address, which a non-local MCP server may not point at`);
  }
  return url;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions extends OAuthUrlContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function toHeaderRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new OAuthPolicyError('OAuth request body type is not supported');
}

/** `dns.lookup` that refuses non-public results unless private destinations are allowed. */
function guardedLookup(allowPrivate: boolean): NonNullable<http.RequestOptions['lookup']> {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error);
      const list = addresses as dns.LookupAddress[];
      const bad = allowPrivate ? undefined : list.find((entry) => isNonPublicAddress(entry.address));
      if (bad !== undefined) {
        return callback(new OAuthPolicyError(`${hostname} resolves to a loopback/private address; refused`));
      }
      if (options.all === true) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as NonNullable<http.RequestOptions['lookup']>;
}

async function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  options: GuardedFetchOptions,
): Promise<{ status: number; statusText: string; headers: Headers; body: Buffer }> {
  const maxBytes = options.maxBytes ?? MAX_OAUTH_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  return await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const request = transport.request(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
        lookup: guardedLookup(options.allowPrivate),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new OAuthPolicyError(`OAuth response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
          }
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
              body: Buffer.concat(chunks),
            }),
          );
        });
        response.on('error', (error) => finish(() => reject(error)));
      },
    );
    const onAbort = () => request.destroy(new Error('OAuth request cancelled'));
    const timer = setTimeout(() => request.destroy(new Error(`OAuth request timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    if (options.signal?.aborted === true) {
      finish(() => reject(new Error('OAuth request cancelled')));
      request.destroy();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (error) => finish(() => reject(error)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * The SDK `FetchLike` for interactive login: every request URL is vetted by
 * {@link validateOAuthUrl}, the socket's addresses are vetted again by the lookup hook, redirects
 * are followed by hand (at most {@link MAX_REDIRECTS}, GET only, each hop re-vetted), and the
 * response is bounded in size and time. It is the only fetch the login flow uses.
 */
export function createGuardedFetch(options: GuardedFetchOptions): FetchLike {
  return async (input, init) => {
    let url = validateOAuthUrl(input, 'OAuth request', options);
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = bodyText(init?.body);
    const headers = toHeaderRecord(init?.headers);
    for (let hop = 0; ; hop += 1) {
      const result = await requestOnce(url, method, headers, body, options);
      const location = result.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(result.status) && location !== null) {
        if (hop >= MAX_REDIRECTS) throw new OAuthPolicyError(`OAuth request redirected more than ${MAX_REDIRECTS} times`);
        if (method !== 'GET') throw new OAuthPolicyError('OAuth request answered a non-GET with a redirect; refused');
        url = validateOAuthUrl(new URL(location, url), 'OAuth redirect', options);
        method = 'GET';
        body = undefined;
        continue;
      }
      const nullBody = [101, 204, 205, 304].includes(result.status);
      return new Response(nullBody ? null : new Uint8Array(result.body), {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    }
  };
}

/**
 * Resolves `hostname` and refuses when any address is non-public (unless private destinations are
 * allowed). Used as a pre-flight on the runtime refresh path, where the SDK — not darwin — opens
 * the socket, so the lookup hook above cannot see it.
 */
export async function assertHostResolvesPublic(hostname: string, context: OAuthUrlContext): Promise<void> {
  if (context.allowPrivate) return;
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) !== 0) {
    if (isNonPublicAddress(bare)) throw new OAuthPolicyError(`${hostname} is a loopback/private address; refused`);
    return;
  }
  const addresses = await dns.promises.lookup(bare, { all: true });
  if (addresses.some((entry) => isNonPublicAddress(entry.address))) {
    throw new OAuthPolicyError(`${hostname} resolves to a loopback/private address; refused`);
  }
}
