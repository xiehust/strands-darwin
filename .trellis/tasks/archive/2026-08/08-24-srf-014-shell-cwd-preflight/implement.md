# Implementation plan — SRF-014 foreground shell cwd preflight

1. Extend the pinned SDK bash implementation and declarations with a configured foreground tool factory, per-session effective cwd capture, and the narrow non-mutating wrong-root preflight.
2. Instantiate that foreground tool from `AgentRuntime.create()` with `options.projectRoot`, then pass it through the existing background-mode wrapper without changing raw tool inputs.
3. Expand `spike/verify-background-bash.ts` to exercise the real Agent/tool seam for initial cwd, persisted `cd`, refusal/no-launch, correction text, pass-through shapes, exit/restart metadata, serialization, background isolation, hooks/permissions, and cleanup.
4. Update the SDK contract, error matrix, architecture rationale/index, and task artifacts to state the narrow shape and lifecycle invariants.
5. Run the focused suite, typecheck, one full `pnpm test`, `pnpm build`, Trellis validation/check/finish, journal update, archive, and commit all authorized work.
