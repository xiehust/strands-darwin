/**
 * The per-server OAuth token store (SER-107): `~/.darwin/mcp-auth/<server>-<hash>.json`, one
 * private file per MCP server name.
 *
 * This is darwin-owned credential state, so its rules are strict and few. The directory is
 * `0700` and each file `0600`, written by exclusive-create of a temp file plus rename so a crash
 * never leaves half a token; reads refuse symlinks and non-regular files and are size-capped. A
 * record is bound to the exact MCP server URL it was issued for: a same-named server that now
 * points elsewhere (a project config that changed, an override) reads as "not logged in" — never
 * as the old server's token — so a token cannot follow a name to a different origin. Nothing in
 * this module logs, and no caller is given a path to print next to a value: the only strings that
 * leave it are file paths and fixed problem descriptions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationSchema, OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { userDarwinDir } from '../paths.js';

export const OAUTH_STORE_DIRNAME = 'mcp-auth';
/** Largest record read or written. Real records are a few KiB. */
export const MAX_OAUTH_RECORD_BYTES = 64 * 1024;

export interface OAuthStoredDiscovery extends OAuthDiscoveryState {
  /**
   * Whether token requests carry the RFC 8707 `resource` parameter: true only when the server
   * published protected-resource metadata. Kept so a runtime refresh repeats the login exactly.
   */
  resourceIndicator: boolean;
}

export interface OAuthRecord {
  version: 1;
  /** The config server name this record belongs to. */
  server: string;
  /** The exact (interpolated) MCP server URL the token was issued for. */
  serverUrl: string;
  /** Random id of the login that produced the record; a runtime refresh never overwrites a newer login. */
  loginId: string;
  savedAt: string;
  /** The loopback redirect URI registered at login. */
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery: OAuthStoredDiscovery;
}

export type OAuthRecordRead =
  | { status: 'ok'; record: OAuthRecord }
  | { status: 'absent' }
  /** A record exists for this server name but was issued for a different URL. */
  | { status: 'mismatch' }
  | { status: 'invalid'; problem: string };

export function oauthStoreDir(): string {
  return path.join(userDarwinDir(), OAUTH_STORE_DIRNAME);
}

export function oauthRecordPath(server: string): string {
  const slug = server.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'server';
  const hash = createHash('sha256').update(server).digest('hex').slice(0, 10);
  return path.join(oauthStoreDir(), `${slug}-${hash}.json`);
}

export function newLoginId(): string {
  return randomBytes(12).toString('base64url');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): OAuthRecord | string {
  if (!isObject(value) || value['version'] !== 1) return 'not a version 1 OAuth record';
  const discovery = value['discovery'];
  if (
    typeof value['server'] !== 'string' || typeof value['serverUrl'] !== 'string' ||
    typeof value['loginId'] !== 'string' || typeof value['savedAt'] !== 'string' ||
    typeof value['redirectUrl'] !== 'string' || !isObject(discovery) ||
    typeof discovery['authorizationServerUrl'] !== 'string' || typeof discovery['resourceIndicator'] !== 'boolean'
  ) {
    return 'record fields are missing or of the wrong type';
  }
  let tokens: OAuthTokens | undefined;
  if (value['tokens'] !== undefined) {
    const parsed = OAuthTokensSchema.safeParse(value['tokens']);
    if (!parsed.success) return 'stored tokens are malformed';
    tokens = parsed.data;
  }
  let clientInformation: OAuthClientInformationMixed | undefined;
  if (value['clientInformation'] !== undefined) {
    const parsed = OAuthClientInformationSchema.safeParse(value['clientInformation']);
    if (!parsed.success) return 'stored client information is malformed';
    clientInformation = parsed.data;
  }
  return {
    version: 1,
    server: value['server'],
    serverUrl: value['serverUrl'],
    loginId: value['loginId'],
    savedAt: value['savedAt'],
    redirectUrl: value['redirectUrl'],
    ...(clientInformation === undefined ? {} : { clientInformation }),
    ...(tokens === undefined ? {} : { tokens }),
    discovery: discovery as unknown as OAuthStoredDiscovery,
  };
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Why the store directory cannot be trusted, or undefined when it is absent or a real directory.
 * A symlinked `mcp-auth` would send every token file (and its chmod) into whatever it points at,
 * so reads, writes and deletes all refuse it before touching the target.
 */
async function storeDirProblem(dir: string): Promise<string | undefined> {
  try {
    const info = await lstat(dir);
    return info.isDirectory() ? undefined : `${dir} is not a real directory (a symlink or file); nothing was read or written`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' ? undefined : `${dir} could not be inspected (${code ?? 'error'})`;
  }
}

/** Reads one server's record, bound to `serverUrl`. Never throws; a bad file is `invalid`. */
export async function readOAuthRecord(server: string, serverUrl: string): Promise<OAuthRecordRead> {
  const file = oauthRecordPath(server);
  const dirProblem = await storeDirProblem(oauthStoreDir());
  if (dirProblem !== undefined) return { status: 'invalid', problem: dirProblem };
  let text: string;
  try {
    const info = await lstat(file);
    if (!info.isFile()) return { status: 'invalid', problem: `${file} is not a regular file` };
    if (info.size > MAX_OAUTH_RECORD_BYTES) return { status: 'invalid', problem: `${file} is larger than ${MAX_OAUTH_RECORD_BYTES} bytes` };
    const handle = await open(file, fsConstants.O_RDONLY | NOFOLLOW);
    try {
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', problem: `${file} could not be read (${(error as NodeJS.ErrnoException | undefined)?.code ?? 'error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'invalid', problem: `${file} is not valid JSON` };
  }
  const record = parseRecord(parsed);
  if (typeof record === 'string') return { status: 'invalid', problem: `${file}: ${record}` };
  if (record.server !== server || record.serverUrl !== serverUrl) return { status: 'mismatch' };
  return { status: 'ok', record };
}

/** Atomically replaces the server's record with `0600` permissions inside a `0700` directory. */
export async function writeOAuthRecord(record: OAuthRecord): Promise<void> {
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_OAUTH_RECORD_BYTES) throw new Error(`OAuth record exceeds ${MAX_OAUTH_RECORD_BYTES} bytes`);
  const dir = oauthStoreDir();
  const dirProblem = await storeDirProblem(dir);
  if (dirProblem !== undefined) throw new Error(dirProblem);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Tighten through a no-follow directory handle, so a symlink swapped in after the check above
  // is refused (ELOOP) instead of having its target chmod-ed.
  const dirHandle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NOFOLLOW);
  try {
    if (!(await dirHandle.stat()).isDirectory()) throw new Error(`${dir} is not a real directory`);
    await dirHandle.chmod(0o700);
  } finally {
    await dirHandle.close();
  }
  const file = oauthRecordPath(record.server);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Removes the server's record. Returns whether a file was removed. */
export async function deleteOAuthRecord(server: string): Promise<boolean> {
  const dirProblem = await storeDirProblem(oauthStoreDir());
  if (dirProblem !== undefined) throw new Error(dirProblem);
  try {
    await rm(oauthRecordPath(server));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw error;
  }
}
