# Implementation plan — SER-032

1. Extend the SER-031 store with validated bounded state, projections, suppression, user notes, and serialized management operations.
2. Add verified live prompt replacement and the runtime-only management seam.
3. Add strict `/memory` grammar/formatting and wire canonical completion/help/TUI dispatch with bounded output.
4. Add focused offline verification and register it in `pnpm test`.
5. Update architecture, backend/frontend specs, README/help documentation, and AGENTS index.
6. Run focused checks, typecheck, full test once source settles, Trellis validation, build, and archive/commit with scoped staging.
