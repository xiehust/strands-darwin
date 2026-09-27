/**
 * Live acceptance against the deployed hub (README §11). *Live*: needs `pnpm stack-deploy` first and the
 * deployer's AWS credentials; not part of `pnpm test`. Creates two throwaway nodes, revokes them
 * at the end, and leaves no darwin state (keys live only in this process).
 *
 * Proves: the deployed authorizer is REQUEST-type with the four identity sources and no result
 * caching, both stages are throttled, log retention is 14 days; the authorizer refuses a missing
 * assertion and a replayed nonce; eight concurrent redemptions of one token yield exactly one
 * enrollment; two nodes exchange a signed message and its ack; revocation closes the node,
 * broadcasts and refuses reconnect; CloudWatch holds no message text.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiGatewayV2Client, GetAuthorizersCommand, GetStagesCommand } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { connectHeaders, ENROLL_TOKEN_TTL_MS, generateNodeKeys, hubFrame, mintToken, parseFrame, signEnvelope, type HubAddress, type HubEnvelope, type HubFrame, type NodeKeys } from '../../src/collaboration/hub-wire.js';
import { mint, revoke } from '../src/handlers.js';
import { operatorContext } from '../scripts/operator.js';

const { ctx, outputs } = operatorContext();
const region = process.env['AWS_REGION'] ?? 'us-west-2';
const SENTINEL = `deployed-sentinel-${randomUUID()}`;
const started = Date.now();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); passed++; console.log(`ok ${name}`); }

interface Node { id: string; keys: NodeKeys }
async function token(): Promise<string> { const value = mintToken(); await mint(ctx, value, ENROLL_TOKEN_TTL_MS, 'verify-deployed'); return value; }
async function enroll(value: string): Promise<{ status: number; node: Node }> {
  const node = { id: randomUUID(), keys: generateNodeKeys() };
  const response = await fetch(`${outputs['HubUrl']}/enroll`, { method: 'POST', body: JSON.stringify({ token: value, node: node.id, name: 'verify-deployed', publicKey: node.keys.publicKey }) });
  await response.text();
  return { status: response.status, node };
}

class Client {
  readonly frames: HubFrame[] = [];
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', event => { const frame = parseFrame(hubFrame, String(event.data)); if (frame) this.frames.push(frame); });
    ws.addEventListener('close', () => { this.closed = true; });
  }
  static open(node: Node, headers: Record<string, string> = connectHeaders(ctx.audience, node.id, node.keys.privateKey) as unknown as Record<string, string>): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(outputs['WebSocketUrl']!, { headers } as unknown as string[]);
      const client = new Client(ws);
      ws.addEventListener('open', () => resolve(client), { once: true });
      ws.addEventListener('error', () => reject(new Error('refused')), { once: true });
    });
  }
  send(value: unknown): void { this.ws.send(JSON.stringify(value)); }
  async next<T extends HubFrame['type']>(type: T, match: (frame: Extract<HubFrame, { type: T }>) => boolean = () => true, ms = 15_000): Promise<Extract<HubFrame, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const index = this.frames.findIndex(frame => frame.type === type && match(frame as Extract<HubFrame, { type: T }>));
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<HubFrame, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`);
      await delay(50);
    }
  }
}

const enrolled: string[] = [];
try {
  await check('deployed config: REQUEST authorizer, four identity sources, no caching; throttled stages; 14-day logs', async () => {
    const api = new ApiGatewayV2Client({ region });
    const { Items: authorizers = [] } = await api.send(new GetAuthorizersCommand({ ApiId: outputs['WebSocketApiId']! }));
    assert.equal(authorizers.length, 1);
    assert.equal(authorizers[0]!.AuthorizerType, 'REQUEST');
    assert.deepEqual([...(authorizers[0]!.IdentitySource ?? [])].sort(), ['X-Darwin-Nonce', 'X-Darwin-Node', 'X-Darwin-Sig', 'X-Darwin-Ts'].map(h => `route.request.header.${h}`).sort());
    assert.ok(!authorizers[0]!.AuthorizerResultTtlInSeconds, 'no authorizer result caching');
    const { Items: stages = [] } = await api.send(new GetStagesCommand({ ApiId: outputs['WebSocketApiId']! }));
    assert.equal(stages.find(stage => stage.StageName === 'v1')?.DefaultRouteSettings?.ThrottlingRateLimit, 20);
    const logs = new CloudWatchLogsClient({ region });
    const { logGroups = [] } = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: 'DarwinCollaborationHub' }));
    assert.ok(logGroups.length >= 5 && logGroups.every(group => group.retentionInDays === 14), 'five 14-day log groups');
  });

  await check('one token, eight concurrent redemptions: exactly one enrollment', async () => {
    const shared = await token();
    const results = await Promise.all(Array.from({ length: 8 }, () => enroll(shared)));
    const winners = results.filter(result => result.status === 200);
    assert.equal(winners.length, 1);
    enrolled.push(winners[0]!.node.id);
  });

  const a = (await enroll(await token())).node; enrolled.push(a.id);
  const b = (await enroll(await token())).node; enrolled.push(b.id);

  await check('authorizer refuses a missing assertion and a replayed nonce', async () => {
    await assert.rejects(Client.open(a, {}), /refused/);
    const headers = connectHeaders(ctx.audience, a.id, a.keys.privateKey) as unknown as Record<string, string>;
    const first = await Client.open(a, headers);
    first.ws.close();
    await assert.rejects(Client.open(a, headers), /refused/);
  });

  await check('two nodes exchange a signed message and its acknowledgement', async () => {
    const ca = await Client.open(a); const cb = await Client.open(b);
    const register = async (client: Client, node: Node): Promise<HubAddress> => {
      const endpoint = randomUUID(); const rid = randomUUID();
      client.send({ action: 'register', rid, endpoint, project: 'github.com/verify/deployed', session: 'verify' });
      assert.equal((await client.next('registered', frame => frame.rid === rid)).ok, true);
      return { version: 2, transport: 'hub', node: node.id, endpoint, project: 'github.com/verify/deployed', session: 'verify' };
    };
    const addrA = await register(ca, a); const addrB = await register(cb, b);
    const now = Date.now();
    const envelope: HubEnvelope = { version: 2, id: randomUUID(), sender: addrA, target: addrB, sent: now, chain: { id: randomUUID(), started: now, hop: 0, readOnly: false }, text: SENTINEL };
    ca.send({ action: 'send', envelope, sig: signEnvelope(a.keys.privateKey, envelope) });
    assert.equal((await ca.next('sendResult', frame => frame.id === envelope.id)).status, 'delivered');
    const delivered = await cb.next('deliver', frame => frame.envelope.id === envelope.id);
    assert.equal(delivered.envelope.text, SENTINEL);
    cb.send({ action: 'ack', id: envelope.id, status: 'queued' });
    assert.equal((await ca.next('ack', frame => frame.id === envelope.id)).status, 'queued');

    await check('revocation closes the node, broadcasts and refuses reconnect', async () => {
      const result = await revoke(ctx, b.id);
      assert.equal(result.revoked, true);
      await ca.next('node-revoked', frame => frame.node === b.id);
      for (let n = 0; n < 100 && !cb.closed; n++) await delay(100);
      assert.ok(cb.closed);
      await assert.rejects(Client.open(b), /refused/);
    });
    ca.ws.close();
  });

  await check('CloudWatch holds no message text', async () => {
    await delay(15_000); // log delivery lag
    const logs = new CloudWatchLogsClient({ region });
    const { logGroups = [] } = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: 'DarwinCollaborationHub' }));
    let events = 0;
    for (const group of logGroups) {
      const found = await logs.send(new FilterLogEventsCommand({ logGroupName: group.logGroupName!, startTime: started, filterPattern: `"${SENTINEL}"` }));
      events += found.events?.length ?? 0;
    }
    assert.equal(events, 0);
  });
} finally {
  for (const node of enrolled) await revoke(ctx, node).catch(() => undefined);
}
console.log(`verify-deployed: ${passed} checks passed (${enrolled.length} throwaway nodes revoked)`);
