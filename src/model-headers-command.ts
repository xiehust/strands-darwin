/** User-configured OpenAI gateway authentication; no shell, OAuth store or Agent loop changes. */
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Model } from '@strands-agents/sdk';
import path from 'node:path';
import { withDarwinMarker } from './tools/shell-env.js';

export interface HeadersCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly refreshIntervalMs: number;
}

export const MAX_HEADERS_BYTES = 16 * 1024;
const MAX_HEADER_VALUE = 8192;

/** Never carries stdout, stderr, executable arguments or an underlying error cause. */
export class HeadersCommandError extends Error {
  constructor(reason: string) {
    super(`headersCommand: ${reason} Sign in with your helper and restart Darwin before trying again.`);
    this.name = 'HeadersCommandError';
  }
}

export function parseHeadersCommand(value: unknown): HeadersCommandConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('"headersCommand" must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['command', 'args', 'timeoutMs', 'refreshIntervalMs'].includes(key))) {
    throw new Error('"headersCommand" has an unknown field.');
  }
  const command = input['command'];
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.length > 4096 || /[\x00-\x1f\x7f]/.test(command)) {
    throw new Error('"headersCommand.command" must be an absolute executable path (at most 4096 characters).');
  }
  const args = input['args'] === undefined ? [] : input['args'];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('"headersCommand.args" must be at most 32 strings, each at most 4096 characters without NUL.');
  }
  const timeoutMs = input['timeoutMs'] === undefined ? 15_000 : input['timeoutMs'];
  const refreshIntervalMs = input['refreshIntervalMs'] === undefined ? 240_000 : input['refreshIntervalMs'];
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('"headersCommand.timeoutMs" must be an integer from 1 to 60000.');
  }
  if (typeof refreshIntervalMs !== 'number' || !Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1 || refreshIntervalMs > 3_600_000) {
    throw new Error('"headersCommand.refreshIntervalMs" must be an integer from 1 to 3600000.');
  }
  return Object.freeze({ command, args: Object.freeze([...args] as string[]), timeoutMs, refreshIntervalMs });
}

/** Credentials need an explicit secure destination, never an environment-selected host. */
export function headersCommandBaseUrlProblem(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return 'must not contain credentials, a query or a fragment';
    if (url.protocol === 'https:') return undefined;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  } catch { /* Report only a fixed reason, never a potentially secret URL. */ }
  return 'must be HTTPS (HTTP is allowed only on loopback for local testing)';
}

type AuthHeaders = Readonly<Record<string, string>>;
const streamCredentials = new AsyncLocalStorage<Set<string>>();

function authSecrets(credentials: AuthHeaders): string[] {
  return [...new Set(Object.values(credentials).flatMap(value =>
    /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]))].sort((a, b) => b.length - a.length);
}

/** The existing SDK log router uses this scope before diagnostics/console publication. */
export function headersCommandStreamActive(): boolean {
  return streamCredentials.getStore() !== undefined;
}

export function redactHeadersCommandText(text: string, secrets = streamCredentials.getStore()): string {
  if (secrets === undefined || secrets.size === 0) return text;
  const values = [...secrets].flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length);
  return values.reduce((out, value) => out.split(value).join('[redacted]'), text);
}

function safeStreamError(error: unknown, secrets: Set<string>): unknown {
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 8; depth += 1) {
    // The OpenAI client wraps fetch failures; expose only our fixed safe message.
    if (cause instanceof HeadersCommandError) return cause;
    cause = cause.cause;
  }
  if (secrets.size === 0) return error;
  const redact = (text: string) => redactHeadersCommandText(text, secrets);
  const seen = new WeakMap<object, unknown>();
  const clean = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') return redact(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8) return '[omitted error detail]';
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Headers) return new Headers([...value].map(([key, text]) => [redact(key), redact(text)]));
    // Preserve SDK error prototypes/status/code so ordinary error classification survives.
    const copy = value instanceof Error ? Object.create(Object.getPrototypeOf(value)) as object : Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) Object.defineProperty(copy, redact(key), { ...descriptor, value: clean(descriptor.value, depth + 1) });
    }
    return copy;
  };
  return clean(error);
}

