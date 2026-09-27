/** In-memory Store with DynamoDB-equivalent conditions. Single process: each method is atomic. */
import type { ConnectionRecord, EndpointRecord, MessageClaim, NodeRecord, Store } from './store.js';

interface Claim { expiresAt: number; value?: MessageClaim; acked: boolean }

export class MemoryStore implements Store {
  readonly nodes = new Map<string, NodeRecord>();
  readonly tokens = new Map<string, { expiresAt: number; note: string }>();
  readonly connections = new Map<string, ConnectionRecord>();
  readonly endpoints = new Map<string, EndpointRecord>();
  readonly claims = new Map<string, Claim>();
  readonly counters = new Map<string, { count: number; expiresAt: number }>();

  async getNode(node: string) { const record = this.nodes.get(node); return record && { ...record }; }
  async listNodes() { return [...this.nodes.values()].map(record => ({ ...record })); }
  async putToken(hash: string, expiresAt: number, note: string) { this.tokens.set(hash, { expiresAt, note }); }

  async redeemToken(hash: string, now: number, node: NodeRecord) {
    const token = this.tokens.get(hash);
    if (!token || token.expiresAt <= now || this.nodes.has(node.node)) return false;
    this.tokens.delete(hash);
    this.nodes.set(node.node, { ...node });
    return true;
  }

  async revokeNode(node: string, now: number) {
    const record = this.nodes.get(node);
    if (!record || record.status !== 'active') return false;
    this.nodes.set(node, { ...record, status: 'revoked', revokedAt: now });
    return true;
  }

  async putConnection(record: ConnectionRecord) { this.connections.set(record.connectionId, { ...record }); }
  async getConnection(connectionId: string) { const record = this.connections.get(connectionId); return record && { ...record }; }
  async deleteConnection(connectionId: string) { this.connections.delete(connectionId); }
  async listConnections() { return [...this.connections.values()].map(record => ({ ...record })); }

  async putEndpoint(record: EndpointRecord, now: number) {
    const current = this.endpoints.get(record.endpoint);
    if (current && current.node !== record.node && current.expiresAt > now) return false;
    this.endpoints.set(record.endpoint, { ...record });
    return true;
  }
  async getEndpoint(endpoint: string) { const record = this.endpoints.get(endpoint); return record && { ...record }; }
  async deleteEndpoint(endpoint: string, connectionId?: string) {
    const current = this.endpoints.get(endpoint);
    if (current && (connectionId === undefined || current.connectionId === connectionId)) this.endpoints.delete(endpoint);
  }
  async listEndpoints(limit: number) { return [...this.endpoints.values()].slice(0, limit).map(record => ({ ...record })); }

  async claim(key: string, expiresAt: number, now: number, value?: MessageClaim) {
    const current = this.claims.get(key);
    if (current && current.expiresAt > now) return false;
    this.claims.set(key, { expiresAt, acked: false, ...(value ? { value: { ...value } } : {}) });
    return true;
  }

  async acknowledge(key: string, connectionId: string, now: number) {
    const current = this.claims.get(key);
    if (!current?.value || current.acked || current.expiresAt <= now || current.value.targetConnection !== connectionId) return undefined;
    current.acked = true;
    return current.value.senderConnection;
  }

  async countWindow(key: string, limit: number, expiresAt: number) {
    const current = this.counters.get(key) ?? { count: 0, expiresAt };
    if (current.count >= limit) return false;
    this.counters.set(key, { count: current.count + 1, expiresAt: current.expiresAt });
    return true;
  }
}
