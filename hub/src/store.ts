/**
 * Storage seam (README §3). Two implementations with the same conditional-write semantics:
 * store-memory.ts (local hub, tests) and store-dynamo.ts (Lambda). Every read that matters
 * compares `expiresAt` itself — TTL deletion is asynchronous and never a correctness input.
 * This module and its memory implementation import nothing but types: darwin's free suites
 * compile them (README §12, import boundary).
 */

export interface NodeRecord {
  node: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  enrolledAt: number;
  revokedAt?: number;
}

export interface ConnectionRecord { connectionId: string; node: string; connectedAt: number; expiresAt: number }

export interface EndpointRecord {
  endpoint: string;
  connectionId: string;
  node: string;
  project: string;
  session: string;
  expiresAt: number;
}

/** Message routing claim: who sent it, where it went, whether the target already acknowledged. */
export interface MessageClaim { senderConnection: string; targetConnection: string }

export interface Store {
  getNode(node: string): Promise<NodeRecord | undefined>;
  listNodes(): Promise<NodeRecord[]>;
  putToken(hash: string, expiresAt: number, note: string): Promise<void>;
  /** One transaction: delete an unexpired token and create a node that does not exist yet. */
  redeemToken(hash: string, now: number, node: NodeRecord): Promise<boolean>;
  /** active → revoked; false when absent or already revoked. */
  revokeNode(node: string, now: number): Promise<boolean>;

  putConnection(record: ConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | undefined>;
  deleteConnection(connectionId: string): Promise<void>;
  listConnections(): Promise<ConnectionRecord[]>;

  /** Create, or refresh when the existing record belongs to the same node; false otherwise. */
  putEndpoint(record: EndpointRecord, now: number): Promise<boolean>;
  getEndpoint(endpoint: string): Promise<EndpointRecord | undefined>;
  /** Delete; with `connectionId`, only when the record is still on that connection. */
  deleteEndpoint(endpoint: string, connectionId?: string): Promise<void>;
  listEndpoints(limit: number): Promise<EndpointRecord[]>;

  /** Put `key` unless an unexpired item exists (connect nonces, message ids). */
  claim(key: string, expiresAt: number, now: number, value?: MessageClaim): Promise<boolean>;
  /** Mark a message claim acknowledged once, only from its target connection; returns the sender connection. */
  acknowledge(key: string, connectionId: string, now: number): Promise<string | undefined>;
  /** Atomic increment of a windowed counter; false once `limit` is reached. */
  countWindow(key: string, limit: number, expiresAt: number): Promise<boolean>;
}
