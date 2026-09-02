# Permissions

**English** · [简体中文](permissions.zh-CN.md) · [Guide index](README.md)

## Modes

Set `permissionMode` in `~/.darwin/config.json`, use `--permission-mode <mode>` for one run, or use `--yolo` as shorthand. `/mode` changes live session state only: it never writes config, `/clear` inherits it, and in-flight prompts/classifier verdicts are withdrawn and reconsidered.

| Mode | Behavior |
|---|---|
| `default` | statically provable safe calls run; everything else prompts |
| `auto` | static safety first, then a cheap classifier; only calls it cannot clear prompt |
| `plan` | read-classified calls only; writes/executes denied before rules, classifier, prompts, or tool hooks |
| `yolo` | no prompts; the header warns |

Classification uses `(toolName, input)`, because one tool can read and write. Unknown tools, including MCP, fail closed as execute. Parent and child agents share the same intervention.

## Static safety

| Call | Statically safe? |
|---|---|
| `fileEditor view`, `load_skill`, bash lifecycle inspection/restart | yes |
| `fileEditor` writes inside project, except `.git/`, `.env*`, sensitive Darwin policy/config | yes in ordinary modes; denied in `plan` |
| bash whose every segment starts with an allowlisted read-only command (`git status/log/diff/show/branch`, `ls`, `cat`, `grep`, `rg`, `find`, …), with no redirection/substitution | yes |
| an allowlisted command carrying a known mutating option — `find` with `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`; `git branch` with `-d`/`-D`/`-m`/`-M`/`-c`/`-C`/`-u` (also inside combined flags such as `-Df`), `--delete`/`--move`/`--copy`/`--set-upstream-to[=…]`/`--unset-upstream`/`--edit-description`; `git log`/`diff`/`show` with `--output[=…]` | no — the prompt names the option |
| all other calls, including every MCP tool | no |

The allowlist is judged per segment: `git status && git branch -D main` prompts because of the second half. This is whitelist-only: parser uncertainty costs a prompt, never silent approval. `plan` allows reads, skill loading, job inspection, and delegation; denies file mutation, command-bearing bash, and unknown/MCP tools. It denies before `PreToolUse`, so a blocked operation cannot trigger project hook commands. Stored rules remain on disk but are ignored and stated as such.

Denying is not a tool error. The model receives a user-declined result and is instructed not to retry or work around it.

## Classifier-assisted `auto`

After static safety and explicit allow rules, `auto` sends unresolved calls to a low-cost model (Haiku by default, replaceable with `classifierModel`). Safe verdicts proceed; unsafe, timeout, thrown, or unparseable verdicts fall back to the user prompt with classifier reasoning. The classifier never auto-denies.

Switching modes withdraws an in-flight prompt or classifier verdict and re-decides from the top, bounded to prevent churn. Cancel denies pending prompts; runtime close latches the bridge shut.

## Permission prompts and diffs

A prompt identifies risk and source:

```text
permission required (execute — `curl` is not on the safe-command list)
[explorer#a1b2c3d4] bash: curl https://example.com
allow? y n always: a=curl * A=all bash esc=deny
```

`[parent]` means the main agent; `[agent#dispatch]` identifies a child. Permission prompts serialize even when read-heavy subagents run in parallel.

`fileEditor` prompts show a bounded line diff computed from the exact old/new input. Markers survive ANSI stripping and approving applies untruncated input. Because it does not reread disk, concurrent external changes can make the shown proposal differ from the eventual disk effect.

## Remembering an answer

- `y`: this call only.
- `n` or `Esc`: deny.
- `a`: approve and persist the narrow proposed rule.
- `A`: approve and persist a tool-wide rule.

Rules are project-scoped at `~/.darwin/projects/<project-key>/permission-rules.json`:

```json
{
  "allow": ["bash:pnpm *", "fileEditor:src/**"]
}
```

| Rule | Covers |
|---|---|
| `bash:pnpm *` | every chained segment must start with `pnpm` |
| `bash:pnpm typecheck *` | that command, optionally with args |
| `fileEditor:src/**` | writes under `src/`; `**` crosses `/`, `*` does not |
| `bash` | every bash call; tool-wide is the only MCP shape |

Rules are checked after static safety and before classifier. A written rule therefore also avoids a classifier call.

## Rule safety and revocation

A bash pattern must match every chained segment: `pnpm build && rm -rf /` does not match `bash:pnpm *`. Rules never match redirection or substitution. No rule can cover writes to `~/.darwin/config.json`, project permission files, active hook files/directories, or `.env*`; otherwise the agent could broaden its own authority. Calls already safe are offered no meaningless rule.

Nothing is remembered implicitly. `/permissions` lists live rules and whether each came from disk or this session. `/permissions revoke <n|rule|all>` synchronously removes it from the gate and file so the next matching call prompts and a restart cannot resurrect it. The command only narrows; new rules still come exclusively from permission prompts. Manual JSON edits work, but an invalid rule is a startup error.

## Headless behavior and local commands

Headless mode has no interactive bridge: unresolved calls are immediately denied, while static safety and persisted rules still apply. Choose `auto`/`yolo` explicitly if suitable.

`!<command>` is outside this gate because it is user-authored, not model-issued. It runs even in `plan`; see [Using darwin](using-darwin.md). The gate still protects any later command the model requests.
