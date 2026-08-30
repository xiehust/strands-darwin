# Design — `/workflow` built-in command

## Shape

A prompt-expanding built-in, not a local command: `/workflow <args>` rewrites the input into
one fixed-template prompt and continues down the ordinary submit path. It is the third
expansion kind next to skills and custom commands.

## Pieces

1. **`src/commands/workflow-command.ts` (new, pure).**
   - `WORKFLOW_COMMAND_NAME = 'workflow'`.
   - `parseWorkflowCommand(input): { message: string } | 'missing-task' | null`
     - `null` when the input is not `/workflow` (parse mirrors `expandCustomCommand`:
       trim, leading `/`, name up to first whitespace, case-insensitive match).
     - `'missing-task'` when args are empty/whitespace.
     - Otherwise the expanded message: fixed instruction template naming the `workflow`
       tool, restating the DAG bounds (≤8 nodes, edges = dependency + report handoff) and
       the reads-parallel / writes-serialized rule, with the user's description embedded
       verbatim under a `Task:` marker. Include an escape hatch ("if the task is truly
       indivisible, handle it directly and say why") so the model is steered, not forced.
   - `WORKFLOW_COMMAND_USAGE` — the bounded usage notice string, shared by TUI and dev-repl.

2. **`ExpandedSlashCommand` union grows `{ kind: 'workflow'; message: string }`**
   (`src/agent/runtime.ts`). `expandSlashCommand` checks the workflow command *first*
   (built-in reservation precedes skills/custom commands), returning the expansion for
   non-empty args. `'missing-task'` returns `null` from the runtime — the *drivers* own the
   local usage response (see 4) — so the runtime never fabricates a turn.

3. **Name registration** (`src/commands/custom-commands.ts`): add `'workflow'` to
   `BUILTIN_COMMAND_NAMES` (after `'usage'`, keeping alphabetical display order) and a
   one-phrase description to `BUILTIN_COMMAND_DESCRIPTIONS` (the total `Record` forces this
   at compile time). `RESERVED_COMMAND_NAMES` and `/help` inherit automatically.
   `MAX_COMPLETIONS` 19 → 20 (`src/tui/InputBox.tsx`).

4. **Drivers.**
   - TUI (`src/tui/App.tsx`): handle bare `/workflow` (exact, or `/workflow` + whitespace
     only) as a local notice `WORKFLOW_COMMAND_USAGE` before the generic expansion block —
     same pattern as `/compact takes no arguments`. The expansion notice ternary gains the
     `workflow` kind (e.g. `delegating via the workflow tool`).
   - dev-repl: same bare-command usage notice; expansion already flows through
     `expandSlashCommand`.
   - headless (`src/headless.ts` / `headless-protocol.ts`): expansion flows through the
     existing `expandSlashCommand` call sites unchanged; a bare `/workflow` prompt falls
     through as ordinary input (documented, matches unknown-command behaviour today).

## What deliberately does not change

- `WorkflowTool`, its schema, bounds, child recipe, dispatch registry.
- Queueing (SER-027): `/workflow …` is not on the busy refuse list, so it queues like any
  prompt and expands at drain time through the same `submit()` path.
- Trajectory: `userInput` records what the model received, exactly as for skills/custom
  commands today. No new record type.

## Tests

- New `spike/verify-workflow-command.ts` (offline, added to `run-tests.ts`): parse cases
  (null / missing-task / expansion embeds args verbatim and names the tool), collision
  (custom command named `workflow` rejected), description/name registration invariants.
- `spike/verify-tui.ts completion` re-run (free): menu shows all 19 built-ins, cap 20.
- Existing `verify-help-command.ts`, `verify-custom-commands.ts` keep passing.
