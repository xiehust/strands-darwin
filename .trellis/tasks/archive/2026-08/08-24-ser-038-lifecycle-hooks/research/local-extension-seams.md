# SER-038 local extension-seam research

## Sources

- Product direction and peer evidence: `docs/research/research_2026-08-24.md`, SER-038 and sources S1–S5. This task does not modify that Host-owned report.
- Config/layer authority: `src/config.ts` (`hooksField`, `loadHookLayer`, `loadProjectPolicy`) and `src/paths.ts` (`hookExtensionRoots`).
- Existing command execution: `src/hooks/tool-hooks.ts`.
- Interactive turn publication: `src/tui/App.tsx` `runTurn`.
- Permission prompt identity/serialization: `src/tui/permission-queue.ts`; assessment source owner: `src/agent/permission.ts`.
- Headless turn publication: `src/headless-runner.ts`.
- Lifecycle ownership and `/clear`: `src/agent/runtime.ts`, `src/cli.ts`.
- Contracts: `.trellis/spec/backend/strands-sdk-contracts.md`, `.trellis/spec/backend/error-handling.md`, `.trellis/spec/backend/structured-headless-output.md`, and `docs/user-guide/extensions.md`.

## Confirmed constraints

1. Direct hook sources already aggregate in global `.agents`, global `.darwin`, project `.agents`, project `.darwin` order. `PostToolUse` alone reverses source order to close wrappers.
2. Tool hooks are SDK interventions and await hook commands because their output can deny/replace tool calls. Lifecycle hooks must be a separate observer runner, not another intervention.
3. `PermissionQueue` is the only place that knows whether an assessed request becomes the visible current prompt; publishing from the gate would duplicate re-decisions and queued/withdrawn requests.
4. Interactive `runTurn` and the headless runner already own final success/failure/cancel classification outside the SDK loop.
5. Existing shell-hook execution uses detached process groups, suppressed terminal streams, TERM then 500 ms KILL. Lifecycle work should reuse the process mechanics while adding session-scoped ownership rather than creating a second unmanaged spawn path.
6. Runtime replacement on `/clear` retires predecessor session resources while process-global resources remain alive. Lifecycle child ownership must follow the runtime/driver session so predecessor children are reaped.

## Change boundary

The behavior gap is two driver/permission observations over the existing hook configuration. It lives in configuration aggregation, a standalone lifecycle observer runner, the prompt queue publication seam, and interactive/headless turn completion seams. Expected source changes are limited to those owners plus runtime/CLI wiring and focused offline spikes. Documentation changes state the new exact contract.

Explicitly excluded: SDK Agent construction/loop changes, intervention events, generic plugin APIs, hook feedback channels, model/prompt changes, trajectory schema changes, terminal notices, and dependency additions.
