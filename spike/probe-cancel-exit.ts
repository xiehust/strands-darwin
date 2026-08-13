/**
 * Diagnostic: what keeps the event loop alive after a cancelled turn?
 *
 * Drives AgentRuntime directly (no Ink, no pty) so anything still holding the
 * loop belongs to the agent layer. Prints the active resources at the end.
 *
 * Expected today: a completed turn leaves only a pending file write and exits at
 * once, while a cancelled turn leaves a `TCPSocketWrap` — the model provider's
 * HTTP connection, which `BedrockModel.stream()` never aborts — and the process
 * would hang forever. This probe reports that and exits 7 by its own timer; the
 * real CLI survives it with the forced-exit backstop in `src/cli.ts`, which is
 * deliberately not in `AgentRuntime.shutdown()` (a runtime should not decide to
 * kill the process). So this script still ends in the STILL ALIVE branch, and
 * will keep doing so until the leak itself is fixed.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/probe-cancel-exit.ts
 *      PROBE_CANCEL=0 ... (control: same turn, no cancellation)
 */
import process from 'node:process';

import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';

const runtime = await AgentRuntime.create({
  projectRoot: '/tmp/darwin-cancel-probe',
  resume: false,
  permissionBridge: allowAllBridge,
});

/** PROBE_CANCEL=0 runs the same turn to completion, as a control. */
const doCancel = process.env['PROBE_CANCEL'] !== '0';

let deltas = 0;
const stream = runtime.send(
  doCancel
    ? 'Explain in about 400 words why code review matters. Do not use any tools, just write prose.'
    : 'Say the single word: ok. Do not use any tools.',
);

for await (const event of stream) {
  if (
    event.type === 'modelStreamUpdateEvent' &&
    event.event.type === 'modelContentBlockDeltaEvent' &&
    event.event.delta.type === 'textDelta'
  ) {
    deltas += 1;
    if (doCancel && deltas === 3) {
      console.log('cancelling after 3 text deltas');
      runtime.cancel();
    }
  }
  if (event.type === 'agentResultEvent') {
    console.log('stopReason:', event.result.stopReason);
  }
}

console.log(`stream ended after ${deltas} deltas`);
await runtime.shutdown();
console.log('shutdown done');
console.log('active resources:', JSON.stringify(process.getActiveResourcesInfo()));

const timer = setTimeout(() => {
  console.log('STILL ALIVE 10s after shutdown:', JSON.stringify(process.getActiveResourcesInfo()));
  process.exit(7);
}, 10_000);
timer.unref();
