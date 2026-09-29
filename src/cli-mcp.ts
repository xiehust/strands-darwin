/**
 * `darwin mcp login <name> [--no-browser]` and `darwin mcp logout <name>` (SER-107).
 *
 * Routed by `cli.ts` before `cli-main` (no runtime, model, Ink, session or MCP client is built).
 * `login` resolves the server exactly as a session would — the entry a session in this directory
 * would connect to — and refuses before any token read or network request when that entry is
 * declared by a project layer the workspace-trust decision holds (SER-090): a checkout cannot make
 * `darwin mcp login` talk to a server the user has not consented to. Every other refusal is a
 * plain one-line error and exit 1; a grammar error is exit 2 with the shared usage hint.
 */
import { ConfigError } from './config.js';
import { usageErrorText } from './cli-usage.js';
import { projectLayersArmed, resolveWorkspaceTrust } from './agent/workspace-trust.js';
import { deleteOAuthRecord } from './mcp/oauth-store.js';
import { describeLoginFailure, runOAuthLogin, LOGIN_TIMEOUT_MS } from './mcp/oauth-login.js';
import { resolveOAuthSettings } from './mcp/oauth-provider.js';
import { inventoryProjectMcpServers, readMcpServerConfigs } from './mcp/registry.js';

export const MCP_USAGE = 'usage: darwin mcp login <name> [--no-browser] | darwin mcp logout <name>';

export interface McpCliDependencies {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly timeoutMs: number;
  readonly open: ((url: string) => Promise<boolean>) | undefined;
  /** Aborts a login in progress (the process wires SIGINT to it). */
  readonly signal: AbortSignal | undefined;
}

/** Runs the command and returns the process exit code (0 ok, 1 refused/failed, 2 usage). */
export async function mcpCommand(
  projectRoot: string,
  argv: readonly string[],
  overrides: Partial<McpCliDependencies> = {},
): Promise<number> {
  const io: McpCliDependencies = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    timeoutMs: LOGIN_TIMEOUT_MS,
    open: undefined,
    signal: undefined,
    ...overrides,
  };
  const usage = (): number => {
    io.stderr(usageErrorText(MCP_USAGE));
    return 2;
  };
  const [verb, name, ...flags] = argv;
  if ((verb !== 'login' && verb !== 'logout') || name === undefined || name === '' || name.startsWith('-')) return usage();
  const noBrowser = flags.length === 1 && flags[0] === '--no-browser' && verb === 'login';
  if (flags.length > 0 && !noBrowser) return usage();

  if (verb === 'logout') {
    const removed = await deleteOAuthRecord(name);
    io.stdout(removed ? `logged out of ${name}: stored login removed\n` : `no stored login for ${name}\n`);
    return 0;
  }

  // The entry a session here would use: the project layer only when it declares the name AND is trusted.
  const inventory = await inventoryProjectMcpServers(projectRoot);
  const projectDeclared = inventory.servers.some((server) => server.name === name);
  const armed = projectDeclared ? projectLayersArmed(await resolveWorkspaceTrust(projectRoot)) : false;
  let entry: unknown;
  try {
    const configs = await readMcpServerConfigs(projectRoot, { projectLayer: projectDeclared && armed ? 'armed' : 'held' });
    entry = configs.servers?.[name];
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (entry === undefined) {
    io.stderr(
      projectDeclared && !armed
        ? `error: MCP server "${name}" is declared by this project (${inventory.servers.find((server) => server.name === name)!.file}), which is not trusted. ` +
            `Nothing was contacted. Start \`darwin\` in this directory and trust the workspace, then run this again.\n`
        : `error: no MCP server named "${name}" is configured. Run \`darwin doctor\` or \`/mcp\` to see the servers darwin reads.\n`,
    );
    return 1;
  }
  let settings;
  try {
    settings = resolveOAuthSettings(name, entry);
  } catch (error) {
    io.stderr(`error: ${error instanceof ConfigError ? error.message : describeLoginFailure(error)}\n`);
    return 1;
  }
  if (settings === undefined) {
    io.stderr(
      `error: MCP server "${name}" has no "oauth" entry. Add \`"oauth": true\` to its config (remote streamable-http servers only), then run this again.\n`,
    );
    return 1;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  io.signal?.addEventListener('abort', onSignal, { once: true });
  try {
    io.stderr(`Logging in to MCP server "${name}" (${settings.serverUrl.origin})…\n`);
    await runOAuthLogin({
      settings,
      timeoutMs: io.timeoutMs,
      signal: controller.signal,
      log: (line) => io.stderr(`${line}\n`),
      ...(noBrowser ? { open: false as const } : io.open === undefined ? {} : { open: io.open }),
    });
    io.stdout(`logged in to ${name}; restart darwin (or start a new session) to use it\n`);
    return 0;
  } catch (error) {
    io.stderr(`error: login to "${name}" failed: ${describeLoginFailure(error)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    io.signal?.removeEventListener('abort', onSignal);
  }
}

export async function runMcpCli(projectRoot: string, argv: readonly string[]): Promise<void> {
  process.exitCode = await mcpCommand(projectRoot, argv);
}
