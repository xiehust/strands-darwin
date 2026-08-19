# Design

## API

Add `bash({ mode: 'wait', taskId, waitMs })`. `waitMs` is an integer in `[1, 30000]`. The result combines one normal status snapshot and one normal cursor-consuming output result plus `reason: 'output' | 'changed' | 'terminal' | 'timeout' | 'cancelled' | 'shutdown'`.

`wait` repeatedly performs a brief serialized output read plus status snapshot, sleeping outside the queue between probes. It returns immediately if a read has consumable text, another consumer advances the cursor, or the task is terminal. Otherwise it waits for caller abort, manager shutdown, or the deadline. This preserves the existing output cursor as the sole consumer authority; an incomplete UTF-8 suffix remains buffered rather than causing an empty model round.

## State-change mechanism

Use the manager's existing 20 ms bounded process poll interval plus a manager shutdown signal. Each pass briefly enters the per-task queue to read output and snapshot status, then releases the queue before an abort-aware delay. Return when output is consumable, log size changes (including bytes won by a concurrent cursor consumer), status becomes terminal, cancellation/shutdown fires, or the deadline expires.

Do not hold the task serialization queue while blocking: doing so would deadlock terminal completion and other output consumers. Only immediate reads/snapshots enter the existing queue.

## Cancellation and lifecycle

The wrapper passes `context?.agent.cancelSignal` to the manager. Cancellation resolves the wait with `reason: 'cancelled'`; it does not stop the background task. Shutdown resolves waits before reaping running process groups through the unchanged stop path. `wait` is read/safe because it cannot carry or dispatch a command.

## Validation

Extend `spike/verify-background-bash.ts` with real-process cases for immediate and delayed output, quiet timeout bounds, terminal wake, UTF-8 split growth, concurrent wait/output cursor ordering, cancellation, shutdown wake/reaping, schema forwarding, irrelevant fields, ids, and permission classification. Then run typecheck, the full offline suite, and the focused suite.
