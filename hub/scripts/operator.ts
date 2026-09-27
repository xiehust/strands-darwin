/**
 * Operator context: the deployer's AWS credentials against the deployed tables and @connections.
 * Reads `cdk-outputs.json` (written by `pnpm deploy`); never a client-reachable path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsGateway } from '../src/gateway-aws.js';
import type { HubContext } from '../src/handlers.js';
import { DynamoStore } from '../src/store-dynamo.js';

const STACK = 'DarwinCollaborationHub';

export function outputs(): Record<string, string> {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cdk-outputs.json');
  let parsed: Record<string, Record<string, string>>;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`${file} missing: run pnpm stack-deploy first (it writes the stack outputs)`); }
  const values = parsed[STACK];
  if (!values) throw new Error(`${file} has no ${STACK} outputs`);
  return values;
}

export function operatorContext(): { ctx: HubContext; outputs: Record<string, string> } {
  const out = outputs();
  const ctx: HubContext = {
    store: new DynamoStore({ nodes: out['TableNodes']!, tokens: out['TableTokens']!, connections: out['TableConnections']!, endpoints: out['TableEndpoints']!, replay: out['TableReplay']! }),
    gateway: new AwsGateway(out['CallbackUrl']!),
    audience: `${out['WebSocketApiId']}/v1`,
    wsUrl: out['WebSocketUrl']!,
    now: Date.now,
    log: () => {},
  };
  return { ctx, outputs: out };
}
