/** Connection seam: API Gateway @connections (gateway-aws.ts) or the local server (local-server.ts). */
export interface Gateway {
  /** Deliver one text frame; 'gone' when the connection no longer exists. */
  post(connectionId: string, frame: string): Promise<'ok' | 'gone'>;
  /** Close a connection from the server side (revocation). Missing connections are ignored. */
  close(connectionId: string): Promise<void>;
  /**
   * Whether the connection still exists at the gateway. `$disconnect` is best-effort in API
   * Gateway, so a Connections row can outlive its socket; this is the authoritative check.
   */
  exists(connectionId: string): Promise<boolean>;
}
