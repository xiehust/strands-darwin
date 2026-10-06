/**
 * MCP server prompts as user-invoked slash commands (SER-114).
 *
 * A prompt-capable server's `prompts/list` is read once, after `agent.initialize()`
 * has connected the clients, and each prompt is offered as `/mcp__<server>__<prompt>`
 * at the lowest slash precedence. Only an explicit user submission calls
 * `prompts/get`; its result becomes one ordinary user prompt. Nothing here is a tool,
 * nothing is automatic, the model never sees the catalogue, and the system prompt is
 * untouched.
 *
 * Everything goes through the public SDK surface: `McpClient.connectionState`,
 * `serverCapabilities` and `client` (the MCP SDK `Client`, whose `listPrompts` /
 * `getPrompt` take `RequestOptions` with a timeout and an `AbortSignal`). Never
 * `listTools()` (it connects lazily) and never `connect(true)`: a server that is not
 * already `connected` gets no prompt request at all, which is also why a server held
 * back by workspace trust (it has no client) and a failed or prompt-less one stay
 * silent.
 */
import type { McpClient } from '@strands-agents/sdk';

import { MAX_FIELD_CHARS } from '../trajectory/record.js';

/** The fixed prefix of every MCP prompt command name. */
export const MCP_PROMPT_COMMAND_PREFIX = 'mcp__';
/** Prompts kept per server; the rest are reported, never offered. */
export const MAX_MCP_PROMPTS_PER_SERVER = 64;
/** `prompts/list` pages followed per server before discovery stops and says so. */
export const MAX_MCP_PROMPT_LIST_PAGES = 8;
/** One deadline per server for the whole (paginated) listing. */
export const MCP_PROMPT_LIST_TIMEOUT_MS = 5_000;
/** One `prompts/get` call; the turn's cancel aborts it sooner. */
export const MCP_PROMPT_GET_TIMEOUT_MS = 15_000;
/** Declared arguments per prompt; a prompt declaring more is skipped and reported. */
export const MAX_MCP_PROMPT_ARGUMENTS = 16;
/** Prompt and argument names, in code points; a longer one is skipped and reported. */
export const MAX_MCP_PROMPT_NAME_CHARS = 128;
/** Prompt and argument descriptions, in code points (display metadata, cut with `…`). */
export const MAX_MCP_PROMPT_DESCRIPTION_CHARS = 160;
/** One problem or server-error sentence, in code points. */
export const MAX_MCP_PROMPT_PROBLEM_CHARS = 240;
/** Problems kept per session (the last one becomes `… N more`), so every surface is bounded. */
export const MAX_MCP_PROMPT_PROBLEMS = 16;
/**
 * The largest expanded prompt accepted, in code points: the trajectory's own
 * per-field cap (`MAX_FIELD_CHARS`), reused rather than a second number. A larger
 * result is refused, never truncated.
 */
export const MAX_MCP_PROMPT_RESULT_CHARS = MAX_FIELD_CHARS;

export interface McpPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
}

/** One listed prompt, its metadata bounded, exactly as the server named it. */
export interface McpListedPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments: readonly McpPromptArgument[];
}

/** One prompt-capable, connected server's single discovery result. */
export interface McpPromptListing {
  readonly server: string;
  readonly client: McpClient;
  readonly prompts: readonly McpListedPrompt[];
  /** Why the listing failed (error or timeout), bounded; no prompts are offered then. */
  readonly failure?: string;
  /** Bounded sentences: the failure, a truncation, or a skipped prompt's metadata. */
  readonly problems: readonly string[];
  /** Listed prompts dropped here: over the per-server cap, or metadata over a bound. */
  readonly skipped: number;
}

/** Every listing taken this process; inherited by `/clear` and `/rewind` successors. */
export interface McpPromptDiscovery {
  readonly listings: readonly McpPromptListing[];
}

/** One offered slash command. */
export interface McpPromptCommand {
  /** The command name without its slash: `mcp__<server>__<prompt>`, sanitized. */
  readonly name: string;
  readonly server: string;
  /** The prompt's own name, sent back verbatim in `prompts/get`. */
  readonly prompt: string;
  readonly description?: string;
  readonly arguments: readonly McpPromptArgument[];
  readonly client: McpClient;
}

