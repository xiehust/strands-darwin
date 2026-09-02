# SRF-020 serialize same-path fileEditor mutations per Agent

## Goal

Same-message `fileEditor` mutations to one file must apply in call order, and every
`status: "success"` result must describe what actually landed. Today the SDK's vended
`handleStrReplace`/`handleInsert`/`handleCreate` are readText → compute → writeText with no
lock, and darwin keeps the default `ConcurrentToolExecutor` (load-bearing invariant), so N
same-path edits in one assistant message each read the original and the last write wins while
every call reports success (session-20260902-054329719 lost 4 of 6 `str_replace` edits to
`src/config.ts`).

Backlog record: `docs/research/backlog/directions-061-080.md` § SRF-020 (Host-owned status).

## Requirements

- A darwin-side wrapper `Tool` around the SDK `fileEditor` singleton: same `name`, same
  `description`, same `toolSpec`, same result/error bytes. It delegates to the SDK tool's own
  `stream()` unchanged and adds nothing to results.
- Per-Agent state: a map from the resolved absolute path → promise chain. `create`,
  `str_replace` and `insert` on the same path await the previous chain entry before delegating,
  so each call reads what the previous one wrote. `view`, distinct paths, non-`fileEditor`
  tools, and calls without a usable absolute string path stay concurrent / delegate straight
  through. Settled entries are removed so the map cannot grow; a failed edit releases the chain.
- Installed for the parent Agent and for every `buildRecipeChild` child; a child never shares
  the parent's chain (state keyed per Agent).
- Never set `toolExecutor`. The pinned SDK patch and its error strings are untouched.
  Permission classification (`src/agent/permission.ts`), edit-diff rendering
  (`src/tui/edit-diff.ts`) and the trajectory record stay byte-identical because input and
  callback are untouched. `toolForName` / `agent.tools.find` return the wrapper and its spec.
- Path key resolution follows what the SDK actually writes: trailing separators stripped,
  absolute required (the SDK rejects relative paths itself), `path.resolve` normalization.

## Acceptance Criteria

- [x] New free suite `spike/verify-file-editor-serial.ts`, in the `pnpm test` list, drives a
      real `Agent` with a scripted model emitting N ≥ 4 disjoint `str_replace` on one file in one
      message; all N survive in call order and every result is `success`.
- [x] Same suite: a mixed batch (`view` + edits on two files) keeps unrelated calls concurrent
      (timing bound: a deliberately slow first edit must not delay the other file's edit).
- [x] Same suite: an `insert` after a length-changing `str_replace` on the same file in the
      same batch lands where the UPDATED file says.
- [x] Same suite: a child built via `buildRecipeChild` has a wrapped editor with per-Agent
      state isolated from the parent.
- [x] Same suite: a failed `str_replace` miss does not block a following edit on the same path,
      and the miss error text is byte-identical to the unwrapped SDK tool's.
- [x] `spike/verify-file-editor.ts` unchanged and green; `verify-edit-diff.ts`,
      `verify-codegraph-preflight.ts` green.
- [x] `pnpm typecheck` green; full `pnpm test` exit 0 with zero `FAIL` lines.
- [x] `.trellis/spec/backend/strands-sdk-contracts.md` gains the same-path ordering contract;
      `docs/architecture/load-bearing-decisions.md` gets a matching section; `AGENTS.md` gets
      ONE table row and stays under 32 KiB.

## Notes

- Lightweight task: PRD-only. Design is fixed by the backlog record (wrapper Tool, per-Agent
  chain, never `toolExecutor`).
- Install choice: substitute the wrapped instance in the runtime `tools:` list rather than
  `addOrReplace` after construction — `fileEditor` is a static singleton known before
  `initialize()`, unlike MCP-discovered tools, so there is no refresh callback to decorate and
  no window in which the raw tool is registered. Children receive the same wrapper through the
  existing `childTools` capture; per-Agent state comes from keying on `context.agent`
  (the SDK's own bash tool precedent: `WeakMap<Agent, …>`).
