# Implementation plan — SER-031

1. Add project-memory paths, strict opt-in config, schema/projection/redaction/storage modules, and focused deterministic fixtures.
2. Add a detached coalescing scheduler at the recorder's post-durable turn boundary with bounded status/degradation probes.
3. Add bounded startup index loading and conservative prompt ordering/restore refresh; wire normal create/resume/clear factory paths.
4. Add existing-surface warning projections and focused runtime/prompt probes.
5. Run focused suite, typecheck, then one complete `pnpm test`; update backend specs, architecture rationale, AGENTS index, validate/archive/commit with scoped staging.
