import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AgentCoreConfig } from './config.js';

export type MemoryOperation = 'retrieve-memory-records' | 'get-memory-record' | 'create-event' | 'delete-memory-record';
/** No shell, pager, interactive prompt, payload argv, inherited endpoint, or unbounded output. */
export class MemoryCli {
  private active = new Set<() => void>();
  private extractionSupported: boolean | undefined;
  constructor(readonly config: AgentCoreConfig) {}
  cancel(): void { for (const cancel of this.active) cancel(); }
  async call(operation: MemoryOperation, input: object, signal?: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.run(operation, input, false, signal));
  }
  async requireExtraction(): Promise<void> {
    if (this.extractionSupported === undefined) {
      const skeleton = JSON.parse(await this.run('create-event', undefined, true));
      this.extractionSupported = skeleton.extractionConfig?.namespaceVariables !== undefined;
    }
    if (!this.extractionSupported) throw new Error('AWS CLI lacks CreateEvent extractionConfig.namespaceVariables; upgrade CLI before sending. Nothing uploaded.');
  }
  private run(operation: MemoryOperation, input?: object, skeleton = false, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('AgentCore request cancelled'));
    const payload = input === undefined ? '' : JSON.stringify(input);
    if (Buffer.byteLength(payload) > 32000) return Promise.reject(new Error('AgentCore input exceeds 32000 bytes'));
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (['HOME', 'PATH', 'LANG', 'TMPDIR'].includes(key) || /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|CONTAINER_CREDENTIALS_RELATIVE_URI|CONTAINER_CREDENTIALS_FULL_URI|CONTAINER_AUTHORIZATION_TOKEN_FILE|CONTAINER_AUTHORIZATION_TOKEN|EC2_METADATA_DISABLED|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME)$/.test(key)) env[key] = value;
      }
      Object.assign(env, { AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' });
      const args = ['bedrock-agentcore', operation, '--region', this.config.region, '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '3', '--cli-read-timeout', '4', ...(skeleton ? ['--generate-cli-skeleton', 'input'] : ['--cli-input-json', 'file:///dev/stdin'])];
      const child = spawn(this.config.cliPath, args, { shell: false, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      let output = ''; let bytes = 0; let errors = 0; let problem: string | undefined;
      const stop = (reason: string) => {
        problem ??= reason;
        try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const cancel = () => stop('AgentCore request cancelled');
      this.active.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => stop('AgentCore request timed out'), this.config.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 262144) stop('AgentCore output exceeds 256 KiB'); else output += decoder.write(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.length; if (errors > 8192) stop('AgentCore diagnostic output exceeds 8 KiB'); });
      child.stdin.on('error', () => {});
      child.on('error', () => { problem = 'AgentCore AWS CLI unavailable; check cliPath and AWS CLI prerequisite'; });
      child.on('close', (code) => {
        clearTimeout(timer); this.active.delete(cancel); signal?.removeEventListener('abort', cancel);
        if (problem !== undefined || code !== 0) reject(new Error(problem ?? `AgentCore CLI failed (exit ${code}); check region, credentials, IAM and resource configuration. Diagnostics omitted.`));
        else resolve(output + decoder.end());
      });
      child.stdin.end(payload);
    });
  }
}