/** Only exceptions change: public Model stream forwarding, no successful event/SSE rewriting. */
export function protectHeadersCommandModel<T extends Model>(model: T): T {
  const stream = model.stream.bind(model);
  model.stream = async function* (...args: Parameters<Model['stream']>) {
    const secrets = new Set<string>();
    const source = stream(...args)[Symbol.asyncIterator]();
    let failed = false;
    try {
      for (;;) {
        const part = await streamCredentials.run(secrets, () => source.next());
        if (part.done) return part.value;
        yield part.value;
      }
    } catch (error) {
      failed = true;
      throw safeStreamError(error, secrets);
    } finally {
      try {
        await streamCredentials.run(secrets, () => source.return?.());
      } catch (error) {
        if (!failed) throw safeStreamError(error, secrets);
      } finally { secrets.clear(); }
    }
  };
  return model;
}

function parseHeaders(bytes: Buffer): AuthHeaders {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HeadersCommandError('helper output is not valid UTF-8.'); }
  const headers: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  for (const line of lines) {
    const match = /^(authorization|x-api-key):[ \t]*(.+)$/i.exec(line);
    if (match === null) throw new HeadersCommandError('helper must emit only Authorization and optional x-api-key header lines.');
    const name = match[1]!.toLowerCase();
    const value = match[2]!.replace(/ +$/, '');
    if (headers[name] !== undefined || value.length > MAX_HEADER_VALUE || !/^[\x21-\x7e][\x20-\x7e]*$/.test(value)) {
      throw new HeadersCommandError('helper emitted duplicate, oversized or invalid auth headers.');
    }
    headers[name] = value;
  }
  if (!/^Bearer [\x21-\x7e]+$/i.test(headers['authorization'] ?? '')) {
    throw new HeadersCommandError('helper must emit an Authorization: Bearer token header.');
  }
  return Object.freeze(headers);
}

function runHeadersCommand(config: HeadersCommandConfig, signal: AbortSignal): Promise<AuthHeaders> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new HeadersCommandError('helper cancelled.')); return; }
    // User-configured, like hooks: keep the user's environment, add DARWIN, and
    // never inherit the model's persistent cwd or execute a shell command string.
    const child = spawn(config.command, [...config.args], {
      cwd: path.dirname(config.command), env: withDarwinMarker(process.env),
      shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    });
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Already exited. Never surface a spawn/kill error containing arguments. */ }
    };
    const finish = (error?: HeadersCommandError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      kill();
      child.stdout?.destroy();
      if (error !== undefined) { reject(error); return; }
      try { resolve(parseHeaders(Buffer.concat(chunks))); }
      catch (cause) { reject(cause); }
    };
    const abort = () => finish(new HeadersCommandError('helper cancelled.'));
    const timer = setTimeout(() => finish(new HeadersCommandError('helper timed out.')), config.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new HeadersCommandError('helper could not start.')));
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HEADERS_BYTES) finish(new HeadersCommandError('helper output exceeded 16 KiB.'));
      else if (!settled) chunks.push(chunk);
    });
    child.on('close', (code, exitSignal) => finish(
      code === 0 && exitSignal === null ? undefined : new HeadersCommandError('helper exited unsuccessfully.'),
    ));
    if (signal.aborted) abort();
  });
}

interface Refresh {
  readonly controller: AbortController;
  readonly promise: Promise<AuthHeaders>;
  consumers: number;
  settled: boolean;
}

