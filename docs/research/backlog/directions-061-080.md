# Darwin self-evolution backlog — priorities 061–080

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-043 — Add a config-gated terminal attention bell: one BEL when a permission prompt is published and one when a turn completes, emitted at the existing driver lifecycle points, never inside the Ink frame, off by default

- Status: `done`
- Priority: 61
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted 2026-08-28 in `94909b8` (task archive `e8376df`, journal `8c379cf`); Host acceptance recorded in `docs/iteration-log.md` Batch 65 (`verify-terminal-bell.ts` 14/14, `verify-config.ts` 248/248, `pnpm typecheck`, full `pnpm test` exit 0, `pnpm build`, grep proof that `terminal-bell.ts` is the sole BEL writer). Record repair 2026-08-30: the acceptance commit `6407864` said "SER-043 closes on independent Host acceptance" but only flipped SER-044 to `in-progress`, leaving this record's status line stale at `in-progress`; this run set it to `done` to match the recorded acceptance. Second record repair 2026-08-31: the 2026-08-30 repair commit `e5a8773` claimed to set `done` but actually wrote `not-started`; this run set the status line to `done` — the acceptance evidence above is unchanged and remains authoritative.

### Notes / blockers / abandonment reason

Darwin never signals the terminal today: a grep for BEL/OSC writes across `src/` is empty, so a permission prompt or a finished turn in an unfocused tab/pane is discovered only by looking. The exact moments are already first-class driver-owned events — `TurnComplete` (outcome/source) and `PermissionRequest` in `src/hooks/lifecycle-hooks.ts:8–18` — used today only to run external commands. Add one boolean config key (default **off**) following the established `src/config.ts` field pattern, and emit a single `\x07` to the real stdout at those two publication points in the interactive driver only: never per frame render, never inside an Ink row (BEL is a non-printing control byte, so ANSI-stripped pty assertions and `/export` byte-stability are untouched), never in headless drivers, and never a new information channel — no OSC title writes, no notification payload, no focus tracking. Off must be byte-identical to before the feature existed. Verify config parsing in `spike/verify-config.ts`, and add a pty check asserting exactly one BEL per permission publication and one per turn completion when enabled, zero when disabled; existing lifecycle and TUI suites stay green.

## SER-044 — Add bounded composer undo: Ctrl+_ restores the draft and cursor state destroyed by kill/word-delete chords from a small capped editor-owned snapshot stack, cleared on submit/queue/clear, never touching recall or search snapshots

- Status: `done`
- Priority: 62
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted in `a22d72d` (task archive `fc3351b`, journal `6e20949`; child session `session-20260828-144128660`; managed task `bg-aa391bed-8fe7-4443-bb8f-376022df838a`, succeeded, exit 0). Pure bounded primitives (`UNDO_CAP = 16`, `UndoStack`, `pushUndo`, `popUndo`) in `src/tui/prompt-editor.ts`; `App.tsx` owns the ref like `preferredColumn`, snapshots via `applyDestructive` only when a chord actually changes text (Ctrl+K/U, Ctrl+W/Alt+Backspace, Alt+D/Alt+Delete), pops on Ctrl+_ (legacy 0x1f byte and kitty ctrl chord, consumed even when empty), and clears at submit, queue take-back/return, recall acceptance, history-search accept, and rewind accept; search/recall snapshot-restore untouched. Host inspected the diff and independently passed `verify-prompt-editor.ts` 48/48, free pty `undo` 7/7, `cursor` 5/5, `multiline` 9/9, `wordNav` 11/11, `completion` 67/67, `recall` 22/22, `recallEmpty` 4/4, `queue` 17/17, `historySearch` 11/11, `pnpm typecheck`, `pnpm build`, `git diff --check`/`show --check`, clean tree, and AGENTS.md size 29,618 bytes < 32 KiB; the one full-`pnpm test` failure was the documented pre-existing `verify-subagent-heartbeats` timing flake, which passed 21/21 in isolation immediately after and also flaked at the pre-batch HEAD.

### Notes / blockers / abandonment reason

