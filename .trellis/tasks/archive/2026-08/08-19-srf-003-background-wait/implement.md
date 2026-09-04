# Implementation plan

1. Add the bounded wait result/type and manager operation without holding the task serialization queue during delay.
2. Extend the provider schema, description, dispatch, and permission classifier with read-safe `wait` semantics.
3. Add focused real-process and wrapper tests for output/state/timeout/cursor/cancel/shutdown/schema/permission behavior.
4. Run the focused suite during edits, then the complete typecheck/test/focused gate once source settles.
5. Update the background-bash SDK contract, error matrix, architecture/index wording as needed; validate Trellis artifacts and commit.
