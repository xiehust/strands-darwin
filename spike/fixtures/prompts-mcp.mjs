// A real stdio MCP server for the SER-114 MCP-prompt suites: hand-rolled JSON-RPC
// like tools-mcp.mjs, no dependency, no network, quiet on stderr.
//
//   node prompts-mcp.mjs --mode <mode> [--log <file>]
//
// Every message received (requests and notifications) is appended to the log as one
// JSON line `{ method, params }` before it is answered, so a suite can prove which
// requests a server got — in particular that a prompt-less, failed or never-spawned
// server got zero `prompts/*` requests.
//
// Modes:
//   prompts     prompts capability; the SER-114 acceptance catalogue (below)
//   no-prompts  tools capability only (one no-op tool); answers prompts/* with -32601
//   fail        logs `initialize`, then exits 1 before answering (a server that fails to start)
//   slow-list   prompts capability; prompts/list never answers (discovery timeout)
//   bad-list    prompts capability; prompts/list answers a JSON-RPC error
//   paged       prompts capability; 3 pages x 30 prompts (more than the 64 cap)
//   endless     prompts capability; 1 prompt per page, always another cursor (page cap)
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const mode = option('mode', 'prompts');
const log = option('log', undefined);

const PROMPTS = [
  { name: 'greet', description: 'Say hello with no arguments.' },
  {
    name: 'review',
    description: 'Review one file.\u001b[31m with\ncontrols',
    arguments: [
      { name: 'file', description: 'path to review', required: true },
      { name: 'focus', description: 'what to look at' },
    ],
  },
  { name: 'conversation', description: 'A multi-message result.' },
  { name: 'broken', description: 'Always fails.' },
  { name: 'slow', description: 'Answers after a minute.' },
  { name: 'sized', description: 'Returns N characters.', arguments: [{ name: 'size', required: true }] },
  { name: 'assistant-only', description: 'Returns no user text.' },
  { name: 'name.with spaces', description: 'Needs sanitizing.' },
  { name: 'name_with_spaces', description: 'Collides with the sanitized one above.' },
  { name: 'collide', description: 'Collides with a custom command.' },
];

function text(role, value) {
  return { role, content: { type: 'text', text: value } };
}

/** Returns `{ result }`, `{ error }` or `{ never: true }` for a prompts/get. */
function getPrompt(params) {
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'greet':
      return { result: { messages: [text('user', 'Say hello to the SER-114 fixture.')] } };
    case 'review':
      return { result: { messages: [text('user', `Review ${args.file}${args.focus === undefined ? '' : ` focusing on ${args.focus}`}.`)] } };
    case 'conversation':
      return {
        result: {
          description: 'multi',
          messages: [
            text('user', 'First user part.'),
            text('assistant', 'ASSISTANT_TEXT_MUST_NOT_BE_SENT'),
            { role: 'user', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } },
            text('user', 'Second user part.'),
          ],
        },
      };
    case 'broken':
      return { error: { code: -32603, message: 'fixture prompt failure\u001b[31m' } };
    case 'slow':
      return { never: true };
    case 'sized':
      return { result: { messages: [text('user', 'x'.repeat(Number(args.size)))] } };
    case 'assistant-only':
      return { result: { messages: [text('assistant', 'only the assistant speaks')] } };
    case 'name.with spaces':
      return { result: { messages: [text('user', 'sanitized prompt body')] } };
    default:
      return { error: { code: -32602, message: `unknown prompt ${params.name}` } };
  }
}

function listPrompts(params) {
  if (mode === 'paged') {
    const page = Number(params?.cursor ?? '0');
    const prompts = Array.from({ length: 30 }, (_, index) => ({ name: `p${String(page * 30 + index).padStart(2, '0')}` }));
    return { result: { prompts, ...(page < 2 ? { nextCursor: String(page + 1) } : {}) } };
  }
  if (mode === 'endless') {
    const page = Number(params?.cursor ?? '0');
    return { result: { prompts: [{ name: `e${page}` }], nextCursor: String(page + 1) } };
  }
  if (mode === 'slow-list') return { never: true };
  if (mode === 'bad-list') return { error: { code: -32603, message: 'listing exploded' } };
  return { result: { prompts: PROMPTS } };
}

function respond(id, outcome) {
  if (outcome.never) return;
  const body = outcome.error === undefined ? { result: outcome.result } : { error: outcome.error };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
}

const promptsCapable = mode !== 'no-prompts';
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (log !== undefined) appendFileSync(log, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  if (message.id === undefined) return;
  if (mode === 'fail') process.exit(1);

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: promptsCapable ? { tools: {}, prompts: {} } : { tools: {} },
          serverInfo: { name: `prompts-fixture-${mode}`, version: '1.0.0' },
        },
      });
      break;
    case 'tools/list':
      respond(message.id, {
        result: { tools: promptsCapable ? [] : [{ name: 'noop', description: 'No-op.', inputSchema: { type: 'object', properties: {} } }] },
      });
      break;
    case 'prompts/list':
      respond(message.id, promptsCapable ? listPrompts(message.params) : { error: { code: -32601, message: 'Method not found' } });
      break;
    case 'prompts/get':
      respond(message.id, promptsCapable ? getPrompt(message.params) : { error: { code: -32601, message: 'Method not found' } });
      break;
    case 'ping':
      respond(message.id, { result: {} });
      break;
    default:
      respond(message.id, { error: { code: -32601, message: 'Method not found' } });
  }
});
