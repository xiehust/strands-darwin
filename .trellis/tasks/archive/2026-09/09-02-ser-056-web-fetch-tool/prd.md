# SER-056: a parent-only `web_fetch` tool — bounded readable projection of a web page

## Goal

darwin's only HTTP tool is the SDK `httpRequest` singleton (`http_request`), whose callback
returns `await response.text()` unbounded: a documentation page arrives as hundreds of KB of raw
HTML, bounded only by the context offloader, and costs a second round to read. Add a **sibling**
tool `web_fetch({ url, maxChars? })` that GETs one page with content negotiation, converts HTML to
a bounded readable text projection, keeps markdown/plain text as is, and states every lossy step.
`http_request` stays byte-identical (never wrapped, called or special-cased);
`spike/verify-http-request-tool.ts` stays green unchanged.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-056 (Priority 76).

## Requirements

- R1. New module `src/tools/web-fetch.ts` built with the SDK `tool()` factory (like
  `image-viewer.ts` / `update-plan.ts`); input `{ url: string, maxChars?: number }`; GET only.
- R2. URL policy: `http://` is upgraded to `https://` before the request and the result states it;
  non-http(s) schemes and unparsable URLs are a bounded error before any request.
- R3. Request headers: `Accept: text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1` and a
  `User-Agent` naming darwin.
- R4. Redirects are handled by the module (`redirect: 'manual'`): same-host (`URL.host`, i.e.
  hostname and port) targets are followed up to a bounded hop count (each hop re-normalized, so an
  `http:` target is upgraded too); a different-host target is **not** followed — the result is
  successful, names the original URL and the redirect target, and carries an empty body.
