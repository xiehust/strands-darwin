/** Real Ink/CLI queue delivery: two model calls in one turn, no idle resend. */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-steering-pty-'));
let tui: TuiSession | undefined;
let passed = false;
try {
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await mkdir(path.join(home, '.darwin'), { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ provider: 'openai', model: 'fixture.steering', memory: false, contextOffload: false, updateCheck: false, promptSuggestions: false, sessionRecap: false }));
  tui = startTui({ cwd, cols: 110, rows: 32, args: ['--yolo'], entry: path.join(REPO_ROOT, 'spike/fixtures/prompt-steering-cli.ts'),
    env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' } });
  await tui.waitUntil(() => tui!.frame.split('\n').some(line => line.trim() === 'you>'), { timeoutMs: 10_000 });
  tui.submitChunk('Read first, then continue working.');
  await tui.waitFor('STEERING_WAIT', { timeoutMs: 10_000 });
  tui.submitChunk('Do not edit; explain instead.');
  await tui.waitFor('queued · Do not edit; explain instead.', { timeoutMs: 5000 });
  await writeFile(path.join(cwd, 'release'), 'ready');
  await tui.waitFor('CORRECTION_VISIBLE_IN_CURRENT_TURN', { timeoutMs: 10_000 });
  await tui.waitUntil(() => tui!.frame.split('\n').some(line => line.trim() === 'you>') && !tui!.frame.includes('queued ·'), { timeoutMs: 10_000, settleMs: 300 });
  const calls = (await readFile(path.join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2, 'no third call from an idle resend');
  // SDK toJSON uses wire keys, not the live ContentBlock.type discriminator.
  assert.deepEqual(calls[1].content.map((block: object) => Object.keys(block)), [['toolResult'], ['text']]);
  assert.equal(calls[1].content[1].text, 'Do not edit; explain instead.');
  tui.submitChunk('/exit');
  assert.equal(await tui.exitedWithin(5000), 0);
  passed = true;
  console.log('PASS steering PTY: queued correction joins the current tool-result turn exactly once');
} finally {
  tui?.kill();
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`steering PTY artifacts: ${root}`);
}
