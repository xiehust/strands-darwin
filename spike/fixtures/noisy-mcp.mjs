import readline from 'node:readline';

const BANNER = 'NOISY_MCP_STDERR_MUST_NOT_REACH_TUI';
process.stderr.write(`${BANNER}\n`);

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
        serverInfo: { name: 'noisy-fixture', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools: [] };
      break;
    default:
      result = {};
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
