/**
 * darwin collaboration hub stack (README §3, §12): API Gateway WebSocket (authorizer on $connect,
 * $default → message) + HTTP API (/enroll, /time) + Lambda (Node 22, arm64) + DynamoDB.
 * Only the stage name `v1` is a literal: ARNs and the callback URL are built from apiId + stage
 * so no Stage → Lambda-policy dependency cycle exists.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGE = 'v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, '..');
const repoRoot = path.resolve(hubRoot, '..');

export interface HubStackProps extends StackProps {
  /** Reserved concurrency per function; 0 leaves it unreserved (default, safe on low-quota accounts). */
  reservedConcurrency?: number;
}

export class HubStack extends Stack {
  constructor(scope: Construct, id: string, props: HubStackProps = {}) {
    super(scope, id, props);

    const table = (name: string, key: string, retain = false) => new Table(this, name, {
      partitionKey: { name: key, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retain },
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const tables = {
      nodes: table('Nodes', 'node', true),
      tokens: table('Tokens', 'hash'),
      connections: table('Connections', 'connectionId'),
      endpoints: table('Endpoints', 'endpoint'),
      replay: table('Replay', 'key'),
    };

    const ws = new WebSocketApi(this, 'HubWebSocket', { routeSelectionExpression: '$request.body.action' });
    const http = new HttpApi(this, 'HubHttp', { createDefaultStage: false });
    const wsUrl = `wss://${ws.apiId}.execute-api.${this.region}.${this.urlSuffix}/${STAGE}`;
    const callbackUrl = `https://${ws.apiId}.execute-api.${this.region}.${this.urlSuffix}/${STAGE}`;
    const reserved = props.reservedConcurrency ?? 0;

    const fn = (name: string, handler: string) => {
      const logGroup = new LogGroup(this, `${name}Logs`, { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
      const f = new NodejsFunction(this, name, {
        entry: path.join(hubRoot, 'src/lambda/index.ts'),
        handler,
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        logGroup,
        ...(reserved > 0 ? { reservedConcurrentExecutions: reserved } : {}),
        projectRoot: repoRoot,
        depsLockFilePath: path.join(hubRoot, 'pnpm-lock.yaml'),
        // ESM (.mjs): the extension fixes the module type wherever the bundle is loaded.
        bundling: { format: OutputFormat.ESM, minify: true, sourceMap: false, target: 'node22', banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
        environment: {
          TABLE_NODES: tables.nodes.tableName,
          TABLE_TOKENS: tables.tokens.tableName,
          TABLE_CONNECTIONS: tables.connections.tableName,
          TABLE_ENDPOINTS: tables.endpoints.tableName,
          TABLE_REPLAY: tables.replay.tableName,
          CALLBACK_URL: callbackUrl,
          AUDIENCE: `${ws.apiId}/${STAGE}`,
          WS_URL: wsUrl,
        },
      });
      for (const t of Object.values(tables)) t.grantReadWriteData(f);
      f.addToRolePolicy(new PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [this.formatArn({ service: 'execute-api', resource: ws.apiId, resourceName: `${STAGE}/*/@connections/*` })],
      }));
      return f;
    };

    const authorizerFn = fn('Authorizer', 'authorizer');
    const connectFn = fn('Connect', 'onConnect');
    const disconnectFn = fn('Disconnect', 'onDisconnect');
    const messageFn = fn('Message', 'onMessage');
    const httpFn = fn('Http', 'onHttp');

    // Identity sources name all four headers: a request missing any is refused before invocation.
    // WebSocket Lambda authorizers do not cache results; verify-deployed reads the config to prove it.
    const authorizer = new WebSocketLambdaAuthorizer('ConnectAuthorizer', authorizerFn, {
      identitySource: ['X-Darwin-Node', 'X-Darwin-Ts', 'X-Darwin-Nonce', 'X-Darwin-Sig'].map(h => `route.request.header.${h}`),
    });
    ws.addRoute('$connect', { integration: new WebSocketLambdaIntegration('ConnectIntegration', connectFn), authorizer });
    ws.addRoute('$disconnect', { integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectFn) });
    ws.addRoute('$default', { integration: new WebSocketLambdaIntegration('MessageIntegration', messageFn) });
    new WebSocketStage(this, 'HubWebSocketStage', { webSocketApi: ws, stageName: STAGE, autoDeploy: true, throttle: { rateLimit: 20, burstLimit: 50 } });

    const httpIntegration = new HttpLambdaIntegration('HttpIntegration', httpFn);
    http.addRoutes({ path: '/enroll', methods: [HttpMethod.POST], integration: httpIntegration });
    http.addRoutes({ path: '/time', methods: [HttpMethod.GET], integration: httpIntegration });
    new CfnStage(this, 'HubHttpStage', { apiId: http.apiId, stageName: '$default', autoDeploy: true, defaultRouteSettings: { throttlingRateLimit: 2, throttlingBurstLimit: 5 } });

    new CfnOutput(this, 'HubUrl', { value: `https://${http.apiId}.execute-api.${this.region}.${this.urlSuffix}` });
    new CfnOutput(this, 'WebSocketUrl', { value: wsUrl });
    new CfnOutput(this, 'WebSocketApiId', { value: ws.apiId });
    new CfnOutput(this, 'CallbackUrl', { value: callbackUrl });
    for (const [name, t] of Object.entries(tables)) new CfnOutput(this, `Table${name[0]!.toUpperCase()}${name.slice(1)}`, { value: t.tableName });
  }
}
