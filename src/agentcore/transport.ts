import { Readable } from 'node:stream';
import {
  BedrockAgentCoreClient, CreateEventCommand, RetrieveMemoryRecordsCommand,
  GetMemoryRecordCommand, DeleteMemoryRecordCommand,
  type BedrockAgentCoreClientConfig, type CreateEventCommandInput,
  type RetrieveMemoryRecordsCommandInput, type GetMemoryRecordCommandInput, type DeleteMemoryRecordCommandInput,
} from '@aws-sdk/client-bedrock-agentcore';
import type { AgentCoreConfig } from './config.js';

export type MemoryOperation = 'retrieve-memory-records' | 'get-memory-record' | 'create-event' | 'delete-memory-record';
type MemoryInputs = {
  'retrieve-memory-records': RetrieveMemoryRecordsCommandInput;
  'get-memory-record': GetMemoryRecordCommandInput;
  'create-event': Omit<CreateEventCommandInput, 'eventTimestamp'> & { eventTimestamp: string };
  'delete-memory-record': DeleteMemoryRecordCommandInput;
};
class TransportError extends Error {}
const refused = () => new TransportError('AgentCore response failed bounded validation; refused');

/** Preserve memory metadata; only the SDK's top-level envelope is removed. */
function normalize(value: unknown, depth = 0, budget = { count: 0 }): unknown {
  if (depth > 16 || ++budget.count > 10000) throw refused();
  if (value instanceof Date) { if (!Number.isFinite(value.getTime())) throw refused(); return value.toISOString(); }
  if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1, budget));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined && !(depth === 0 && key === '$metadata')).map(([key, item]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw refused();
      return [key, normalize(item, depth + 1, budget)];
    }));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw refused();
  return value;
}
// Smithy drops unknown structure fields. Reject them rather than laundering malformed
// remote records into our strict downstream policy schemas. Dates are normalized by SDK.
function knownFields(raw: unknown, decoded: unknown, depth = 0): void {
  if (depth > 16) throw refused();
  if (decoded instanceof Date) {
    if (!['string', 'number'].includes(typeof raw) || !Number.isFinite(decoded.getTime())) throw refused();
    return;
  }
  if (raw === null || typeof raw !== 'object') { if (raw !== decoded) throw refused(); return; }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(raw) !== Array.isArray(decoded)) throw refused();
  for (const [key, value] of Object.entries(raw)) {
    if ((depth === 0 && key === '$metadata') || !Object.hasOwn(decoded, key)) throw refused();
    knownFields(value, (decoded as Record<string, unknown>)[key], depth + 1);
  }
}

// Narrow test-only seam: real Commands and serialization/signing still run. No endpoint or credential override is exposed through host/model config.
type TransportTestOptions = Pick<BedrockAgentCoreClientConfig, 'requestHandler' | 'credentials'>;
let testOptions: (() => TransportTestOptions) | undefined;
export function setMemoryTransportOptionsForTest(factory?: () => TransportTestOptions): void { testOptions = factory; }

