# SER-040 implementation plan

1. Add focused checkpoint-catalogue primitives and tests: bounded schema/read/append, SDK immutable-id observation, no trajectory dependency.
2. Extend runtime assembly with manual pre-invocation immutable saves, successful-turn promotion, strict source checkpoint validation and fresh successor restore. Prove source/pointer/workspace immutability, failure/resume honesty and inherited ownership offline.
3. Add the bounded `/rewind` chooser and integrate command handling/editor return/notices/busy refusal into the TUI. Add pure chooser tests and a free pty scenario.
4. Add command completion/help coverage and increase `MAX_COMPLETIONS`.
5. Update backend/frontend specs, load-bearing architecture docs, AGENTS index and SER-040 implementation evidence/status.
6. Run focused tests, then `pnpm typecheck`, free completion and rewind pty scenarios, full `pnpm test`, `pnpm build`, Trellis validation and git checks. Fix findings without broad refactors.
7. Finish/archive the Trellis task and commit all accepted changes, preserving `f3b3003` in history.

## Verification pyramid

- Pure/offline: catalogue parsing/bounds, chooser transitions, queue refusal, help/completion.
- Runtime integration with deterministic local model: initial and pre-invocation boundaries, failed/cancelled turns, `trajectory:false`, source byte identity, restored state and prompt contracts, pointer timing, inherited resources.
- Free pty: `/rewind` opens, selects, creates a fresh header/session, restores prompt to editor, emits omission notice, makes no model call.
- Full project gate: typecheck, all fast tests, build, Trellis task validation, diff/status, AGENTS byte cap.

## Implementation verification

- Runtime checkpoint/branch contracts: `pnpm tsx spike/verify-rewind.ts` — 15 passed.
- Chooser state: `pnpm tsx spike/verify-rewind-search.ts` — 7 passed.
- Free pty: `rewind` — 7 passed; `completion` — 67 passed.
- Adjacent focused checks: help 26, prompt completion 11, prompt queue 28, frame budget 80; all passed.
- Final project gate: `pnpm typecheck`, full `pnpm test`, and `pnpm build` passed without provider calls.
- Repository checks: Trellis manifests valid, `git diff --check` clean, `AGENTS.md` 26,530 bytes, and `f3b3003` remains an ancestor.
- This is implementation evidence only; separate Host acceptance is not claimed.