/** What `/mcp` states about one prompt-capable server: names and counts only. */
export interface McpPromptServerSummary {
  /** Offered command names, in listing order. */
  readonly commands: readonly string[];
  /** Listed prompts not offered (collision or metadata over a bound). */
  readonly skipped: number;
  /** Why the listing produced nothing, when it failed. */
  readonly failure?: string;
}

export interface McpPromptCatalogue {
  readonly commands: readonly McpPromptCommand[];
  /** Keyed by server name; only servers that were asked (connected, prompt-capable). */
  readonly servers: ReadonlyMap<string, McpPromptServerSummary>;
  /** Every discovery and naming problem, bounded, in server order. */
  readonly problems: readonly string[];
}

export const EMPTY_MCP_PROMPT_CATALOGUE: McpPromptCatalogue = { commands: [], servers: new Map(), problems: [] };

/** Bounds a sentence to one line of at most `max` code points, controls replaced. */
export function boundedMcpText(value: string, max = MAX_MCP_PROMPT_PROBLEM_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const points = [...flat];
  return points.length <= max ? flat : `${points.slice(0, max - 1).join('')}…`;
}

/** Every character outside `[A-Za-z0-9_-]` becomes `_` (per code point). */
export function sanitizeMcpPromptPart(value: string): string {
  return Array.from(value, (character) => (/^[A-Za-z0-9_-]$/u.test(character) ? character : '_')).join('');
}