The kill chords Ctrl+K/Ctrl+U (`killToRowEdge`, `src/tui/App.tsx:1972–1980`) and Ctrl+W (`deleteWordBefore`, `src/tui/App.tsx:1982`) destroy draft text with no recovery — no undo primitive exists anywhere in `src/tui/` — while the codebase already trusts snapshot-restore for modal flows (`src/tui/prompt-history-search.ts` snapshots draft/cursor on Ctrl+R and restores on Escape). Add a small capped stack (e.g. 16) of `{text, cursor}` snapshots owned by the editor state: push before each destructive chord (kill/word-delete; optionally coalesced typing bursts, but destructive chords are the requirement), pop on Ctrl+_ (with the common Ctrl+- terminal alias) restoring text and cursor exactly. Clear the stack whenever the draft leaves the editor's ownership — submit, queue enqueue, queue take-back replacing the draft, recall/search acceptance, `/clear` — so undo can never resurrect a prompt that was already sent or recorded. Modal ownership is unchanged: permission, completion menu, compaction, history/rewind search keep their keys, and recall/search Escape restoration keeps its own snapshots. No persistence, no new frame row (an optional bounded transient notice may reuse an existing surface), no trajectory involvement. Verify with editor unit checks (destroy-then-undo identity, cap eviction, clear-on-submit/queue/clear) plus a free pty scenario: type, Ctrl+U, Ctrl+_ restores exactly; disabled paths byte-identical.
napshot-restore for modal flows (`src/tui/prompt-history-search.ts` snapshots draft/cursor on Ctrl+R and restores on Escape). Add a small capped stack (e.g. 16) of `{text, cursor}` snapshots owned by the editor state: push before each destructive chord (kill/word-delete; optionally coalesced typing bursts, but destructive chords are the requirement), pop on Ctrl+_ (with the common Ctrl+- terminal alias) restoring text and cursor exactly. Clear the stack whenever the draft leaves the editor's ownership — submit, queue enqueue, queue take-back replacing the draft, recall/search acceptance, `/clear` — so undo can never resurrect a prompt that was already sent or recorded. Modal ownership is unchanged: permission, completion menu, compaction, history/rewind search keep their keys, and recall/search Escape restoration keeps its own snapshots. No persistence, no new frame row (an optional bounded transient notice may reuse an existing surface), no trajectory involvement. Verify with editor unit checks (destroy-then-undo identity, cap eviction, clear-on-submit/queue/clear) plus a free pty scenario: type, Ctrl+U, Ctrl+_ restores exactly; disabled paths byte-identical.

## SER-045 — Add a parent-only `workflow` tool: a bounded declarative DAG of subagent tasks executed by the SDK `Graph` orchestrator, with each node built by the existing subagent child recipe and only bounded terminus reports returned to the parent