- R5. Content handling: HTML (by content-type or, when no type is declared, by sniffing) becomes a
  dependency-free readable projection — `script`/`style`/`noscript`/`template`/`svg`/`nav`/
  `header`/`footer`/`aside` (and `head`, except its `title`) subtrees dropped; headings as
  `#`-prefixed lines; paragraphs/`br`/block elements as line breaks; `li` as `- ` lines;
  `blockquote` as `> `; `pre` fenced with ``` and its whitespace preserved; inline `code`
  backticked; links as `text (absolute url)`; images as `[image: alt]`; named (common set) and
  numeric entities decoded; whitespace runs and blank-line runs collapsed. Markdown/plain/any other
  text type is kept verbatim. Non-text (binary) bodies are a bounded error naming the content type
  and the length, never bytes.
- R6. Bounds: the returned body is capped at `WEB_FETCH_MAX_CHARS` (40 000 code points); `maxChars`
  may lower the cap but never raise it (over-ceiling values clamp). Truncation appends the shared
  notice `[truncated: N of M code points]` (`N` shown, `M` total), whose wording is one exported
  constant. The raw download stops at `WEB_FETCH_MAX_DOWNLOAD_BYTES` (4 MiB) and states it.
- R7. Result: a JSON-compatible object `{ url, status, contentType, body, notice }` where `url` is
  the final URL, and `notice` is an array of bounded statements (upgrade, redirect not followed,
  truncation, download cap, HTML projection lossiness, non-2xx status). The tool description states
  that the projection is lossy and that `http_request` returns the raw body.
- R8. Timeout/cancel: `AbortSignal.any([AbortSignal.timeout(...), context.cancelSignal])` inside
  the module, mirroring the SDK `http-request.js` pattern without importing or calling `httpRequest`.
- R9. Registration: parent tools list only, next to `httpRequest` in `src/agent/runtime.ts`; the
  child catalogue (`childTools`) excludes it through the existing name-filter mechanism, promoted to
  one named parent-only set. The same set lists `http_request`: AGENTS.md, the load-bearing doc and
  the spec matrix already state that children never receive it, but the filter never enforced it.
- R10. Permission: `classify('web_fetch', input)` goes through the existing unknown→`execute`
  fail-closed default (never `read`/`safe`); the default branch's `Input` detail already shows the
  URL, so no special case is added. `plan` denies before any request; default-mode denial makes no
  request; wildcard rules may allow it.
- R11. Docs: `docs/user-guide/reference.md` (+ `reference.zh-CN.md`) list the tool with bound and
  lossy statement; `.trellis/spec/backend/strands-sdk-contracts.md` gains a `web_fetch` contract
  next to the `http_request` one; `docs/architecture/load-bearing-decisions.md` gets a short
  section; AGENTS.md gets one table row only if the file stays under 32 KiB (32 412 B today).
- R12. No new dependency. Verification is offline (local `http.createServer` fixture) and in
  `pnpm test`.

## Acceptance Criteria

- [x] AC1. `spike/verify-web-fetch.ts`, listed in `spike/run-tests.ts`, proves (a)–(j) of the
  direction with a local fixture and no external network.
- [x] AC2. `spike/verify-http-request-tool.ts` passes and `git diff --stat` shows no change to it.
- [x] AC3. `pnpm typecheck` clean; full `pnpm test` exit 0 with zero FAIL lines.
- [x] AC4. Commits follow the repository convention; task archived; `git status --porcelain` clean.

## Evidence (2026-09-02)

- `pnpm tsx spike/verify-web-fetch.ts`: 73 passed, 0 failed (every checklist row below has a
  named assertion; the fixture listens on 127.0.0.1 only and the tool's `https` origin is
  rewritten to it by an injected `fetchImpl`, which is also what proves the upgrade end to end).
- `pnpm tsx spike/verify-http-request-tool.ts`: 7 passed, 0 failed; `git diff --stat --
  spike/verify-http-request-tool.ts package.json pnpm-lock.yaml` empty.
- `pnpm typecheck` clean; full `pnpm test` exit 0, zero `FAIL` lines, 84 suite summaries.
- AGENTS.md: 32,412 B → 32,578 B (< 32,768). A separate table row did not fit, so the existing
  "SDK HTTP request" row was extended by one clause naming `web_fetch`, `PARENT_ONLY_TOOL_NAMES`
  and `verify-web-fetch.ts`†; the full section lives in `load-bearing-decisions.md`.
- Found while implementing: `childTools` was `agent.tools.filter(name !== 'retrieve_offloaded_content')`,
  so `http_request` *was* in the child catalogue despite AGENTS.md, the load-bearing doc and the
  spec matrix all stating otherwise. The exclusion is now one `PARENT_ONLY_TOOL_NAMES` set naming
  `retrieve_offloaded_content`, `http_request`, `web_fetch`; the spec matrix row names the mechanism.

## Requirement-to-test checklist

| Requirement | Proof (all in `spike/verify-web-fetch.ts` unless stated) |
|---|---|
| R1 tool shape | `webFetch.name === 'web_fetch'`; schema rejects a missing `url` and a non-positive `maxChars` |
| R2 upgrade | `normalizeWebFetchUrl('http://…')` → `https://…`, `upgraded: true`; `https://` unchanged; `ftp://`, `file://`, `not a url` throw before any fetch (poisoned fetch counter stays 0); end-to-end: the injected fetch records a `https://` request URL for an `http://` input and the result carries the upgrade notice |
| R3 headers | fixture records request headers: exact `Accept` value; `User-Agent` contains `darwin` |
| R3/R5 markdown verbatim | fixture `text/markdown` body returned byte-identical, `contentType` starts with `text/markdown`, no projection notice |
| R5 HTML projection | fixture HTML page: `# Title`, `## Section`, `- item`, `text (https://…/abs)` link, fenced `pre`, decoded `&amp;`/`&#8212;`/`&nbsp;`, `script`/`style`/`nav` text absent, `[image: alt]`, `> quote`, backticked inline code, relative href made absolute; lossy notice present |
| R5 sniffed HTML | fixture with no content-type and `<!doctype html>` body is projected |
| R5 other text kept | `application/json` body returned verbatim |
| R5 binary | fixture `application/octet-stream` with `Content-Length` → thrown error names the type and the length and contains no body bytes |
| R6 truncation | body of 5 000 code points (multi-byte) with `maxChars: 1000` → body is exactly 1 000 code points + `[truncated: 1000 of 5000 code points]`; `maxChars: 10_000_000` on a 50 000-code-point body → `[truncated: 40000 of 50000 code points]`; a body under the cap has no truncation notice |
| R6 download cap | fixture streams > 4 MiB → notice states the download cap and the body does not exceed the cap |
| R4 same-host redirect | 302 → same host path followed, `url` is the final URL, `status` 200, body is the final page |
| R4 cross-host redirect | 302 → `https://other.invalid/…` not followed: `status` 302, `url` original, empty body, notice names both URLs; fetch count = 1 |
| R4 hop bound | a redirect loop ends with a bounded error after `WEB_FETCH_MAX_REDIRECTS` hops |
| R7 result fields | `Object.keys(result)` equal `url,status,contentType,body,notice`; non-2xx carries an `HTTP 404` notice and the body |
| R7 description | `webFetch.description` includes `lossy` and `http_request` |
| R8 cancel | a `cancelSignal` aborted while the fixture holds the response makes `invoke` reject with a cancellation message; the fixture request count is 1 |
| R9 parent registration | `runtimeAgent(runtime).tools` has exactly one `web_fetch` and it is the module export |
| R9 child exclusion | probe agent definitions with `tools: ["web_fetch"]` and `tools: ["http_request"]` under `<root>/.darwin/agents/` are reported in `runtime.info.agentProblems` as unknown tools; a `tools: ["bash"]` control loads into `agentNames` |
| R10 classification | `classify('web_fetch', { url })` → `kind: 'execute'`, details contain the URL; a fake model requesting `web_fetch` in default mode with a denying bridge → bridge sees `execute`/parent source, fetch count 0; in plan mode → bridge never asked, fetch count 0 |
| R11 docs | `rg -n web_fetch docs/user-guide/reference.md docs/user-guide/reference.zh-CN.md .trellis/spec/backend/strands-sdk-contracts.md docs/architecture/load-bearing-decisions.md`; `wc -c AGENTS.md` < 32768 |
| R12 no dependency / offline | `git diff --stat package.json pnpm-lock.yaml` empty (the `pnpm test` suite list lives in `spike/run-tests.ts`); suite uses `127.0.0.1` only |
| AC2 | `pnpm tsx spike/verify-http-request-tool.ts`; `git diff --stat -- spike/verify-http-request-tool.ts` empty |
| AC3 | `pnpm typecheck`; `pnpm test` |
| AC4 | `git log --oneline`, `task.py archive`, `git status --porcelain` |

## Constraints

- Mutations limited to: new `src/tools/web-fetch.ts`, `src/agent/runtime.ts` (registration +
  child exclusion), new `spike/verify-web-fetch.ts`, `spike/run-tests.ts` (the `pnpm test` suite
  list — `package.json`'s `test` script only points at it), `docs/user-guide/reference*.md`,
  `.trellis/spec/**`, `.trellis/tasks/**`, `.trellis/workspace/**`,
  `docs/architecture/load-bearing-decisions.md`, AGENTS.md (one row, size-permitting).
- Do not touch `docs/research/**`, `docs/iteration-log.md`, the SDK patch, or
  `spike/verify-http-request-tool.ts`. No new dependencies; no push; no history rewriting.
