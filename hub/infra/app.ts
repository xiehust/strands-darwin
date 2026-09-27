/** CDK app. `-c reservedConcurrency=<n>` reserves Lambda concurrency per function (default 0). */
import { App } from 'aws-cdk-lib';
import { HubStack } from './hub-stack.js';

const app = new App();
const reserved = Number(app.node.tryGetContext('reservedConcurrency') ?? 0);
const account = process.env['CDK_DEFAULT_ACCOUNT'];
new HubStack(app, 'DarwinCollaborationHub', {
  env: { ...(account ? { account } : {}), region: process.env['CDK_DEFAULT_REGION'] ?? 'us-west-2' },
  reservedConcurrency: Number.isInteger(reserved) && reserved > 0 ? reserved : 0,
  description: 'darwin collaboration hub: relay and node directory for cross-machine collaboration (hub/README.md)',
});