- Status: `done`
- Priority: 63
- Score: 9
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-30.md`](../research_2026-08-30.md) (run `08:21:38Z`, `sdk` path, `path-source: override (user-directed)`)

### Implementation / acceptance evidence

Accepted 2026-08-30 in `cbd2863` (task archive `94d63a9`, journal `109a956`; child session `session-20260830-083601272`; managed task `bg-ef70bc59-8467-4efb-8208-c606857695e0`, succeeded, exit 0). `src/agents/child-recipe.ts` extracts the shared child-construction recipe consumed by both `SubagentTool` (behavior unchanged) and the new parent-only `src/agents/workflow-tool.ts` (data-only DAG, `MAX_WORKFLOW_NODES = 8` / `MAX_WORKFLOW_EDGES = 28`, Kahn cycle refusal and bounded validation errors before any dispatch/model/child exists, SDK `Graph` execution with `maxSteps = nodeCount` and the parent cancel signal into `graph.invoke`, terminus-only result); registered in `runtime.ts` after the child-catalogue capture, classified `read` in `permission.ts` on the `subagent` precedent. Host independently passed `pnpm typecheck`, full `pnpm test` (exit 0), `spike/verify-workflow-tool.ts` in isolation (32/32), `pnpm build`, `git diff --check`/`git show --check`, and AGENTS.md 30,278 bytes < 32 KiB; details in `docs/iteration-log.md` Batch 67. Documented accepted deviation: no whole-graph `timeout` knob — bounded by node cap, `maxSteps`, and cancellation, matching every other delegation path.

### Notes / blockers / abandonment reason

User-directed: give darwin a Claude Code–style workflow capability (S3, `code.claude.com/docs/en/workflows.md`: orchestration held by an artifact, intermediate results flowing worker-to-worker) built on the Strands SDK `Graph` multi-agent pattern the repo does not use today (no SDK `multiagent/` import anywhere in `src/`). Shape: one new parent-only tool `workflow` whose input is **data, never code** — a bounded DAG `{ nodes: [{ id, agent?, task }], edges: [[source, target]] }` (cap nodes ≤ 8, validate unknown agent names, duplicate/unknown node ids, cycles, over-cap counts with bounded error strings). Execution is the SDK `Graph` (`node_modules/@strands-agents/sdk/dist/src/multiagent/graph.d.ts`): declarative `{nodes, edges}` constructor, AND-semantics dependency scheduling, dependency-merged node inputs (upstream final reports become downstream input without round-tripping through the parent context), bounded `maxConcurrency`, whole-graph `timeout`, and `MultiAgentInvokeOptions.cancelSignal` wired to the parent tool context's cancel signal. Each node is a fresh child built by the exact recipe `SubagentTool.run` uses today (`src/agents/subagent-tool.ts:140–222`: model snapshot, `composeSystemPrompt`, per-definition tool filtering, shared permission intervention with `source` provenance, dispatch-registry heartbeats + targeted `/agents cancel`, codex-hook fork, max-tokens recovery, bash-session reaping) — extract that recipe into a shared factory rather than duplicating it, with `SubagentTool` behavior unchanged. Only bounded terminus content (`_resolveContent`) returns as the tool result; child transcripts stay private; no trajectory record of child events (existing subagent invariant). The tool description must state the reads-parallel/writes-serialized rule: concurrent nodes share one working tree, so parallel branches are for reads and writes are serialized by edges. Parent-only like `update_plan` — never in child catalogues. Verify with a free stub-model suite `spike/verify-workflow-tool.ts` in `pnpm test`: validation refusals; diamond-DAG dependency order with upstream reports visible in downstream input; dispatch registration per node; bounded terminus-only result; cancellation aborting unstarted nodes; existing `verify-subagent-heartbeats.ts` green.

## SRF-019 — Stop trimming `memory_save` quote fields and make evidence rejection reasons specific

- Status: `done`
- Priority: 64
- Score: 15
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-08-31_session-20260831-011450426.md`](../../reflections/reflection_2026-08-31_session-20260831-011450426.md)

### Implementation / acceptance evidence

Accepted 2026-08-31 in `f6d750a` (task archive `e95a15d`; child session `session-20260831-031847766`; managed tasks `bg-789ac43e` transient-provider-failed, retry `bg-7dd4296b` succeeded, exit 0). `src/memory/tools.ts` adds `boundedUntrimmed(max)` (min-1 + code-point cap, no `.trim()`) applied only to `evidence.quote` (4000) and `userQuote` (500); `resolveExactSourceAnchor` returns `SourceAnchorResolution` with a closed six-reason failure set (`quote-not-one-line`/`unsafe-path`/`oversized-source`/`unreadable-source`/`no-matching-line`/`multiple-matching-lines`), safety checks order- and effect-identical; the controller maps each reason to its own message and the post-resolve `validateAnchor` re-check gets a distinct message. Host independently re-ran `verify-memory-validation.ts` 20/20, `verify-memory-tools.ts` 15/15, `pnpm typecheck`, full `pnpm test` (zero FAIL lines), `pnpm build`, plus a direct probe: the indented `src/memory/tools.ts` line 17 anchors `{ok:true, line:17}` while its trimmed variant and an absent line both return `{ok:false, failure:'no-matching-line'}`. Host acceptance recorded in `docs/iteration-log.md` Batch 68.

### Notes / blockers / abandonment reason

