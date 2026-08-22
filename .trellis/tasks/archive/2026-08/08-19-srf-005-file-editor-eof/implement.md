# Implementation plan

1. Record the installed SDK `fileEditor` schema, direct runtime assembly, validation order, and
   pre-fix oversized-end failure; select the existing pinned patch seam.
2. Extend only SDK `applyViewRange()` so valid positive ends above EOF clamp for non-empty regular
   text while all other bounds retain explicit validation.
3. Add a focused provider-facing real-file suite and register it in the offline project gate.
4. Run the focused suite while editing; after source settles run typecheck and the full offline
   suite once, plus diff/patch/Trellis integrity checks.
5. Update the SDK contract and task check evidence, archive the Trellis task, and commit without
   modifying Host-owned backlog, reflection, or iteration-log evidence.
