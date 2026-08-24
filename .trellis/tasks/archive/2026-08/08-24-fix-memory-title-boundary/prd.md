# Fix learned-memory title boundary

## Goal

Prevent generated learned-memory topics with long prompt-derived titles from being rejected by the strict memory-state writer, so post-turn memory rebuilds complete without repeated `learned memory: refusing to write invalid memory state` warnings.

## Background

The affected project key is `-home-ubuntu-workspace-agentcore_cn_workshop--9a8de2665669e982daf62ed204d24d5380fe2e804eba94009ee57334288dc4f6`. Its existing `memory/state.json` is valid and byte-identical after diagnosis. Rebuilding from its five trajectory records deterministically creates a new topic whose title source exceeds 100 code points. `src/memory/store.ts:324-327` keeps 100 code points and then appends `…`, while `src/memory/state.ts:290` accepts at most 100; `writeMemoryState()` therefore refuses the derived state before writing it.

## Requirements

- Keep generated topic titles at or below the existing strict 100-code-point state limit, including any visible truncation marker.
- Preserve short titles byte-for-byte and retain the current visible `…` marker for long titles.
- Count Unicode code points rather than UTF-16 code units and never split a surrogate pair.
- Add focused regression coverage at the exact boundary and through a real memory-store rebuild/write path, not only a local string assertion.
- Preserve the affected project's existing memory while verifying the fix; diagnosis and acceptance must not delete or hand-edit its state.
- Capture the cross-layer lesson that producer bounds must include markers and agree with the strict consumer schema.

## Acceptance Criteria

- [x] A 100-code-point prompt produces the same 100-code-point title with no marker.
- [x] A prompt over 100 code points produces exactly 100 code points including the final `…`.
- [x] A Unicode boundary case contains no replacement character or split surrogate pair.
- [x] `rebuildMemoryStore()` succeeds for the reproduced affected-project trajectory shape and writes a state accepted by `readMemoryState()`.
- [x] Existing learned-memory tests, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [x] A non-mutating reconstruction of the affected project's current trajectories validates successfully with the fixed producer. The exact before/after shadow-verification hash was unchanged; a separately running Darwin process later refreshed only validation metadata in the live state, so no claim is made that the live file stayed process-globally static throughout the session.

## Out of Scope

- Changing the 100-code-point schema limit.
- Repairing, deleting, or rewriting the user's existing memory by hand.
- Changing fact extraction, title sensitivity filtering, memory eligibility, validation anchors, or scheduler behavior.
- Adding dependencies or a generic truncation framework.