/** No timer or disk cache. Same config object shares one refresh across parent/child/aux models. */
function credentialProvider(config: HeadersCommandConfig): (signal: AbortSignal) => Promise<AuthHeaders> {
  let cached: { headers: AuthHeaders; until: number } | undefined;
  let pending: Refresh | undefined;
  let failure: HeadersCommandError | undefined;
  return async signal => {
    if (signal.aborted) throw new HeadersCommandError('request cancelled.');
    if (failure !== undefined) throw failure;
    if (cached !== undefined && performance.now() < cached.until) return cached.headers;
    if (pending === undefined || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const job: Refresh = {
        controller, consumers: 0, settled: false,
        promise: runHeadersCommand(config, controller.signal).then(headers => {
          cached = { headers, until: performance.now() + config.refreshIntervalMs };
          return headers;
        }).catch(error => {
          const safe = error instanceof HeadersCommandError ? error : new HeadersCommandError('helper failed.');
          // No unattended auth retry storm. Cancellation is not a credential failure.
          if (!controller.signal.aborted) failure = safe;
          throw safe;
        }).finally(() => {
          job.settled = true;
          if (pending === job) pending = undefined;
        }),
      };
      pending = job;
    }
    const job = pending;
    job.consumers += 1;
    try {
      return await new Promise<AuthHeaders>((resolve, reject) => {
        const abort = () => reject(new HeadersCommandError('request cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        job.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
    } finally {
      job.consumers -= 1;
      if (job.consumers === 0 && !job.settled) job.controller.abort();
    }
  };
}

const providers = new WeakMap<HeadersCommandConfig, ReturnType<typeof credentialProvider>>();

/** Gateway errors can echo request credentials; keep normal error codes/status for SDK classification. */
async function redactErrorResponse(response: Response, credentials: AuthHeaders): Promise<Response> {
  const secrets = authSecrets(credentials).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); break; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = size > 64 * 1024
    ? '{"error":{"message":"gateway error response exceeded 64 KiB"}}'
    : redact(Buffer.concat(chunks).toString('utf8'));
  const headers = new Headers(response.headers);
  for (const [name, value] of headers) headers.set(name, redact(value));
  headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: redact(response.statusText), headers });
}

/** SDK-supported clientConfig.fetch seam: inject both headers atomically, never follow a redirect. */
export function createHeadersCommandClient(config: HeadersCommandConfig, baseUrl: string, cancelSignal?: AbortSignal): {
  apiKey: string;
  clientConfig: { baseURL: string; fetch: typeof fetch; maxRetries: number; logLevel: 'off' };
} {
  const problem = headersCommandBaseUrlProblem(baseUrl);
  if (problem !== undefined) throw new HeadersCommandError('a secure explicit baseUrl is required.');
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
  let provide = providers.get(config);
  if (provide === undefined) { provide = credentialProvider(config); providers.set(config, provide); }
  const getHeaders = provide;
  const scopedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix) || target.username || target.password) {
      throw new HeadersCommandError('refused a request outside the configured endpoint.');
    }
    const signal = cancelSignal === undefined ? request.signal : AbortSignal.any([request.signal, cancelSignal]);
    const credentials = await getHeaders(signal);
    for (const secret of authSecrets(credentials)) streamCredentials.getStore()?.add(secret);
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    // Do not let environment credentials or a stale SDK auth header join the helper's pair.
    headers.delete('authorization');
    headers.delete('x-api-key');
    for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
    try {
      const response = await fetch(new Request(request, { headers, signal, redirect: 'error' }));
      return response.status >= 400 ? await redactErrorResponse(response, credentials) : response;
    } catch {
      throw new HeadersCommandError(signal.aborted ? 'request cancelled.' : 'gateway transport failed (redirects are forbidden).');
    }
  };
  return {
    // The OpenAI constructor requires a key. This inert value is replaced before
    // fetch and never goes on the wire; OPENAI_API_KEY is never a fallback here.
    apiKey: 'darwin-headers-command',
    clientConfig: { baseURL: baseUrl, fetch: scopedFetch, maxRetries: 0, logLevel: 'off' },
  };
}
