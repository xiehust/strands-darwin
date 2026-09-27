/**
 * Lambda entry points: thin adapters from API Gateway events to handlers.ts, wired to DynamoDB
 * and @connections. Configuration comes only from environment variables set by the CDK stack.
 */
import { AwsGateway } from '../gateway-aws.js';
import { authorize, connect, disconnect, enroll, message, time, type HubContext } from '../handlers.js';
import { DynamoStore } from '../store-dynamo.js';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

let cached: HubContext | undefined;
function ctx(): HubContext {
  cached ??= {
    store: new DynamoStore({ nodes: env('TABLE_NODES'), tokens: env('TABLE_TOKENS'), connections: env('TABLE_CONNECTIONS'), endpoints: env('TABLE_ENDPOINTS'), replay: env('TABLE_REPLAY') }),
    gateway: new AwsGateway(env('CALLBACK_URL')),
    audience: env('AUDIENCE'),
    wsUrl: env('WS_URL'),
    now: Date.now,
    // Structured fields only (ids, sizes, outcomes); handlers never pass text, tokens or signatures.
    log: fields => console.log(JSON.stringify(fields)),
  };
  return cached;
}

interface AuthorizerEvent { methodArn: string; headers?: Record<string, string | undefined> }
interface WebSocketEvent { requestContext: { connectionId: string; authorizer?: Record<string, unknown> }; body?: string; isBase64Encoded?: boolean }
interface HttpEvent { rawPath: string; requestContext: { http: { method: string } }; body?: string; isBase64Encoded?: boolean }

const policy = (effect: 'Allow' | 'Deny', resource: string, context?: Record<string, string>) => ({
  principalId: context?.['node'] ?? 'unauthenticated',
  policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] },
  ...(context ? { context } : {}),
});

export async function authorizer(event: AuthorizerEvent) {
  const verdict = await authorize(ctx(), event.headers);
  return verdict.allow ? policy('Allow', event.methodArn, { node: verdict.node }) : policy('Deny', event.methodArn);
}

export async function onConnect(event: WebSocketEvent) {
  const node = event.requestContext.authorizer?.['node'];
  if (typeof node !== 'string') return { statusCode: 403 };
  await connect(ctx(), event.requestContext.connectionId, node);
  return { statusCode: 200 };
}

export async function onDisconnect(event: WebSocketEvent) {
  await disconnect(ctx(), event.requestContext.connectionId);
  return { statusCode: 200 };
}

export async function onMessage(event: WebSocketEvent) {
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  await message(ctx(), event.requestContext.connectionId, body);
  return { statusCode: 200 };
}

export async function onHttp(event: HttpEvent) {
  const method = event.requestContext.http.method;
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  const result = method === 'GET' && event.rawPath === '/time' ? time(ctx())
    : method === 'POST' && event.rawPath === '/enroll' && Buffer.byteLength(body) <= 4096 ? await enroll(ctx(), body)
      : { status: 404, body: '{"ok":false}' };
  return { statusCode: result.status, headers: { 'content-type': 'application/json' }, body: result.body };
}