/** The canonical command name for one server's prompt, without the slash. */
export function mcpPromptCommandName(server: string, prompt: string): string {
  return `${MCP_PROMPT_COMMAND_PREFIX}${sanitizeMcpPromptPart(server)}__${sanitizeMcpPromptPart(prompt)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Validates and bounds one listed prompt's metadata. Names are identifiers the
 * server needs back verbatim, so a name over its bound is a skip, never a cut.
 */
function boundPrompt(raw: unknown): McpListedPrompt | string {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = record['name'];
  if (typeof name !== 'string' || name === '') return 'a listed prompt has no name';
  const label = boundedMcpText(name, 48);
  if (codePoints(name) > MAX_MCP_PROMPT_NAME_CHARS) {
    return `prompt "${label}" skipped: name longer than ${MAX_MCP_PROMPT_NAME_CHARS} characters`;
  }
  const declared = Array.isArray(record['arguments']) ? (record['arguments'] as unknown[]) : [];
  if (declared.length > MAX_MCP_PROMPT_ARGUMENTS) {
    return `prompt "${label}" skipped: declares ${declared.length} arguments (at most ${MAX_MCP_PROMPT_ARGUMENTS})`;
  }
  const args: McpPromptArgument[] = [];
  for (const entry of declared) {
    const argument = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const argName = argument['name'];
    if (typeof argName !== 'string' || argName === '' || codePoints(argName) > MAX_MCP_PROMPT_NAME_CHARS) {
      return `prompt "${label}" skipped: an argument name is missing or longer than ${MAX_MCP_PROMPT_NAME_CHARS} characters`;
    }
    const argDescription = argument['description'];
    args.push({
      name: argName,
      required: argument['required'] === true,
      ...(typeof argDescription === 'string' && argDescription.trim() !== ''
        ? { description: boundedMcpText(argDescription, MAX_MCP_PROMPT_DESCRIPTION_CHARS) }
        : {}),
    });
  }
  const description = typeof record['description'] === 'string' ? record['description'] : typeof record['title'] === 'string' ? record['title'] : undefined;
  return {
    name,
    arguments: args,
    ...(description !== undefined && description.trim() !== ''
      ? { description: boundedMcpText(description, MAX_MCP_PROMPT_DESCRIPTION_CHARS) }
      : {}),
  };
}

/** One server's bounded, paginated `prompts/list` under a single deadline. */
async function listServerPrompts(client: McpClient, timeoutMs: number): Promise<McpPromptListing> {
  const server = client.clientName;
  // The MCP SDK's `Protocol.request` adds an `abort` listener to the request signal and
  // never removes it, so a signal that aborts after the answer sends a stray
  // `notifications/cancelled` for a completed request. The deadline is therefore a
  // controller whose timer is cleared once the listing settles: it can only ever abort
  // a request that is still in flight.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`prompts/list deadline of ${timeoutMs}ms passed`)), timeoutMs);
  const raw: unknown[] = [];
  const problems: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  try {
    let more = true;
    while (more) {
      const page = await client.client.listPrompts(cursor === undefined ? undefined : { cursor }, { signal: deadline.signal, timeout: timeoutMs });
      pages += 1;
      raw.push(...page.prompts);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : undefined;
      more = cursor !== undefined && raw.length <= MAX_MCP_PROMPTS_PER_SERVER && pages < MAX_MCP_PROMPT_LIST_PAGES;
    }
  } catch (error) {
    const timedOut = deadline.signal.aborted || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === -32001);
    const reason = timedOut
      ? `prompts/list timed out after ${timeoutMs / 1000}s`
      : `prompts/list failed — ${errorText(error)}`;
    const failure = boundedMcpText(reason);
    return { server, client, prompts: [], failure, skipped: 0, problems: [boundedMcpText(`mcp server "${server}": ${failure}; its prompts are not offered`)] };
  } finally {
    clearTimeout(timer);
  }
  if (raw.length > MAX_MCP_PROMPTS_PER_SERVER) {
    problems.push(`mcp server "${server}": lists more than ${MAX_MCP_PROMPTS_PER_SERVER} prompts; only the first ${MAX_MCP_PROMPTS_PER_SERVER} are offered`);
  } else if (cursor !== undefined) {
    problems.push(`mcp server "${server}": prompts/list stopped after ${MAX_MCP_PROMPT_LIST_PAGES} pages; later prompts are not offered`);
  }
  const prompts: McpListedPrompt[] = [];
  let skipped = Math.max(0, raw.length - MAX_MCP_PROMPTS_PER_SERVER);
  for (const entry of raw.slice(0, MAX_MCP_PROMPTS_PER_SERVER)) {
    const bounded = boundPrompt(entry);
    if (typeof bounded === 'string') {
      skipped += 1;
      problems.push(boundedMcpText(`mcp server "${server}": ${bounded}`));
    } else {
      prompts.push(bounded);
    }
  }
  return { server, client, prompts, problems, skipped };
}

/**
 * Lists the prompts of every client that is already `connected` and declares the
 * `prompts` capability, all servers concurrently, each under its own deadline, so
 * the whole step is bounded by one timeout. Never throws: a failure is that
 * server's bounded problem and its prompts are absent.
 */
export async function discoverMcpPrompts(
  clients: readonly McpClient[],
  options: { timeoutMs?: number } = {},
): Promise<McpPromptDiscovery> {
  const timeoutMs = options.timeoutMs ?? MCP_PROMPT_LIST_TIMEOUT_MS;
  const eligible = clients.filter((client) => client.connectionState === 'connected' && client.serverCapabilities?.prompts !== undefined);
  const listings = await Promise.all(eligible.map((client) => listServerPrompts(client, timeoutMs)));
  return { listings };
}

/**
 * Names the listed prompts against the names already owned. `claimed` maps a
 * lower-cased command name to its owner (built-ins, aliases, skills, custom
 * commands — everything with higher precedence); a prompt landing on any of them,
 * or on an earlier prompt, is skipped and reported, never shadowing.
 */
export function buildMcpPromptCatalogue(
  discovery: McpPromptDiscovery,
  claimed: ReadonlyMap<string, string>,
): McpPromptCatalogue {
  const owners = new Map(claimed);
  const commands: McpPromptCommand[] = [];
  const servers = new Map<string, McpPromptServerSummary>();
  const problems: string[] = [];
  for (const listing of discovery.listings) {
    problems.push(...listing.problems);
    const offered: string[] = [];
    let skipped = listing.skipped;
    for (const prompt of listing.prompts) {
      const name = mcpPromptCommandName(listing.server, prompt.name);
      const owner = owners.get(name.toLowerCase());
      if (owner !== undefined) {
        skipped += 1;
        problems.push(boundedMcpText(`mcp prompt "${prompt.name}" from "${listing.server}" skipped: /${name} conflicts with ${owner}`));
        continue;
      }
      owners.set(name.toLowerCase(), `mcp prompt "${prompt.name}" from "${listing.server}"`);
      offered.push(name);
      commands.push({
        name,
        server: listing.server,
        prompt: prompt.name,
        arguments: prompt.arguments,
        client: listing.client,
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
      });
    }
    servers.set(listing.server, {
      commands: offered,
      skipped,
      ...(listing.failure === undefined ? {} : { failure: listing.failure }),
    });
  }
  if (problems.length > MAX_MCP_PROMPT_PROBLEMS) {
    const hidden = problems.length - (MAX_MCP_PROMPT_PROBLEMS - 1);
    problems.splice(MAX_MCP_PROMPT_PROBLEMS - 1, problems.length, `… ${hidden} more MCP prompt problems not listed`);
  }
  return { commands, servers, problems };
}


/** An explicit submission naming an offered prompt, with its whitespace-split words. */
export interface McpPromptInvocation {
  readonly command: McpPromptCommand;
  readonly words: readonly string[];
}

/**
 * Matches `/mcp__s__p [args]` against the catalogue, case-insensitively like custom
 * commands. Anything else — including an unknown `/mcp__…` name — is `null` and
 * stays ordinary input. Pure: no server is contacted.
 */
export function matchMcpPromptCommand(catalogue: McpPromptCatalogue, input: string): McpPromptInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(`/${MCP_PROMPT_COMMAND_PREFIX}`)) return null;
  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/u);
  const name = (separator === -1 ? withoutSlash : withoutSlash.slice(0, separator)).toLowerCase();
  const command = catalogue.commands.find((candidate) => candidate.name.toLowerCase() === name);
  if (command === undefined) return null;
  const rest = separator === -1 ? '' : withoutSlash.slice(separator).trim();
  return { command, words: rest === '' ? [] : rest.split(/\s+/u) };
}

/** `<required> [optional]` in declaration order — the completion hint and the usage line. */
export function mcpPromptArgumentHint(command: McpPromptCommand): string {
  return command.arguments.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(' ');
}

/** The local usage notice: the command, its arguments, and what each one is. */
export function mcpPromptUsage(command: McpPromptCommand, problem: string): string {
  const hint = mcpPromptArgumentHint(command);
  const described = command.arguments.map((argument) =>
    `${argument.name}${argument.required ? ' (required)' : ''}${argument.description === undefined ? '' : `: ${argument.description}`}`);
  const detail = described.length === 0 ? 'it takes no arguments' : `arguments — ${described.join('; ')}`;
  return boundedMcpText(`${problem}; usage: /${command.name}${hint === '' ? '' : ` ${hint}`} — ${detail} (words are whitespace-split, one per argument)`, 600);
}

/** A failure the drivers state as one bounded notice, with the draft returned unsent. */
export class McpPromptError extends Error {
  constructor(message: string) {
    super(boundedMcpText(message, 600));
    this.name = 'McpPromptError';
  }
}

/**
 * Maps the words positionally onto the declared arguments. More words than
 * arguments, or a required argument with no word, is a usage error raised before
 * any server call.
 */
export function mapMcpPromptArguments(invocation: McpPromptInvocation): Record<string, string> {
  const { command, words } = invocation;
  if (words.length > command.arguments.length) {
    throw new McpPromptError(mcpPromptUsage(command, `/${command.name} got ${words.length} word${words.length === 1 ? '' : 's'} for ${command.arguments.length} argument${command.arguments.length === 1 ? '' : 's'}`));
  }
  const missing = command.arguments.slice(words.length).filter((argument) => argument.required).map((argument) => argument.name);
  if (missing.length > 0) {
    throw new McpPromptError(mcpPromptUsage(command, `/${command.name} is missing required argument${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`));
  }
  return Object.fromEntries(words.map((word, index) => [command.arguments[index]!.name, word]));
}

/** What a `prompts/get` result left out of the prompt, counted for one visible notice. */
export interface McpPromptOmissions {
  readonly assistantMessages: number;
  readonly nonTextBlocks: number;
}

export interface ExpandedMcpPrompt {
  readonly command: McpPromptCommand;
  readonly message: string;
  readonly omitted: McpPromptOmissions;
}

/**
 * Projects a `prompts/get` result onto one user prompt: user-role text blocks joined
 * in order by a blank line. Assistant-role messages and non-text user content are
 * not sent and are counted. No user text, or more than
 * {@link MAX_MCP_PROMPT_RESULT_CHARS} code points, is refused — never truncated.
 */
export function composeMcpPromptResult(command: McpPromptCommand, result: { messages?: unknown }): ExpandedMcpPrompt {
  const messages = Array.isArray(result.messages) ? (result.messages as unknown[]) : [];
  const texts: string[] = [];
  let assistantMessages = 0;
  let nonTextBlocks = 0;
  for (const entry of messages) {
    const message = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (message['role'] !== 'user') {
      assistantMessages += 1;
      continue;
    }
    const content = message['content'];
    const blocks = Array.isArray(content) ? (content as unknown[]) : [content];
    for (const block of blocks) {
      const record = typeof block === 'object' && block !== null ? (block as Record<string, unknown>) : {};
      if (record['type'] === 'text' && typeof record['text'] === 'string') texts.push(record['text']);
      else nonTextBlocks += 1;
    }
  }
  const omitted = { assistantMessages, nonTextBlocks };
  const message = texts.join('\n\n');
  if (message.trim() === '') {
    throw new McpPromptError(`/${command.name}: the server returned no user text to send${omissionClause(omitted)}; prompt not sent`);
  }
  const size = codePoints(message);
  if (size > MAX_MCP_PROMPT_RESULT_CHARS) {
    throw new McpPromptError(`/${command.name}: the server's prompt is ${size} characters, over the ${MAX_MCP_PROMPT_RESULT_CHARS}-character cap darwin records for a prompt; refused, not truncated`);
  }
  return { command, message, omitted };
}

