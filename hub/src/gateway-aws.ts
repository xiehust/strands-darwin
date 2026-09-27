/** API Gateway @connections Gateway. `callbackUrl` is https://<apiId>.execute-api.<region>.amazonaws.com/<stage>. */
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GetConnectionCommand, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { Gateway } from './gateway.js';

export class AwsGateway implements Gateway {
  private readonly client: ApiGatewayManagementApiClient;
  constructor(callbackUrl: string) { this.client = new ApiGatewayManagementApiClient({ endpoint: callbackUrl }); }

  async post(connectionId: string, frame: string): Promise<'ok' | 'gone'> {
    try { await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(frame, 'utf8') })); return 'ok'; }
    catch (error) { if (error instanceof GoneException) return 'gone'; throw error; }
  }

  async close(connectionId: string): Promise<void> {
    try { await this.client.send(new DeleteConnectionCommand({ ConnectionId: connectionId })); }
    catch (error) { if (!(error instanceof GoneException)) throw error; }
  }

  async exists(connectionId: string): Promise<boolean> {
    try { await this.client.send(new GetConnectionCommand({ ConnectionId: connectionId })); return true; }
    catch (error) { if (error instanceof GoneException) return false; throw error; }
  }
}
