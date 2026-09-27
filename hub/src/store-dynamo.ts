/**
 * DynamoDB Store (README §3). Same conditions as store-memory.ts, expressed as DynamoDB
 * condition expressions and one transaction for token redemption. `expiresAt` (ms) drives every
 * decision; `ttl` (s) only lets DynamoDB garbage-collect. AWS SDK imports live only in this file,
 * gateway-aws.ts, lambda/, infra/ and scripts/ (import boundary, README §12).
 */
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ConnectionRecord, EndpointRecord, MessageClaim, NodeRecord, Store } from './store.js';

export interface TableNames { nodes: string; tokens: string; connections: string; endpoints: string; replay: string }

const ttl = (expiresAt: number) => Math.ceil(expiresAt / 1000) + 3600;
const conditionFailed = (error: unknown) => error instanceof ConditionalCheckFailedException || error instanceof TransactionCanceledException;

export class DynamoStore implements Store {
  private readonly db: DynamoDBDocumentClient;
  constructor(private readonly tables: TableNames, client = new DynamoDBClient({})) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  private async scan<T>(table: string, limit: number): Promise<T[]> {
    const items: T[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new ScanCommand({ TableName: table, Limit: Math.min(limit - items.length, 256), ExclusiveStartKey: start, ConsistentRead: true }));
      items.push(...(page.Items ?? []) as T[]);
      start = page.LastEvaluatedKey;
    } while (start && items.length < limit);
    return items.slice(0, limit);
  }

  async getNode(node: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.nodes, Key: { node }, ConsistentRead: true }));
    return Item as NodeRecord | undefined;
  }
  listNodes() { return this.scan<NodeRecord>(this.tables.nodes, 1024); }

  async putToken(hash: string, expiresAt: number, note: string) {
    await this.db.send(new PutCommand({ TableName: this.tables.tokens, Item: { hash, expiresAt, note, ttl: ttl(expiresAt) } }));
  }

  async redeemToken(hash: string, now: number, node: NodeRecord) {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: this.tables.tokens, Key: { hash }, ConditionExpression: 'attribute_exists(#h) AND expiresAt > :now', ExpressionAttributeNames: { '#h': 'hash' }, ExpressionAttributeValues: { ':now': now } } },
        { Put: { TableName: this.tables.nodes, Item: node, ConditionExpression: 'attribute_not_exists(#n)', ExpressionAttributeNames: { '#n': 'node' } } },
      ] }));
      return true;
    } catch (error) { if (conditionFailed(error)) return false; throw error; }
  }

  async revokeNode(node: string, now: number) {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tables.nodes, Key: { node }, UpdateExpression: 'SET #s = :revoked, revokedAt = :now', ConditionExpression: '#s = :active', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':now': now } }));
      return true;
    } catch (error) { if (conditionFailed(error)) return false; throw error; }
  }

  async putConnection(record: ConnectionRecord) {
    await this.db.send(new PutCommand({ TableName: this.tables.connections, Item: { ...record, ttl: ttl(record.expiresAt) } }));
  }
  async getConnection(connectionId: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.connections, Key: { connectionId }, ConsistentRead: true }));
    return Item as ConnectionRecord | undefined;
  }
  async deleteConnection(connectionId: string) { await this.db.send(new DeleteCommand({ TableName: this.tables.connections, Key: { connectionId } })); }
  listConnections() { return this.scan<ConnectionRecord>(this.tables.connections, 1024); }

  async putEndpoint(record: EndpointRecord, now: number) {
    try {
      await this.db.send(new PutCommand({ TableName: this.tables.endpoints, Item: { ...record, ttl: ttl(record.expiresAt) }, ConditionExpression: 'attribute_not_exists(#e) OR #n = :node OR expiresAt <= :now', ExpressionAttributeNames: { '#e': 'endpoint', '#n': 'node' }, ExpressionAttributeValues: { ':node': record.node, ':now': now } }));
      return true;
    } catch (error) { if (conditionFailed(error)) return false; throw error; }
  }
  async getEndpoint(endpoint: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.endpoints, Key: { endpoint }, ConsistentRead: true }));
    return Item as EndpointRecord | undefined;
  }
  async deleteEndpoint(endpoint: string, connectionId?: string) {
    try {
      await this.db.send(new DeleteCommand({ TableName: this.tables.endpoints, Key: { endpoint }, ...(connectionId === undefined ? {} : { ConditionExpression: 'connectionId = :c', ExpressionAttributeValues: { ':c': connectionId } }) }));
    } catch (error) { if (!conditionFailed(error)) throw error; }
  }
  listEndpoints(limit: number) { return this.scan<EndpointRecord>(this.tables.endpoints, limit); }

  async claim(key: string, expiresAt: number, now: number, value?: MessageClaim) {
    try {
      await this.db.send(new PutCommand({ TableName: this.tables.replay, Item: { key, expiresAt, ttl: ttl(expiresAt), acked: false, ...(value ?? {}) }, ConditionExpression: 'attribute_not_exists(#k) OR expiresAt <= :now', ExpressionAttributeNames: { '#k': 'key' }, ExpressionAttributeValues: { ':now': now } }));
      return true;
    } catch (error) { if (conditionFailed(error)) return false; throw error; }
  }

  async acknowledge(key: string, connectionId: string, now: number) {
    try {
      const { Attributes } = await this.db.send(new UpdateCommand({ TableName: this.tables.replay, Key: { key }, UpdateExpression: 'SET acked = :t', ConditionExpression: 'targetConnection = :c AND acked = :f AND expiresAt > :now', ExpressionAttributeValues: { ':t': true, ':f': false, ':c': connectionId, ':now': now }, ReturnValues: 'ALL_NEW' }));
      return typeof Attributes?.['senderConnection'] === 'string' ? Attributes['senderConnection'] as string : undefined;
    } catch (error) { if (conditionFailed(error)) return undefined; throw error; }
  }

  async countWindow(key: string, limit: number, expiresAt: number) {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.tables.replay, Key: { key }, UpdateExpression: 'ADD #c :one SET expiresAt = if_not_exists(expiresAt, :exp), #t = if_not_exists(#t, :ttl)', ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit', ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':exp': expiresAt, ':ttl': ttl(expiresAt) } }));
      return true;
    } catch (error) { if (conditionFailed(error)) return false; throw error; }
  }
}
