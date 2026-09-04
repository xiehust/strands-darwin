# Implementation plan

1. Narrow the single-object input refinement so only `list` rejects `command` among management
   modes; callbacks remain task-id-only.
2. Replace the old blanket rejection assertion with deterministic status/output/stop parity
   probes and retain the list rejection matrix.
3. Record the narrow compatibility rule in the existing background-bash SDK contract.
4. Run the focused suite, then typecheck, then the complete local test gate once source settles.
5. Run repository hygiene and Trellis validation, archive the task, and commit.
