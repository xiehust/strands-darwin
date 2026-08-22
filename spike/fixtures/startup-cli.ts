import { setTimeout as delay } from 'node:timers/promises';

import { ConfigError } from '../../src/config.js';
import {
  setRuntimeCreateCheckpointForTest,
  setRuntimeModelFactoryForTest,
} from '../../src/agent/runtime.js';
import { CaptureModel } from '../offline-model.js';

const delayMs = Number(process.env['DARWIN_STARTUP_FIXTURE_DELAY_MS'] ?? '0');
const mode = process.env['DARWIN_STARTUP_FIXTURE_MODE'] ?? 'ready';

setRuntimeModelFactoryForTest(async () => {
  if (delayMs > 0) await delay(delayMs);
  if (mode === 'config-error') throw new ConfigError('fixture startup configuration failed');
  return new CaptureModel('provider calls are forbidden in the startup fixture');
});
setRuntimeCreateCheckpointForTest(() => {
  const readyFile = process.env['DARWIN_STARTUP_FIXTURE_READY_FILE'];
  if (readyFile !== undefined) {
    void import('node:fs/promises').then(({ writeFile }) => writeFile(readyFile, 'ready\n'));
  }
});

await import('../../src/cli.js');
