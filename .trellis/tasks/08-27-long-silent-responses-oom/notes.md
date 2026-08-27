# Investigation evidence

## Production shape

- `trajectory.jsonl` sequence 560 is the user input at `2026-08-27T05:04:00.109Z`; the next line is a new process `runStarted` at `06:03:05.425Z`. No stream/tool/result/turn-end event was observed for the failed invocation.
- The captured crash reached roughly 4,047 MiB before repeated mark-compacts and `FATAL ERROR: Ineffective mark-compacts near heap limit`.
- The request/snapshot was about 1.23 MiB. The trajectory, snapshots, and background files were orders of magnitude below the retained heap.

## Confirmed cause

Darwin starts through `tsx` and did not set `NODE_ENV` before dynamically importing Ink/React. That selects `react-reconciler.development.js`. React 19's development reconciler calls `performance.measure()` for component commits; Node retains User Timing entries until explicitly cleared. `App` commits every 90 ms while status is `streaming`, including a provider-silent interval with zero SDK/trajectory events, so heap grows for the lifetime of the turn.

A real-App low-heap probe accelerated only the 90 ms timer and sampled after forced GC. With empty transcript history, 5,000 ticks grew from about 43 MiB at tick 500 to 82 MiB at tick 5,000. A V8 allocation profile put the dominant repeated allocation under `commitPassiveMountOnFiber -> logComponentRender -> performance.measure`. Replacing `performance.measure` before React import held the same probe around 39–40 MiB; selecting `NODE_ENV=production` held it around 38–39 MiB with zero measure entries. A 15,000-tick development control retained 30,003 measures and about 38.9 MiB; the production regression completes 10,000 ticks in a 96 MiB heap with zero measures and about 16 MiB forced-GC heap.

## Candidate controls

- Darwin trajectory records only after an SDK event; during the production silent interval it had no event to append or buffer. `recordStream` is a direct `for await` observer.
- Diagnostics are opt-in and the failed session had no diagnostics file. The writer is bounded even when enabled.
- SDK Meter/LocalTrace create one invocation/cycle/model object before awaiting the provider; there is no interval or repeated mutation while silent. OpenTelemetry is no-op unless a provider is registered.
- OpenAI request serialization is one stable body. The client timeout/retry path is bounded and does not run once streaming response headers have been returned.
- `openai@6.49.0` does retain SSE comment lines in `SSEDecoder.chunks` until a data event. A synthetic 64 KiB-comment stream reproduces that independent dependency defect, but there is no captured network evidence that Mantle emitted comments, and it is unnecessary to reproduce the incident's no-event growth. The exploratory patch was removed rather than expanding production scope without causation evidence.

## Fix

`src/tui/react-environment.ts` temporarily forces `NODE_ENV=production` around the first dynamic imports of Ink, React, `StartupScreen`, and therefore the whole TUI graph, then restores the caller's value. The override occurs before runtime/MCP assembly and does not affect headless, `sessions`, or trajectory commands. The 90 ms tick, direct streaming, frame budget, trajectory, telemetry, and context offload remain unchanged.