function omissionClause(omitted: McpPromptOmissions): string {
  const parts = [
    omitted.assistantMessages > 0 ? `${omitted.assistantMessages} assistant message${omitted.assistantMessages === 1 ? '' : 's'}` : '',
    omitted.nonTextBlocks > 0 ? `${omitted.nonTextBlocks} non-text block${omitted.nonTextBlocks === 1 ? '' : 's'}` : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? '' : ` (not sent: ${parts.join(', ')})`;
}

/** The one notice every driver prints for a loaded prompt, omissions counted in it. */
export function mcpPromptLoadedNotice(expanded: ExpandedMcpPrompt): string {
  return `loaded MCP prompt "/${expanded.command.name}" from server "${expanded.command.server}"${omissionClause(expanded.omitted)}`;
}

/** Whether the notice has to warn: something the server returned was not sent. */
export function mcpPromptOmittedAnything(omitted: McpPromptOmissions): boolean {
  return omitted.assistantMessages > 0 || omitted.nonTextBlocks > 0;
}

/**
 * The explicit invocation: argument mapping (usage errors make no request), then one
 * `prompts/get` with a timeout and the caller's cancel signal, then the projection.
 * Every failure is a bounded {@link McpPromptError}.
 */
export async function expandMcpPrompt(
  invocation: McpPromptInvocation,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExpandedMcpPrompt> {
  const args = mapMcpPromptArguments(invocation);
  const { command } = invocation;
  const timeoutMs = options.timeoutMs ?? MCP_PROMPT_GET_TIMEOUT_MS;
  if (command.client.connectionState !== 'connected') {
    throw new McpPromptError(`/${command.name}: mcp server "${command.server}" is no longer connected; restart darwin to reconnect`);
  }
  let result: { messages?: unknown };
  // The request gets its own signal, linked to the caller's only while the call is in
  // flight: the MCP SDK never removes its `abort` listener, so a caller signal aborted
  // after the answer would otherwise send a stray `notifications/cancelled`.
  const inFlight = new AbortController();
  const forward = (): void => inFlight.abort(options.signal?.reason);
  if (options.signal?.aborted === true) forward();
  else options.signal?.addEventListener('abort', forward, { once: true });
  try {
    result = await command.client.client.getPrompt(
      { name: command.prompt, ...(Object.keys(args).length === 0 ? {} : { arguments: args }) },
      { timeout: timeoutMs, signal: inFlight.signal },
    );
  } catch (error) {
    if (options.signal?.aborted === true) throw new McpPromptError(`/${command.name}: cancelled before mcp server "${command.server}" answered`);
    const text = errorText(error);
    // -32001 is the MCP SDK's own RequestTimeout code (`ErrorCode.RequestTimeout`).
    const timedOut = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === -32001;
    const reason = timedOut ? `timed out after ${timeoutMs / 1000}s` : `failed — ${text}`;
    throw new McpPromptError(`/${command.name}: prompts/get on mcp server "${command.server}" ${reason}`);
  } finally {
    options.signal?.removeEventListener('abort', forward);
  }
  return composeMcpPromptResult(command, result);
}
