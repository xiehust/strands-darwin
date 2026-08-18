// A minimal well-behaved stdio MCP server exposing three no-op tools, for the
// free `/mcp` TUI scenario: no dependency, no network, hand-rolled JSON-RPC like
// noisy-mcp.mjs but quiet on stderr.
import readline from 'node:readline';

const TOOLS = ['alpha', 'beta', 'gamma'].map((name) => ({
  name,
  description: `No-op tool ${name}.`,
  inputSchema: { type: 'object', properties: {} },
}));

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  let result;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'tools-fixture', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    default:
      result = {};
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
