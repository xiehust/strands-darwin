# SER-030 implementation plan

1. Add a pure bounded help formatter beside TUI report formatters. Derive every command row directly from `BUILTIN_COMMAND_NAMES` and `BUILTIN_COMMAND_DESCRIPTIONS`; keep interaction/key facts as a fixed bounded section.
2. Register `/help`, increase the completion cap, and dispatch exact `/help` plus whitespace-separated argument rejection before the busy guard.
3. Add a focused formatter suite to the fast test runner and extend the free pty completion scenario for idle/busy invocation and argument separators.
4. Correct README and append the help contract to the relevant frontend specs.
5. Run the focused formatter and pty checks while editing, then typecheck; after source settles run the applicable free pty scenarios and the complete project gate once.