/** Official v3 data client only; manual outbox policy owns all retry/authorization. */
export class MemoryTransport {
  private readonly client: BedrockAgentCoreClient;
  private readonly credentialClient: BedrockAgentCoreClient;
  private active = new Set<() => void>();
  private requests = new Map<AbortSignal, { check: () => void; raw?: unknown }>();
  private closed = false;
  constructor(readonly config: AgentCoreConfig) {
    const defaults = {
      region: config.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: Math.min(3000, config.timeoutMs), requestTimeout: config.timeoutMs, throwOnRequestTimeout: true },
    };
    // The SDK's nested STS clients inherit HTTP configuration but not the memory
    // signal. Build the official chain with an independent, unguarded handler;
    // do not teach the memory handler to accept unaffiliated requests or STS XML.
    this.credentialClient = new BedrockAgentCoreClient({ ...defaults, ...testOptions?.() });
    const credentials = this.credentialClient.config.credentialDefaultProvider({
      // Credential services retain their standard profile/SSO region selection.
      clientConfig: { maxAttempts: 1, ignoreConfiguredEndpointUrls: true, requestHandler: this.credentialClient.config.requestHandler },
    });
    this.client = new BedrockAgentCoreClient({
      ...defaults,
      credentials: () => credentials(), // Never forward the guarded callerClientConfig.
      ...testOptions?.(),
      extensions: [{ configure: extension => {
        const handler = extension.httpHandler();
        extension.setHttpHandler({
          updateHttpClientConfig: (key, value) => handler.updateHttpClientConfig(key, value),
          httpHandlerConfigs: () => handler.httpHandlerConfigs(),
          destroy: () => handler.destroy?.(),
          handle: async (request, options) => {
            const signal = options?.abortSignal as AbortSignal;
            const state = this.requests.get(signal);
            if (!state) throw new TransportError('AgentCore request cancelled');
            state.check(); // Credential/signing awaits must never allow a late request.
            const result = await handler.handle(request, options);
            const body = result.response.body as Readable;
            const stop = () => body.destroy(new TransportError('AgentCore request cancelled'));
            signal.addEventListener('abort', stop, { once: true });
            try {
              state.check();
              if (!(body instanceof Readable)) throw refused();
              const error = result.response.statusCode >= 300;
              const cap = error ? 8192 : 262144;
              let bytes = 0; const chunks: Buffer[] = [];
              for await (const chunk of body) {
                state.check();
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > cap) throw new TransportError(error ? 'AgentCore error body exceeds 8 KiB' : 'AgentCore output exceeds 256 KiB');
                chunks.push(buffer);
              }
              state.check();
              const buffer = Buffer.concat(chunks, bytes);
              // Bound bytes before buffering/JSON parsing by Smithy; also bound structure
              // before its recursive deserializer. Keep raw keys to detect dropped fields.
              if (!error) state.raw = normalize(JSON.parse(buffer.toString('utf8') || '{}'), 1);
              result.response.body = buffer;
              return result;
            } finally { signal.removeEventListener('abort', stop); body.destroy(); }
          },
        });
      } }],
    });
  }
  cancel(): void { for (const cancel of this.active) cancel(); }
  destroy(): void { this.closed = true; this.cancel(); this.client.destroy(); this.credentialClient.destroy(); }
  async call<K extends MemoryOperation>(operation: K, input: MemoryInputs[K], signal?: AbortSignal): Promise<unknown> {
    if (this.closed || signal?.aborted) throw new TransportError('AgentCore request cancelled');
    if (Buffer.byteLength(JSON.stringify(input)) > 32000) throw new TransportError('AgentCore input exceeds 32000 bytes');
    if (input.memoryId !== this.config.memoryId) throw new TransportError('AgentCore resource mismatch');
    const controller = new AbortController();
    let problem: TransportError | undefined;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const stop = (reason: string) => {
      problem ??= new TransportError(reason); controller.abort(); rejectAbort(problem);
    };
    const cancel = () => stop('AgentCore request cancelled');
    const deadline = performance.now() + this.config.timeoutMs;
    const state: { check: () => void; raw?: unknown } = { check: () => {
      if (performance.now() >= deadline) stop('AgentCore request timed out');
      if (problem) throw problem;
      controller.signal.throwIfAborted();
    } };
    this.active.add(cancel); this.requests.set(controller.signal, state);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('AgentCore request timed out'), this.config.timeoutMs);
    try {
      const send = async () => {
        state.check();
        const options = { abortSignal: controller.signal };
        let pending: Promise<unknown>;
        switch (operation) {
          case 'create-event': {
            const body = input as MemoryInputs['create-event'];
            const eventTimestamp = new Date(body.eventTimestamp);
            if (!Number.isFinite(eventTimestamp.getTime()) || !body.clientToken) throw new TransportError('AgentCore invalid event timestamp or missing stable token');
            pending = this.client.send(new CreateEventCommand({ ...body, eventTimestamp }), options); break;
          }
          case 'retrieve-memory-records': pending = this.client.send(new RetrieveMemoryRecordsCommand(input as RetrieveMemoryRecordsCommandInput), options); break;
          case 'get-memory-record': pending = this.client.send(new GetMemoryRecordCommand(input as GetMemoryRecordCommandInput), options); break;
          case 'delete-memory-record': pending = this.client.send(new DeleteMemoryRecordCommand(input as DeleteMemoryRecordCommandInput), options); break;
          default: throw new TransportError('AgentCore operation refused');
        }
        const output = await pending;
        state.check();
        knownFields(state.raw, output);
        const normalized = normalize(output);
        state.check();
        return normalized;
      };
      return await Promise.race([send(), aborted]);
    } catch (error) {
      if (problem) throw problem;
      if (error instanceof TransportError) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      // Never echo service-controlled names/messages, request IDs, causes or credentials.
      throw new TransportError(`AgentCore SDK request failed${Number.isInteger(status) && status! >= 300 && status! <= 599 ? ` (HTTP ${status})` : ''}; check region, credentials, IAM and resource configuration. Diagnostics omitted.`);
    } finally {
      clearTimeout(timer); controller.abort(); this.active.delete(cancel);
      this.requests.delete(controller.signal); signal?.removeEventListener('abort', cancel);
    }
  }
}
