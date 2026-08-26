import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { TextBlock, Tool, ToolResultBlock } from '@strands-agents/sdk';
import type {
  Agent,
  McpClient,
  ToolContext,
  ToolSpec,
  ToolStreamGenerator,
} from '@strands-agents/sdk';

const CODEGRAPH_CLIENT_NAME = 'codegraph';
const CODEGRAPH_TOOL_NAMES = new Set([
  'search',
  'explore',
  'node',
  'callers',
  'callees',
  'impact',
  'files',
]);
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const REQUIRED_SCHEMA_MARKERS = [
  Buffer.from('CREATE TABLE files'),
  Buffer.from('CREATE TABLE nodes'),
  Buffer.from('CREATE TABLE edges'),
  Buffer.from('CREATE TABLE schema_versions'),
];
const MAX_INDEX_SCHEMA_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_PATH_CODE_UNITS = 4096;
const MAX_DISPLAY_CODE_POINTS = 240;

interface AvailableTarget {
  readonly available: true;
  readonly target: string;
}

interface UnavailableTarget {
  readonly available: false;
  readonly target: string;
  readonly reason: string;
}

type TargetState = AvailableTarget | UnavailableTarget;

/**
 * Runtime-local, read-only availability policy for CodeGraph semantic readers.
 * Every normalized target is inspected at most once for the lifetime of this policy.
 */
export class CodeGraphPreflight {
  private readonly projectRoot: string;
  private readonly states = new Map<string, Promise<TargetState>>();

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /** Primes the ordinary no-projectPath target during runtime assembly. */
  async primeCurrent(): Promise<void> {
    await this.stateForTarget(this.projectRoot);
  }

  /** Replaces only known semantic tools owned by the configured `codegraph` client. */
  apply(agent: Agent, clients: readonly McpClient[]): number {
    const codegraphClients = clients.filter((client) => client.clientName === CODEGRAPH_CLIENT_NAME);
    if (codegraphClients.length === 0) return 0;

    const replacements = agent.tools.flatMap((candidate) => {
      const wrapped = this.wrap(candidate, codegraphClients);
      return wrapped === candidate ? [] : [wrapped];
    });
    if (replacements.length > 0) agent.toolRegistry.addOrReplace(replacements);

    // Agent.initialize() owns the SDK callback that removes old names and adds
    // refreshed tools. Decorate that callback rather than replacing its lifecycle
    // behavior, so a later tools/list_changed cannot restore raw semantic tools.
    for (const client of codegraphClients) this.wrapRefreshCallback(client);
    return replacements.length;
  }

  private wrap(candidate: Tool, clients: readonly McpClient[]): Tool {
    const owner = mcpOwner(candidate);
    if (owner === undefined || !clients.includes(owner)) return candidate;
    const serverName = mcpServerToolName(owner, candidate);
    return serverName !== undefined && CODEGRAPH_TOOL_NAMES.has(serverName)
      ? new CodeGraphPreflightTool(candidate, this)
      : candidate;
  }

  private wrapRefreshCallback(client: McpClient): void {
    const internal = client as unknown as {
      _onToolsChanged?: (oldTools: string[], newTools: Tool[]) => void;
      onToolsChanged: ((oldTools: string[], newTools: Tool[]) => void) | undefined;
    };
    const previous = internal._onToolsChanged;
    if (previous === undefined) return;
    internal.onToolsChanged = (oldTools, newTools) => {
      previous(oldTools, newTools.map((candidate) => this.wrap(candidate, [client])));
    };
  }

  async stateForInput(input: unknown): Promise<TargetState> {
    if (!isRecord(input)) {
      return { available: false, target: 'tool input', reason: 'tool input must be an object' };
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'projectPath') || input['projectPath'] === undefined) {
      return this.stateForTarget(this.projectRoot);
    }

    const parsed = explicitProjectPath(input['projectPath']);
    if (!parsed.ok) {
      return { available: false, target: 'explicit projectPath', reason: parsed.reason };
    }
    return this.stateForTarget(parsed.target);
  }

  private stateForTarget(target: string): Promise<TargetState> {
    const normalized = path.normalize(target);
    const cached = this.states.get(normalized);
    if (cached !== undefined) return cached;
    const pending = inspectTarget(normalized);
    this.states.set(normalized, pending);
    return pending;
  }
}

class CodeGraphPreflightTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: ToolSpec;

  constructor(
    private readonly original: Tool,
    private readonly preflight: CodeGraphPreflight,
  ) {
    super();
    this.name = original.name;
    this.description = original.description;
    this.toolSpec = original.toolSpec;
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const state = await this.preflight.stateForInput(context.toolUse.input);
    if (!state.available) {
      return new ToolResultBlock({
        toolUseId: context.toolUse.toolUseId,
        status: 'success',
        content: [new TextBlock(fallbackText(state))],
      });
    }
    return yield* this.original.stream(context);
  }
}

async function inspectTarget(target: string): Promise<TargetState> {
  const unavailable = (reason: string): UnavailableTarget => ({ available: false, target, reason });
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory()) return unavailable('target is not a directory');
    if (targetInfo.isSymbolicLink() || path.normalize(await realpath(target)) !== target) {
      return unavailable('target is symlinked');
    }

    const indexDir = path.join(target, '.codegraph');
    const indexDirInfo = await lstat(indexDir);
    if (!indexDirInfo.isDirectory()) return unavailable('index directory is not a directory');
    if (indexDirInfo.isSymbolicLink() || path.normalize(await realpath(indexDir)) !== indexDir) {
      return unavailable('index directory is symlinked');
    }

    const databasePath = path.join(indexDir, 'codegraph.db');
    const databaseInfo = await lstat(databasePath);
    if (!databaseInfo.isFile()) return unavailable('index database is not a regular file');
    if (databaseInfo.isSymbolicLink() || path.normalize(await realpath(databasePath)) !== databasePath) {
      return unavailable('index database is symlinked');
    }
    if ((databaseInfo.mode & 0o444) === 0) return unavailable('index database is unreadable');
    await access(databasePath, constants.R_OK);
    if (databaseInfo.size < SQLITE_HEADER.length) {
      return unavailable('index database has an invalid schema');
    }

    // Opening through a file handle with O_NOFOLLOW closes the final-component
    // symlink race between lstat/realpath and the read. The SQLite schema text is
    // stored in the database file itself, so a bounded read validates the
    // CodeGraph tables without a SQLite dependency or sidecar writes.
    const handle = await open(databasePath, constants.O_RDONLY | noFollowFlag());
    try {
      const contents = Buffer.allocUnsafe(Math.min(databaseInfo.size, MAX_INDEX_SCHEMA_BYTES));
      let offset = 0;
      while (offset < contents.length) {
        const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const database = contents.subarray(0, offset);
      if (!database.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER) ||
          REQUIRED_SCHEMA_MARKERS.some((marker) => database.indexOf(marker) < 0)) {
        return unavailable('index database has an invalid schema');
      }
    } finally {
      await handle.close();
    }
    return { available: true, target };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return unavailable('CodeGraph index is absent');
    if (code === 'EACCES' || code === 'EPERM') return unavailable('CodeGraph index is unreadable');
    return unavailable('CodeGraph index is malformed or unreadable');
  }
}

function explicitProjectPath(value: unknown):
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'projectPath must be a string' };
  if (value.length === 0) return { ok: false, reason: 'projectPath must not be empty' };
  if (value.length > MAX_PROJECT_PATH_CODE_UNITS) return { ok: false, reason: 'projectPath is too long' };
  if (value.includes('\0')) return { ok: false, reason: 'projectPath contains NUL' };
  if (!path.isAbsolute(value)) return { ok: false, reason: 'projectPath must be absolute' };

  const relativeParts = value.slice(path.parse(value).root.length).split(path.sep);
  if (relativeParts.some((part) => part === '.' || part === '..')) {
    return { ok: false, reason: 'projectPath contains traversal segments' };
  }
  return { ok: true, target: path.normalize(value) };
}

function fallbackText(state: UnavailableTarget): string {
  return `[CodeGraph preflight] Target ${JSON.stringify(boundedDisplay(state.target))} is unavailable: ${state.reason}. ` +
    'The MCP tool was not invoked. Use bash or fileEditor for ordinary shell/file inspection.';
}

function boundedDisplay(value: string): string {
  const points = [...value];
  return points.length <= MAX_DISPLAY_CODE_POINTS
    ? value
    : `${points.slice(0, MAX_DISPLAY_CODE_POINTS - 1).join('')}…`;
}

function mcpOwner(tool: Tool): McpClient | undefined {
  const owner = (tool as unknown as { mcpClient?: unknown }).mcpClient;
  return owner !== null && typeof owner === 'object' ? owner as McpClient : undefined;
}

function mcpServerToolName(client: McpClient, tool: Tool): string | undefined {
  const names = (client as unknown as {
    _serverToolNames?: { get(candidate: object): unknown };
  })._serverToolNames;
  const name = names?.get(tool);
  return typeof name === 'string' ? name : undefined;
}


function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}