In session-20260831-011450426 (harbor project) the agent staged a `root_cause` memory with `evidence.quote` byte-identical to line 11 of `adapters/darwin-swe-bench/pyproject.toml` — verified in-session with `cat -A` (seq 351–352) — and was rejected twice with "memory evidence must be one unique exact current project line" (seq 343/345, 347/348), then spent ~2 minutes phantom-chasing and told the user a wrong hypothesis (seq 355). Root cause: `src/memory/tools.ts:10` applies `z.string().trim()` to every bounded field including `evidence.quote`, while `resolveExactSourceAnchor` (`src/memory/validation.ts`) requires the quote to equal a full source line — so the trim strips leading indentation and every indented project line (most code lines) can never validate. Reproduced both ways against the same dist code and file: untrimmed quote anchors and validates, trimmed quote resolves to no anchor. Fix inside the existing modules: give `evidence.quote` and `userQuote` a bounded-but-untrimmed schema (length/emptiness checks preserved, exact-line validation still gates every save, so nothing widens), and split the controller's single rejection message into reason-specific errors (no matching line vs. multiple matches vs. unreadable file) so an exact-evidence failure is diagnosable. Verify in `verify-memory-tools.ts`/`verify-memory-validation.ts`: an indented unique line saves and commits after `endTurn`; an unindented non-line quote still fails, now with the no-matching-line reason; multi-match and oversized/unsafe paths keep their existing refusals; `pnpm typecheck` and full `pnpm test` stay green.

## SER-046 — State the shipped composer word chords and undo in `/help` and the README input documentation, as a pure projection of fixed local facts

- Status: `done`
- Priority: 65
- Score: 14
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`research_2026-09-01.md`](../research_2026-09-01.md) (run `14:47:59Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted 2026-09-01 in `1d57aae` (child session `session-20260901-150906982`, managed task `bg-2e619bcc`, exit 0). `src/tui/help-format.ts` adds two fixed rows — `Alt/Ctrl+Left/Right or Alt+B/F moves by word · Alt+Backspace/Alt+D deletes the word before/after` and `Ctrl+_ (or Ctrl+-) undoes the last Ctrl+K/U, Ctrl+W or Alt word deletion in the draft` — and replaces the hand-picked `MAX_HELP_LINES = 40` with the derived `MAX_HELP_COMMANDS + HELP_FIXED_LINES` (24 + 21 = 45) so a growing command inventory can never slice a documented control away; `App.tsx` is untouched, so runtime behavior is unchanged. Both READMEs' input paragraphs and both `docs/user-guide/reference*.md` keyboard tables now name the same five chord families. Host independently re-ran `spike/verify-help-command.ts` (34/34, up from 27, including the new bound arithmetic assertions), `spike/verify-tui.ts completion` (68/68), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, and read the whole diff. Host acceptance recorded in `docs/iteration-log.md` Batch 69. Documented gap accepted: README↔`help-format.ts` consistency is proved by grep and by a spec obligation, not by the suite, because `verify-help-command.ts` is contractually I/O-free.

### Notes / blockers / abandonment reason

`/help` is Darwin's canonical bounded local discoverability surface, but its "editing and session:" block in `src/tui/help-format.ts` names only `Home/End or Ctrl+A/E`, `Ctrl+K/U`, `Ctrl+W`, `Ctrl+B`, `Ctrl+C` and `Ctrl+D`. Two shipped, spec-documented editing features are missing from it: SER-042's word chords — Alt/Ctrl+Arrow word jumps (`src/tui/App.tsx:2192`), Alt+B/F (`:2074`), Alt+D (`:2083`), Alt+Backspace (`:2243`) — and SER-044's composer undo on Ctrl+_ / Ctrl+- / byte 0x1f (`:2040`). `spike/verify-help-command.ts:55–56` pins exactly the stale subset, so the omission is invisible to the suite. `README.md:104` / `README.zh-CN.md:104` are the only `Ctrl+` mentions in either README and cover Ctrl+R alone; SER-030 already established that correcting stale README input documentation belongs to this surface. Fix strictly inside the existing projection: add the missing lines to `formatHelpReport()` (staying under `MAX_HELP_LINES` / `MAX_HELP_LINE_CODE_POINTS`, and re-checking the bound arithmetic rather than assuming headroom), and mirror the same chords in both READMEs' input sections. No new command, config key, runtime behavior, live-frame row or information channel; `/help` must remain argument-rejecting, handled before busy queueing, and free of model/tool/network work. Acceptance: extend `spike/verify-help-command.ts` to assert the word-chord and undo lines plus the unchanged bounds, keep `spike/verify-tui.ts completion` green, prove README wording names the same chords as `help-format.ts`, and keep `pnpm typecheck` plus the full `pnpm test` green.

## SER-047 — Extend the markdown answer projection's block vocabulary: classify list markers, blockquote prefixes and table pipes as dimmed marker spans, keeping every character

- Status: `done`
- Priority: 66
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-01.md`](../research_2026-09-01.md) (run `14:47:59Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted 2026-09-01 in `ff21afd` (child session `session-20260901-152613977`, managed task `bg-382e53bf`, exit 0). `src/tui/markdown.ts` extends `MarkdownLineKind` with `list | quote | table`, classified strictly *after* fence/code, heading and rule so `---`/`***`/`___` stays a rule and a bullet inside a fence stays code: `LIST_ITEM` requires a `-`/`*`/`+` or `N.`/`N)` marker followed by whitespace (so `-fast` and `*emphasis*` stay prose) and folds the leading indent into the one `marker` span, `QUOTE` marks the whole `>`/space run, and `TABLE_ROW` is deliberately conservative — a row must both start and end with `|`, so `rg x | wc -l` and `a | b` stay prose. `MarkdownText.tsx` needs no new `spanProps` branch (a `marker` span already dims) and extends the `liveRowText` inline rule via `INLINE_KINDS`, keeping the wrapped-row whole-tone fallback and the boolean `fenceOpenAfter`. Host independently re-ran `spike/verify-markdown.tsx` (129/129, up from 96 — including span round-trip, ANSI-strip byte identity and a `formatReplay` byte-identity case over a 17-line structured answer), `spike/verify-visual-language.tsx` (69/69), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, read the whole diff, and ran an own 25-case classification/round-trip probe: every case classified as expected (including `\t- tab` list, `>>x` quote, `|  |` table, `|only`/`x |` prose, `# > t` heading, `-----`/`   ---` rule) with zero round-trip failures and fenced content staying `code`. Host acceptance recorded in `docs/iteration-log.md` Batch 70. Dropped sub-case accepted and recorded in commit body, PRD and spec: any-pipe table detection, because it would dim ordinary shell pipelines.

