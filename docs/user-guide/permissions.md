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
| a read whose target resolves into the sensitive set below — `fileEditor view`, or any non-option argument of `cat`/`head`/`tail`/`grep`/`rg`/`find`/`ls`/`wc` | no — the prompt names the path; asked in every mode including `plan`; no allow rule can cover it or is offered |
| `fileEditor` writes inside project, except `.git/`, `.env*`, sensitive Darwin policy/config | yes in ordinary modes; denied in `plan` |
| bash whose every segment starts with an allowlisted read-only command (`git status/log/diff/show/branch`, `ls`, `cat`, `grep`, `rg`, `find`, …), with no redirection/substitution | yes |
| an allowlisted command carrying a known mutating option — `find` with `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`; `git branch` with `-d`/`-D`/`-m`/`-M`/`-c`/`-C`/`-u` (also inside combined flags such as `-Df`), `--delete`/`--move`/`--copy`/`--set-upstream-to[=…]`/`--unset-upstream`/`--edit-description`; `git log`/`diff`/`show` with `--output[=…]` | no — the prompt names the option |
| all other calls, including every MCP tool | no |

The allowlist is judged per segment: `git status && git branch -D main` prompts because of the second half. This is whitelist-only: parser uncertainty costs a prompt, never silent approval. `plan` allows reads, skill loading, job inspection, and delegation; denies file mutation, command-bearing bash, and unknown/MCP tools. It denies before `PreToolUse`, so a blocked operation cannot trigger project hook commands. Stored rules remain on disk but are ignored and stated as such.

Denying is not a tool error. The model receives a user-declined result and is instructed not to retry or work around it.

### Sensitive-path reads

Reads are whitelisted too, but a fixed set of paths is never read silently: anything under `~/.ssh/`, `~/.aws/` or `~/.gnupg/` (the directory itself included), `~/.netrc`, `~/.kube/config`, `~/.docker/config.json`, `/etc/shadow`, any file named `.env` or `.env.*` anywhere, and Darwin's own config, hook and permission-rule files. Paths are resolved as the shell would (`~`, `~/`, `$HOME`, `${HOME}`, relative and absolute forms, `..` normalised), so `cat ~/.ssh/id_rsa`, `head $HOME/.aws/credentials` and `fileEditor view ../../.netrc` all prompt with `reads a sensitive path: <path>`. `plan` mode prompts for a sensitive `fileEditor view` rather than denying it, because the call is still a read (command-bearing bash stays plan-denied as before); `auto` never hands one to the classifier — it prompts directly; in headless runs the prompt is a `permission denied`. For `grep` and `rg` only, searching from an ancestor of a credential location (`grep -r AKIA ~`, `rg -uu secret /`, `grep -r k /etc`) counts as reading it and prompts with `reads a sensitive path: ~ (searches above ~/.ssh)`; `.env*` files are not part of that ancestor rule, so `grep -r foo .` stays silent in a project that has one. Everything else — `cat README.md`, `ls ~/.ssh/../`, `.envrc`, `/etc/os-release` — stays silent as before. `echo` is not treated as a reader: with redirection and substitution refused it can only print its arguments. The criterion is this fixed set, not "outside the project", because Darwin legitimately reads `/tmp`, `/etc/os-release` and global skill roots.

Beside the path set sits the environment: `echo $ANTHROPIC_API_KEY` and `cat /proc/self/environ` are read-only commands and run silently, but they cannot reveal darwin's own credentials, because the shells the model spawns never inherit credential-shaped variables in the first place — any name containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` is withheld from the persistent `bash` shell and from `bash start` jobs, for the parent and every subagent, with only `shellEnv.passthrough` in config able to restore a name (see [Shell environment](configuration.md#shell-environment)). This is not a permission decision and no rule or mode changes it; your own `!` commands, hooks and MCP servers keep your environment.

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

## Deny rules

The same file takes a second array, `deny`, in the same grammar. A deny rule is a prohibition you write down once: it holds in every mode — `yolo` included — for the main agent and for every subagent or workflow node, and it wins over any matching allow rule, whether configured or granted this session.

```json
{
  "allow": ["bash:pnpm *"],
  "deny": ["bash:git push --force*", "bash:*curl*", "fileEditor:dist/**", "http_request"]
}
```

Deny rules are judged before anything that could widen a call — before the plan guard, `yolo`, the static safe list, allow rules and the classifier — so a denied call never prompts, never reaches the classifier and never runs a `PreToolUse` hook. Matching is the conservative inverse of allow: a bash deny matches when **any** chained segment matches (`git status && git push --force` is denied by `bash:git push --force*`), redirection and substitution never exempt it (`echo $(git push --force)`, `git push --force > log` and `(git push --force)` are all denied — their bodies count as segments), and the allow-side exemptions do not apply, so `.env*` writes, `memory_save` and Darwin's own policy files can be denied like anything else. A file pattern covers every `fileEditor` call on the path, `view` included. A pattern is anchored at the start of a segment, so write `bash:*curl*` to catch `curl` anywhere in a segment.

The model receives one error naming the rule — `blocked by deny rule bash:git push --force*` — telling it not to retry or work around the call and to tell you instead. No prompt ever offers a deny rule and the session never grants one: the file is the only way a deny rule changes, and a new session picks the change up. An invalid entry is a startup error naming it, exactly as for `allow`.

## Rule safety and revocation

A bash pattern must match every chained segment: `pnpm build && rm -rf /` does not match `bash:pnpm *`. Rules never match redirection or substitution. No rule can cover writes to `~/.darwin/config.json`, project permission files, active hook files/directories, or `.env*`, nor reads into the sensitive-path set above; otherwise the agent could broaden its own authority. Calls already safe are offered no meaningless rule. (All of this is about allow rules; deny rules follow the inverse described above.)

Nothing is remembered implicitly. `/permissions` lists live allow rules and whether each came from disk or this session, then every deny rule as `deny (configured)`. `/permissions revoke <n|rule|all>` synchronously removes an allow rule from the gate and file so the next matching call prompts and a restart cannot resurrect it; it refuses to revoke a deny rule, because that would widen what runs — edit the file instead. The command only narrows; new rules still come exclusively from permission prompts (allow) or the file (deny). `/status` counts allow and deny rules separately. Manual JSON edits work, but an invalid rule is a startup error.

## Headless behavior and local commands

Headless mode has no interactive bridge: unresolved calls are immediately denied, while static safety and persisted rules still apply. Choose `auto`/`yolo` explicitly if suitable.

`!<command>` is outside this gate because it is user-authored, not model-issued. It runs even in `plan`; see [Using darwin](using-darwin.md). The gate still protects any later command the model requests.

## Audit trail

Every decision the gate settles is written to the session trajectory as one `permissionDecision` record (see [Sessions and state](sessions-and-state.md)): which stage settled it (`safe`, `allow-rule`, `classifier`, `yolo`, `user-approved`, `user-denied`, `deny-rule`, `plan-denied`, `write-scope-denied`, `restart-limit-denied`), the mode in force, whether you were prompted, the matched or granted rule, the child label when a subagent asked, and the call's `toolUseId` — never the tool input, which the call's own record already holds. It is log-only: the model, the tool result, the screen and headless output are unchanged, and there is no setting. `darwin trajectory replay` and `/export` print one `permission · <tool> · …` note only for a call that prompted you or was denied; silent approvals print nothing. Reading the record needs no model call.
