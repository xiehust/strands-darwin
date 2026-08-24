# Design — SRF-014 foreground shell cwd preflight

## Boundary

The behavior belongs inside the vended foreground bash operation, where one per-Agent queue already serializes persistent-shell state. A Darwin-side `pwd`-then-execute wrapper would introduce a race between concurrent calls and would duplicate shell parsing. The pinned SDK patch will therefore expose a configured foreground bash factory; `AgentRuntime.create()` supplies its already-resolved `options.projectRoot`. The existing singleton remains available for SDK compatibility, while Darwin uses the configured instance.

## Cwd reporting

A configured bash session starts and restarts at the supplied session project root. The session remembers its effective cwd, initially that root, and appends a private `pwd -P` probe after each ordinary command inside the same queued shell write. The probe is delimited independently from stdout/stderr and removed before returning. Successful execute results add `cwd`; exit failures add the last effective `cwd`; exit-0 replacement results retain the pre-command cwd when the shell exits before the probe. Configured Darwin restart remains a string result and appends the reset cwd visibly; the unconfigured SDK singleton retains its exact legacy restart string for compatibility.

This keeps cwd observation in the same serialized operation as execution. It does not inspect Node's ambient `process.cwd()` in Darwin code, add a second public tool call, or alter permission/hook input.

## Conservative preflight

Preflight runs after the session's effective cwd is known and before the command is written to bash. It recognizes only two evidence-backed, single-simple-command shapes:

1. `cd <plain-relative-path>` with no options; or
2. a plain command-position relative path containing `/`, such as `./start.py` or `scripts/i18n_check.py`.

The whole command is rejected from preflight eligibility if it contains quotes, escapes, newlines, shell operators, redirections, substitutions, glob syntax, or other shell punctuation. Bare command names remain PATH-resolved and are never candidates; absolute paths and option tokens are excluded. Darwin does not tokenize or rewrite general shell syntax.

For an eligible candidate, lexical absolute paths are formed under the effective cwd and the session project root. Only when the cwd location is absent and the project-root location exists does the tool return a successful, non-mutating diagnostic result containing `cwd`, both candidate locations, and an actionable instruction to return to the project root or use the root location. The command is not written to the shell. Existing cwd-relative paths execute normally; paths absent in both places keep ordinary bash behavior.

## Compatibility and lifecycle

Background modes continue to bypass the foreground tool. The provider-facing schema, raw execute/restart input, interventions, hooks, timeout handling, per-Agent queues, exit metadata, replacement shell behavior, and runtime cleanup via restart remain unchanged except for the required cwd projection. `/clear` still gets a fresh Agent and fresh shell; configured restart resets cwd to the same verified project root.