### Notes / blockers / abandonment reason

`MarkdownLineKind` in `src/tui/markdown.ts:34` is `'text' | 'heading' | 'fence' | 'code' | 'rule'`, so every bullet, ordered-list item, blockquote and table row falls through to prose `inlineSpans` at `:88` — and `inlineSpans` deliberately keeps a bullet `* item` line plain (`:117–121`) to protect snake_case and multiplication from emphasis styling. The result is that structured answers, the common shape of Darwin's own output, render as undifferentiated prose while headings and code already carry tone. The extension point exists: add block kinds whose leading marker (`-`/`*`/`+`, `N.`/`N)`, `> `, and a table row's `|` separators) becomes a `marker` span and whose remaining text keeps ordinary inline spans, then give the new kinds tone in `spanProps`/`rowToneProps` in `src/tui/MarkdownText.tsx`. The projection contract is the hard constraint (`.trellis/spec/frontend/live-frame.md:428`): every character survives, markers are dimmed in place and never stripped or realigned, so ANSI-stripped output is byte-identical to the committed text, `/export` stays byte-identical, and pty substring assertions keep matching. Two ordering hazards to respect — the existing `RULE` classification of `---`/`***`/`___` must still win over a list marker, and the fence/code branch must still win over everything, so `fenceOpenAfter` stays a boolean and live rows keep agreeing with `<Static>`. Out of scope: reflowing or re-indenting list text, renumbering ordered lists, aligning table columns, and any per-language code highlighting (explicitly out of scope at `src/tui/markdown.ts:20`). Acceptance: `spike/verify-markdown.tsx` asserts the new classifications *and* that concatenated spans equal the input line for every case (including a bullet inside a fenced block, a `---` rule, and a `1.` item), `spike/verify-visual-language.tsx` green, an `/export` byte-identity check over an answer containing lists/quotes/tables, plus `pnpm typecheck` and the full `pnpm test` green.

## SER-048 — Add `--help`/`-h` and `--version`/`-V` to the CLI as bounded local output routed before any runtime import, and point every `CliUsageError` at `--help`

- Status: `not-started`
- Priority: 67
- Score: 14
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `02:29:40Z`, rolled `open` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

