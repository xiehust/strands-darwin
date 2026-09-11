/** Test-only HTTP seam: signed SDK requests go exclusively to a loopback server. */
import { request } from 'node:http';
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';

export function loopbackHandler(port: number): BedrockAgentCoreClient['config']['requestHandler'] {
  const active = new Set<ReturnType<typeof request>>();
  return {
    updateHttpClientConfig() {}, httpHandlerConfigs: () => ({}),
    destroy() { for (const req of active) req.destroy(); },
    handle: async (input, options) => new Promise((resolve, reject) => {
      const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      if (signal?.aborted) { reject(new Error('Aborted')); return; }
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(input.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) query.append(key, item ?? '');
      const req = request({ hostname: '127.0.0.1', port, method: input.method, path: input.path + (query.size ? `?${query}` : ''), headers: input.headers }, response => {
        resolve({ response: { statusCode: response.statusCode!, headers: response.headers as Record<string, string>, body: response } });
      });
      active.add(req);
      const abort = () => req.destroy(new Error('Aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', reject);
      req.on('close', () => { active.delete(req); signal?.removeEventListener('abort', abort); });
      req.end(input.body);
    }),
  };
}

const port = Number(process.env['DARWIN_TEST_AGENTCORE_PORT']);
if (port) setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port) }));
