import { TextBlock, Tool, ToolResultBlock } from '@strands-agents/sdk';
import type {
  Agent,
  McpClient,
  ToolContext,
  ToolSpec,
  ToolStreamGenerator,
} from '@strands-agents/sdk';

const WEB_SEARCH_CLIENT_NAME = 'web-search';
const WEB_SEARCH_TOOL_NAME = 'search';
const EMPTY_RESULTS_ERROR =
  "Error calling tool 'search': Upstream error: {'code': -32602, 'message': 'Tool returned no results'}";

/**
 * Compatibility policy for the configured web-search MCP provider.
 *
 * Its upstream service reports an ordinary zero-hit search as an MCP error. At
 * the registered-tool seam Darwin can distinguish that one verified signature
 * without weakening transport, malformed-input, or other provider failures.
 */
export class WebSearchEmptyResults {
  /** Replaces only `web-search`'s server-side `search` tool. */
  apply(agent: Agent, clients: readonly McpClient[]): number {
    const searchClients = clients.filter((client) => client.clientName === WEB_SEARCH_CLIENT_NAME);
    if (searchClients.length === 0) return 0;

    const replacements = agent.tools.flatMap((candidate) => {
      const wrapped = this.wrap(candidate, searchClients);
      return wrapped === candidate ? [] : [wrapped];
    });
    if (replacements.length > 0) agent.toolRegistry.addOrReplace(replacements);

    // Preserve the SDK callback's remove/add lifecycle while ensuring a later
    // tools/list_changed refresh cannot restore the provider's raw search tool.
    for (const client of searchClients) this.wrapRefreshCallback(client);
    return replacements.length;
  }

  private wrap(candidate: Tool, clients: readonly McpClient[]): Tool {
    const owner = mcpOwner(candidate);
    if (owner === undefined || !clients.includes(owner)) return candidate;
    return mcpServerToolName(owner, candidate) === WEB_SEARCH_TOOL_NAME
      ? new EmptyResultSearchTool(candidate)
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
}

class EmptyResultSearchTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: ToolSpec;

  constructor(private readonly original: Tool) {
    super();
    this.name = original.name;
    this.description = original.description;
    this.toolSpec = original.toolSpec;
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const result = yield* this.original.stream(context);
    const query = searchQuery(context.toolUse.input);
    if (query === undefined || !isEmptyResultsError(result)) return result;
    return new ToolResultBlock({
      toolUseId: result.toolUseId,
      status: 'success',
      content: [new TextBlock(JSON.stringify({ query, results: [], totalResults: 0 }))],
    });
  }
}

function searchQuery(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const query = (input as Record<string, unknown>)['query'];
  return typeof query === 'string' ? query : undefined;
}

function isEmptyResultsError(result: ToolResultBlock): boolean {
  return result.status === 'error' &&
    result.error === undefined &&
    result.content.length === 1 &&
    result.content[0]?.type === 'textBlock' &&
    result.content[0].text === EMPTY_RESULTS_ERROR;
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