`parseCliArgs` (`src/cli-args.ts:201–202`) throws `CliUsageError('Unknown argument …')` for anything it does not know, so `darwin --help`, `darwin -h` and `darwin --version` all print `error: Unknown argument "--help"` and exit 2 — verified live on 2026-09-02 against both `pnpm tsx src/cli.ts` and `node dist/src/cli.js`. The canonical grammar exists only as the source comment at `src/cli.ts:5–12` and in `docs/user-guide/reference.md:6–24`; the version is already resolved for trajectory records by `DARWIN_VERSION` (`src/version.ts:33`). Requirement: `--help`/`-h` print the usage grammar (the same grammar the header comment states, kept in one exported constant so the comment, the flag and `reference.md` cannot drift) to stdout and exit 0; `--version`/`-V` print `darwin <DARWIN_VERSION>` and exit 0; both are routed like `sessions`/`trajectory` (`src/cli.ts:48–58`) — before argument parsing of the rest, before any runtime, config, model or Ink import, no file write, no network; every `CliUsageError` path keeps its exact message and exit 2 but its stderr line gains one bounded hint naming `darwin --help`. Combining `--help` with other flags is fine (help wins); `--version` likewise. Out of scope: a `help` subcommand, per-subcommand help pages, coloured output. Acceptance: `spike/verify-cli-args.ts` extended — `--help`, `-h`, `--version`, `-V` exit 0 with the expected stdout and empty stderr, the printed version equals `package.json`'s, unknown-flag cases still exit 2 with the original message plus the hint, and the help/version path imports no runtime/Ink module (an import-graph assertion in the style of `spike/verify-trajectory.ts`); `docs/user-guide/reference.md` (+ `reference.zh-CN.md`) document the flags; `pnpm typecheck` and the full `pnpm test` green.

## SER-049 — Refuse unknown keys in `~/.darwin/config.json` (root and `models` entries) with a `ConfigError` that names the key, where it was found and the nearest known key

- Status: `not-started`
- Priority: 68
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `02:29:40Z`, rolled `open` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

`validate` (`src/config.ts:593–608`) type-checks known keys and `validateModelChoices` (`:666–681`) refuses a *known* key found in the wrong half — the spec records why at `.trellis/spec/backend/error-handling.md:49`: "a key in the wrong half would silently do nothing". A key in *neither* list is never looked at: a private-`HOME` probe on 2026-09-02 with `{"thinkingEfort":"high"}` loaded successfully and kept the default effort, and the same holds for `promptCahce: false` (cache stays on and bills cache writes) or `permisionMode` (mode stays default). That is exactly the silent no-op the spec's own principle (`error-handling.md:30`, "Explicit intent must never be guessed or silently ignored") forbids. Requirement: after the existing misplaced-half checks, any root key outside `SESSION_KEYS ∪ MODEL_KEYS ∪ {'models'}` (`src/config.ts:283,305`) and any `models` entry key outside `MODEL_KEYS ∪ {'enable'}` (`:690`) raises `ConfigError` naming the file, the key, its location (root or `models[i]`/entry name) and — when one is within a small edit distance — the nearest known key as a "did you mean"; several unknown keys are reported in one message. Keep the misplaced-known-key messages exactly as they are (they are more specific). Out of scope: a comment/`$schema` escape hatch unless the child records a product reason for one; warning-instead-of-refusing (the table's config rows all refuse). Acceptance: `spike/verify-config.ts` gains cases for a misspelled root key, an unknown entry key, a stray `$schema`, two unknowns in one file, and a near-miss suggestion, and asserts every documented key in `docs/user-guide/configuration.md` still loads; `error-handling.md` gets the new table row; `configuration.md` (+ zh-CN) states the rule; `pnpm typecheck` and the full `pnpm test` green.

## SER-050 — Let `-p` read piped (non-TTY) stdin to EOF under a stated byte cap and append it to the one-shot prompt as one delimited block; TTY or empty stdin leaves behaviour byte-identical

- Status: `not-started`
- Priority: 69
- Score: 8
- Importance: 3
- Architecture fit: 3
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `02:29:40Z`, rolled `open` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

