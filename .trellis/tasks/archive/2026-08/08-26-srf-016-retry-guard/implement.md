# Implementation plan — SRF-016

1. Extend the existing pinned SDK bash patch narrowly so foreground execute results expose the command exit code already available inside the persistent shell; add the bounded retry-guard intervention state machine and exported constants/helpers needed for focused assertions.
2. Compose it into the existing tool hook/permission intervention while preserving the exact ordering contract; wire one shared guard at runtime assembly.
3. Add default prompt guidance without changing override loading.
4. Add a real-Agent offline suite covering equivalent/different failures, original results, body denial, reset, Agent isolation, Unicode/bounds, guidance, prompt replacement, bash-name coverage, and Pre/permission/Post ordering. Register it in the fast suite.
5. Run the focused suite while editing, then `pnpm typecheck`, full `pnpm test` once after source settles, and `pnpm build`.
6. Update the backend SDK contract, architecture rationale, and AGENTS.md load-bearing index; validate task artifacts and AGENTS.md size.