The headless path takes its prompt only from argv: `HeadlessOptions` (`src/headless-runner.ts:34`) carries `prompt: string`, both drivers send `options.prompt` alone (`:194`, `:206`), and `grep -n stdin src/cli.ts src/headless.ts src/headless-runner.ts` finds nothing — so `git diff | darwin -p "review this"` sends the sentence and silently drops the diff. Requirement: in `-p` mode only, when `process.stdin.isTTY` is falsy, read stdin to EOF under a stated byte cap and, if non-empty, append it to the prompt as one delimited block (the prompt text first, then the block, with a fixed heading naming it as piped input); TTY stdin, `/dev/null` and immediate EOF change nothing — the existing `spike/verify-headless.ts:388` (`stdio 'ignore'`) and the developer skill's managed children (`src/tools/background-bash.ts:351`, `stdio 'ignore'`) must run byte-identically. Over-cap input is either refused with a `CliUsageError`-style message or truncated with the omission stated in the block; the child picks one and records why. The composed text is what the trajectory `userInput` line records, under the existing `MAX_FIELD_CHARS` cap (`src/trajectory/record.ts:24`), and what structured headless output echoes — no second input channel or schema field. Interactive mode never reads stdin this way. Known risk to state in `docs/user-guide/reference.md`: a parent that keeps the pipe open without writing makes `-p` wait for EOF (the same as `cat`); the developer skill's background `start` launches are unaffected. Acceptance: `spike/verify-headless.ts` cases — piped text appears exactly once in the model-facing prompt and in the `userInput` record; `stdio 'ignore'` runs are byte-identical to today's expected output; over-cap behaviour matches the recorded choice; structured (`json`/`stream-json`) output unchanged apart from the composed prompt; `reference.md` (+ zh-CN) documents the semantics and the caveat; `pnpm typecheck` and the full `pnpm test` green.

## SER-051 — Accept optional focus text on `/compact <focus>`: build the compaction manager per call with the SDK default summarization prompt plus a bounded user focus, never altering unfocused output

- Status: `not-started`
- Priority: 70
- Score: 7
- Importance: 3
- Architecture fit: 3
- Evidence confidence: 4
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `02:29:40Z`, rolled `open` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

`/compact` refuses arguments outright (`src/tui/App.tsx:1423–1431`, notice `/compact takes no arguments`), and the runtime builds one process-lifetime `compactionManager` (`src/agent/runtime.ts:603–606`, `summaryRatio: 0.8`, no `summarizationSystemPrompt`) whose only consumer is `compact()` (`:1061`), so the user cannot tell the summarizer what the summary must keep for the task in hand. The SDK exposes the hook: `SummarizingConversationManagerConfig.summarizationSystemPrompt` (`node_modules/@strands-agents/sdk/dist/src/conversation-manager/summarizing-conversation-manager.d.ts:31–34`) — but it is constructor-only, and the default prompt `DEFAULT_SUMMARIZATION_PROMPT` is declared in `…/conversation-manager/compression/context-compression.d.ts:3` without a package-root re-export. Requirement: `/compact` with no text behaves exactly as today (same manager configuration, same summary message shape, `--compact-before` untouched); `/compact <focus>` passes a bounded (cap stated, e.g. a few hundred code points) focus into a per-call `SummarizingConversationManager` whose prompt is the SDK default prompt followed by one fixed section carrying the focus — never a copied prompt string that would drift from the SDK, so the child must reach `DEFAULT_SUMMARIZATION_PROMPT` through a public path (an SDK re-export, or one line in the pinned `patches/@strands-agents__sdk@1.12.0.patch`) and must halt on that premise if neither is acceptable. The reasoning-block scrub in `src/agent/compact.ts:95–104` must keep applying to focused summaries. `PreCompact`/`PostCompact` hook payloads stay `trigger: manual`; the trajectory records the `/compact …` line as it records `/compact` today. `help-format.ts` and `reference.md` state the argument. Acceptance: `spike/verify-compact.ts` extended — unfocused compaction produces the same summary message shape as before, focused compaction's summarizer request contains the default prompt verbatim plus the focus once, over-cap focus is refused with a notice and compaction does not run; `spike/verify-tui.ts compacting` green; `spike/verify-help-command.ts` and `spike/verify-tui.ts completion` green; `pnpm typecheck` and the full `pnpm test` green.
